#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { Command, CommanderError } from "commander";
import {
  agentPay,
  AgentPayError,
  candidateFromRequirements,
  confirmPayment,
  DEFAULT_MAX_AMOUNT,
  enforcePaymentPolicy,
  EXIT,
  inspectPaywall,
  parseAmount,
  parseHttpUrl,
  redact,
  resolveKey,
  type PaymentCandidate,
  type PaymentPolicy,
  type StellarNetwork,
} from "./index.js";

interface CommonFlags {
  method?: string; header?: string[]; data?: string; dataFile?: string;
  network?: string; maxAmount: string; allowAsset?: string[]; allowPayTo?: string[];
  rpcUrl?: string; timeout: string; maxRedirects: string; json?: boolean; key?: string; yes?: boolean;
}

interface Envelope {
  ok: boolean; command: "inspect" | "fetch"; url: string; status: number | null;
  paymentRequired: boolean; challenge: unknown | null; selected: PaymentCandidate | null;
  limit: { maxAmount: string; maxAmountBaseUnits: string; amountBaseUnits: string; withinLimit: boolean } | null;
  paid: boolean; signatureSent: boolean; payer: string | null; settlement: unknown | null;
  body: unknown; error: { code: string; message: string; details: Record<string, unknown> } | null;
}

const program = new Command().name("agent-pay-stellar")
  .description("Inspect and pay Stellar x402-gated URLs")
  .version("0.2.0")
  .exitOverride()
  .configureOutput({ writeErr: (value) => { if (!process.argv.includes("--json")) process.stderr.write(redact(value)); } });

addCommon(program.command("inspect <url>").description("Decode a 402 challenge without reading a key or signing"))
  .action((url: string, flags: CommonFlags) => runInspect(url, flags));
addCommon(program.command("fetch <url>").description("Complete the 402 -> pay -> unlock loop"))
  .option("--key <identity>", "file-backed stellar-cli identity name (not Secure Store), or S-key")
  .option("-y, --yes", "authorize payment without an interactive prompt")
  .action((url: string, flags: CommonFlags) => runFetch(url, flags));

function addCommon(command: Command): Command {
  return command
    .option("-X, --method <method>", "HTTP method", "GET")
    .option("-H, --header <header>", "request header, repeatable", collect, [])
    .option("-d, --data <body>", "request body")
    .option("--data-file <path>", "read request body from a file")
    .option("--network <network>", "stellar:testnet or stellar:pubnet")
    .option("--max-amount <amount>", `token amount cap; default ${DEFAULT_MAX_AMOUNT}`, DEFAULT_MAX_AMOUNT)
    .option("--allow-asset <contract>", "allowed asset contract, repeatable", collect, [])
    .option("--allow-pay-to <address>", "allowed recipient, repeatable", collect, [])
    .option("--rpc-url <url>", "Soroban RPC; required to pay on pubnet")
    .option("--timeout <ms>", "per-request timeout", "30000")
    .option("--max-redirects <count>", "same-origin redirect limit", "5")
    .option("--json", "emit one JSON envelope on stdout");
}

async function runInspect(urlValue: string, flags: CommonFlags): Promise<void> {
  const url = parseHttpUrl(urlValue).toString();
  const envelope = emptyEnvelope("inspect", url);
  try {
    const request = await requestOptions(flags);
    const result = await inspectPaywall(url, request.init, request.http);
    envelope.status = result.response.status;
    envelope.paymentRequired = result.response.status === 402;
    envelope.challenge = result.paymentRequired;
    envelope.selected = selectCandidate(result.candidates, flags.network);
    if (envelope.selected) {
      const maxBase = parseAmount(flags.maxAmount);
      envelope.limit = { maxAmount: flags.maxAmount, maxAmountBaseUnits: maxBase.toString(),
        amountBaseUnits: envelope.selected.amountBaseUnits,
        withinLimit: BigInt(envelope.selected.amountBaseUnits) <= maxBase };
      try { enforcePaymentPolicy(envelope.selected, policyOf(flags)); } catch { /* inspection reports the verdict */ }
    }
    envelope.body = await readBody(result.response);
    envelope.ok = true;
    render(envelope, flags.json === true);
  } catch (error) { fail(envelope, error, flags.json === true); }
}

async function runFetch(urlValue: string, flags: CommonFlags): Promise<void> {
  const url = parseHttpUrl(urlValue).toString();
  const envelope = emptyEnvelope("fetch", url);
  try {
    if (flags.network === "stellar:pubnet" && !flags.rpcUrl) {
      throw new AgentPayError("usage", "Pubnet payment requires --rpc-url", EXIT.USAGE);
    }
    const request = await requestOptions(flags);
    const key = await resolveKey(flags.key);
    envelope.payer = key.publicKey;
    if (key.fromCommandLine && !flags.json) {
      process.stderr.write("Warning: a secret on the command line may remain in shell history; prefer a Stellar identity.\n");
    }
    const result = await agentPay({
      url, key, ...request.init, ...request.http, policy: policyOf(flags), rpcUrl: flags.rpcUrl,
      onCandidate: (candidate, challenge) => {
        envelope.selected = candidate;
        envelope.challenge = challenge;
        envelope.paymentRequired = true;
        const maxBase = parseAmount(flags.maxAmount);
        envelope.limit = { maxAmount: flags.maxAmount, maxAmountBaseUnits: maxBase.toString(),
          amountBaseUnits: candidate.amountBaseUnits,
          withinLimit: BigInt(candidate.amountBaseUnits) <= maxBase };
      },
      authorize: async (candidate) => {
        envelope.selected = candidate;
        if (!flags.json) renderQuote(candidate, flags.maxAmount, key.publicKey);
        await confirmPayment(`Pay ${candidate.amount} ${candidate.assetSymbol} to ${candidate.payTo}?`, flags.yes === true);
      },
    });
    envelope.status = result.response.status;
    envelope.paymentRequired = result.paymentRequired !== null;
    envelope.challenge = result.paymentRequired;
    envelope.selected = result.selected;
    envelope.signatureSent = result.signatureSent;
    envelope.settlement = result.settlement;
    envelope.paid = result.paid;
    envelope.body = await readBody(result.response);
    if (result.response.status === 402 && result.signatureSent) {
      throw new AgentPayError("still_locked", "Payment was sent but the resource stayed locked", EXIT.STILL_LOCKED);
    }
    const settled = result.settlement as { success?: boolean; errorReason?: string } | null;
    if (settled && settled.success === false) {
      throw new AgentPayError("settle_failed", settled.errorReason ?? "Settlement failed", EXIT.SETTLE_FAILED);
    }
    if (!result.response.ok) throw new AgentPayError("http_error", `HTTP ${result.response.status}`);
    envelope.ok = true;
    render(envelope, flags.json === true);
  } catch (error) { fail(envelope, error, flags.json === true); }
}

function policyOf(flags: CommonFlags): PaymentPolicy {
  return { network: parseNetwork(flags.network), maxAmount: flags.maxAmount,
    allowedAssets: flags.allowAsset, allowedPayTo: flags.allowPayTo };
}

async function requestOptions(flags: CommonFlags) {
  const method = String(flags.method ?? "GET").toUpperCase();
  if (!/^[A-Z]+$/.test(method)) throw new AgentPayError("usage", "Invalid HTTP method", EXIT.USAGE);
  const body = flags.dataFile ? await readFile(flags.dataFile, "utf8") : flags.data;
  if (body !== undefined && (method === "GET" || method === "HEAD")) {
    throw new AgentPayError("usage", `${method} cannot carry --data`, EXIT.USAGE);
  }
  return { init: { method, headers: parseHeaders(flags.header), body },
    http: { timeoutMs: integer(flags.timeout, "--timeout"), maxRedirects: integer(flags.maxRedirects, "--max-redirects") } };
}

function render(envelope: Envelope, json: boolean): void {
  if (json) process.stdout.write(redact(JSON.stringify(envelope)) + "\n");
  else if (envelope.body !== null) process.stdout.write(typeof envelope.body === "string" ? envelope.body : JSON.stringify(envelope.body, null, 2));
}

function fail(envelope: Envelope, error: unknown, json: boolean): never {
  const value = error instanceof AgentPayError
    ? error
    : error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")
      ? new AgentPayError("http_error", `Request timed out: ${error.message}`)
      : new AgentPayError("internal", error instanceof Error ? error.message : String(error));
  envelope.error = { code: value.code, message: redact(value.message), details: value.details };
  if (json) process.stdout.write(redact(JSON.stringify(envelope)) + "\n");
  else process.stderr.write(`agent-pay-stellar: ${redact(value.message)}\n`);
  process.exitCode = value.exitCode;
  throw new SilentExit();
}

class SilentExit extends Error {}
function emptyEnvelope(command: Envelope["command"], url: string): Envelope {
  return { ok: false, command, url, status: null, paymentRequired: false, challenge: null,
    selected: null, limit: null, paid: false, signatureSent: false, payer: null, settlement: null, body: null, error: null };
}
function collect(value: string, previous: string[]): string[] { return [...previous, value]; }
function parseNetwork(value?: string): StellarNetwork | undefined {
  if (value === undefined) return undefined;
  if (value !== "stellar:testnet" && value !== "stellar:pubnet") throw new AgentPayError("usage", "Invalid --network", EXIT.USAGE);
  return value;
}
function integer(value: string, name: string): number {
  if (!/^\d+$/.test(value)) throw new AgentPayError("usage", `${name} must be a non-negative integer`, EXIT.USAGE);
  return Number(value);
}
function parseHeaders(values?: string[]): Headers {
  const headers = new Headers();
  for (const value of values ?? []) { const index = value.indexOf(":");
    if (index < 1) throw new AgentPayError("usage", `Invalid header ${value}`, EXIT.USAGE);
    headers.append(value.slice(0, index).trim(), value.slice(index + 1).trim()); }
  return headers;
}
function selectCandidate(candidates: PaymentCandidate[], network?: string): PaymentCandidate | null {
  return candidates.find((candidate) => network ? candidate.network === network : candidate.network !== "stellar:pubnet") ?? null;
}
async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  if (response.headers.get("content-type")?.includes("json")) { try { return JSON.parse(text); } catch { /* raw */ } }
  return text;
}
function renderQuote(candidate: PaymentCandidate, cap: string, payer: string): void {
  process.stderr.write(`402 Payment Required\n  amount    ${candidate.amount} ${candidate.assetSymbol} (${candidate.amountBaseUnits} base units)\n  asset     ${candidate.asset}\n  network   ${candidate.network}\n  payTo     ${candidate.payTo}\n  cap       ${cap}\n  payer     ${payer}\n`);
  if (candidate.declaredDecimals !== null && candidate.declaredDecimals !== 7) {
    process.stderr.write(`  WARNING   server declared ${candidate.declaredDecimals} decimals; ignored, Stellar uses 7\n`);
  }
}

program.parseAsync().catch((error: unknown) => {
  if (
    error instanceof SilentExit ||
    error instanceof CommanderError &&
      (error.code === "commander.helpDisplayed" || error.code === "commander.version")
  ) return;
  const json = process.argv.includes("--json");
  const value = error instanceof AgentPayError ? error : new AgentPayError("usage", error instanceof Error ? error.message : String(error), EXIT.USAGE);
  const envelope = emptyEnvelope(process.argv.includes("fetch") ? "fetch" : "inspect", "");
  envelope.error = { code: value.code, message: redact(value.message), details: value.details };
  if (json) process.stdout.write(JSON.stringify(envelope) + "\n");
  else process.stderr.write(`agent-pay-stellar: ${redact(value.message)}\n`);
  process.exitCode = value.exitCode;
});

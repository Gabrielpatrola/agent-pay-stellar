import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Keypair } from "@stellar/stellar-sdk";
import { encodePaymentRequiredHeader } from "@x402/core/http";
import { afterEach, describe, expect, it } from "vitest";

const servers: Server[] = [];
const asset = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";

type Handler = (request: IncomingMessage, response: ServerResponse) => void;

async function server(handler: Handler) {
  const value = createServer(handler); servers.push(value);
  await new Promise<void>((resolve) => value.listen(0, "127.0.0.1", resolve));
  const address = value.address() as { port: number };
  return `http://127.0.0.1:${address.port}`;
}

interface ChallengeOptions { amount?: string; network?: string; asset?: string; payTo?: string; extra?: Record<string, unknown> }

function challenge(url: string, options: ChallengeOptions = {}) {
  return encodePaymentRequiredHeader({ x402Version: 2, error: "Payment required",
    resource: { url, description: "test", mimeType: "application/json" },
    accepts: [{ scheme: "exact", network: (options.network ?? "stellar:testnet") as `${string}:${string}`,
      asset: options.asset ?? asset, amount: options.amount ?? "100000", payTo: options.payTo ?? Keypair.random().publicKey(),
      maxTimeoutSeconds: 300, extra: { areFeesSponsored: true, ...(options.extra ?? {}) } }] });
}

async function paywall(options: ChallengeOptions | string = {}) {
  const config = typeof options === "string" ? { amount: options } : options;
  let base = ""; const requests: Array<Record<string, string | string[] | undefined>> = [];
  base = await server((request, response) => {
    requests.push(request.headers);
    response.writeHead(402, { "content-type": "application/json",
      "payment-required": challenge(`${base}${request.url}`, config) });
    response.end('{"error":"payment_required"}');
  });
  return { base, requests };
}

function cli(args: string[], env: NodeJS.ProcessEnv = {}) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["dist/cli.js", ...args], {
      cwd: new URL("..", import.meta.url), env: { ...process.env, AGENT_PAY_STELLAR_SECRET: "", STELLAR_PRIVATE_KEY: "", STELLAR_SECRET_KEY: "", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (data) => { stdout += data; });
    child.stderr.on("data", (data) => { stderr += data; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });
}

afterEach(async () => { await Promise.all(servers.splice(0).map((value) => new Promise<void>((resolve) => value.close(() => resolve())))); });

describe("CLI agent contract", () => {
  it("help and version exit cleanly", async () => {
    const help = await cli(["--help"]);
    const version = await cli(["--version"]);
    expect(help.code).toBe(0); expect(help.stdout).toContain("inspect");
    expect(version.code).toBe(0); expect(version.stdout.trim()).toBe("0.2.0");
    expect(version.stderr).toBe("");
  });

  it("inspects a challenge without a key and emits one JSON envelope", async () => {
    const { base } = await paywall();
    const result = await cli(["inspect", `${base}/paid`, "--json"]);
    expect(result.code).toBe(0); expect(result.stderr).toBe("");
    const body = JSON.parse(result.stdout);
    expect(body).toMatchObject({ ok: true, command: "inspect", status: 402, paymentRequired: true, paid: false });
    expect(body.selected.amount).toBe("0.01");
    expect(body.limit.withinLimit).toBe(true);
  });

  it("reports an over-cap inspection as data", async () => {
    const { base } = await paywall("50000000");
    const result = await cli(["inspect", `${base}/paid`, "--max-amount", "0.01", "--json"]);
    expect(result.code).toBe(0); expect(JSON.parse(result.stdout).limit.withinLimit).toBe(false);
  });

  it("refuses over-cap before a payment header is sent", async () => {
    const source = await paywall("50000000"); const seed = Keypair.random().secret();
    const result = await cli(["fetch", `${source.base}/paid`, "--max-amount", "0.01", "--yes", "--json"], { AGENT_PAY_STELLAR_SECRET: seed });
    expect(result.code).toBe(3);
    expect(JSON.parse(result.stdout).error.code).toBe("over_max_amount");
    expect(source.requests).toHaveLength(1);
    expect(source.requests[0]?.["payment-signature"]).toBeUndefined();
    expect(result.stdout + result.stderr).not.toContain(seed);
  });

  it("refuses unattended payment without --yes", async () => {
    const source = await paywall();
    const result = await cli(["fetch", `${source.base}/paid`, "--json"], { AGENT_PAY_STELLAR_SECRET: Keypair.random().secret() });
    expect(result.code).toBe(4); expect(JSON.parse(result.stdout).error.code).toBe("no_tty");
    expect(source.requests).toHaveLength(1);
  });

  it("refuses mainnet unless explicitly selected", async () => {
    const source = await paywall({ network: "stellar:pubnet" });
    const result = await cli(["fetch", `${source.base}/paid`, "--yes", "--json"], { AGENT_PAY_STELLAR_SECRET: Keypair.random().secret() });
    expect(result.code).toBe(4); expect(JSON.parse(result.stdout).error.code).toBe("unsupported_network");
  });

  it("emits JSON for usage failures", async () => {
    const result = await cli(["inspect", "not-a-url", "--json"]);
    expect(result.code).toBe(2); expect(() => JSON.parse(result.stdout)).not.toThrow();
  });

  it("reports a malformed 402 as a typed challenge error", async () => {
    const source = await server((_request, response) => { response.writeHead(402); response.end("pay somehow"); });
    const result = await cli(["inspect", `${source}/paid`, "--json"]);
    expect(result.code).toBe(1); expect(JSON.parse(result.stdout).error.code).toBe("bad_challenge");
  });

  it("returns a free resource without touching a key", async () => {
    const source = await server((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" }); response.end('{"free":true}');
    });
    const result = await cli(["inspect", `${source}/free`, "--json"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, paymentRequired: false, payer: null, body: { free: true } });
  });

  it("refuses a cross-origin redirect", async () => {
    const target = await server((_request, response) => response.end("should not reach"));
    const source = await server((_request, response) => { response.writeHead(302, { location: `${target}/x` }); response.end(); });
    const result = await cli(["inspect", `${source}/paid`, "--json"]);
    expect(result.code).toBe(7); expect(JSON.parse(result.stdout).error.code).toBe("unsafe_redirect");
  });

  it("follows a same-origin redirect within the configured limit", async () => {
    let source = "";
    source = await server((request, response) => {
      if (request.url === "/moved") { response.writeHead(302, { location: "/paid" }); response.end(); return; }
      response.writeHead(402, { "payment-required": challenge(`${source}/paid`) }); response.end("{}");
    });
    const result = await cli(["inspect", `${source}/moved`, "--json"]);
    expect(result.code).toBe(0); expect(JSON.parse(result.stdout).selected.amount).toBe("0.01");
  });

  it("enforces asset and recipient allowlists before signing", async () => {
    const recipient = Keypair.random().publicKey();
    const source = await paywall({ payTo: recipient });
    const seed = Keypair.random().secret();
    const badAsset = await cli(["fetch", `${source.base}/paid`, "--yes", "--allow-asset", `C${"A".repeat(55)}`, "--json"], { AGENT_PAY_STELLAR_SECRET: seed });
    expect(badAsset.code).toBe(1); expect(JSON.parse(badAsset.stdout).error.code).toBe("no_payable_option");
    const badRecipient = await cli(["fetch", `${source.base}/paid`, "--yes", "--allow-pay-to", Keypair.random().publicKey(), "--json"], { AGENT_PAY_STELLAR_SECRET: seed });
    expect(badRecipient.code).toBe(1); expect(JSON.parse(badRecipient.stdout).error.code).toBe("no_payable_option");
    expect(source.requests.every((headers) => headers["payment-signature"] === undefined)).toBe(true);
  });

  it("ignores a hostile decimals declaration when applying the default cap", async () => {
    const source = await paywall({ amount: "10000000000", extra: { decimals: 10, symbol: "USDC" } });
    const result = await cli(["fetch", `${source.base}/paid`, "--yes", "--json"], { AGENT_PAY_STELLAR_SECRET: Keypair.random().secret() });
    const body = JSON.parse(result.stdout);
    expect(result.code).toBe(3); expect(body.selected.amount).toBe("1000");
    expect(body.selected.declaredDecimals).toBe(10); expect(body.limit.withinLimit).toBe(false);
  });

  it("keeps the JSON envelope shape stable on refusal", async () => {
    const source = await paywall("50000000");
    const result = await cli(["fetch", `${source.base}/paid`, "--yes", "--json"], { AGENT_PAY_STELLAR_SECRET: Keypair.random().secret() });
    const body = JSON.parse(result.stdout);
    for (const key of ["ok", "command", "url", "status", "paymentRequired", "challenge", "selected", "limit",
      "paid", "signatureSent", "payer", "settlement", "body", "error"]) expect(body).toHaveProperty(key);
  });

  it("rejects request bodies on GET before making a request", async () => {
    const source = await paywall();
    const result = await cli(["inspect", `${source.base}/paid`, "--data", "hello", "--json"]);
    expect(result.code).toBe(2); expect(source.requests).toHaveLength(0);
  });

  it("times out stalled resources", async () => {
    const source = await server((_request, response) => { setTimeout(() => response.end("late"), 100); });
    const result = await cli(["inspect", `${source}/slow`, "--timeout", "10", "--json"]);
    expect(result.code).toBe(1); expect(JSON.parse(result.stdout).error.code).toBe("http_error");
  });
});

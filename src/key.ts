import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Keypair } from "@stellar/stellar-sdk";
import { AgentPayError, EXIT } from "./errors.js";
import { redact, Secret } from "./secret.js";

const run = promisify(execFile);
export const KEY_ENV_VARS = ["AGENT_PAY_STELLAR_SECRET", "STELLAR_PRIVATE_KEY", "STELLAR_SECRET_KEY"] as const;

export interface ResolvedKey {
  secret: Secret;
  publicKey: string;
  source: string;
  fromCommandLine: boolean;
}

function wrap(value: string, source: string, fromCommandLine: boolean): ResolvedKey {
  const seed = value.trim();
  try {
    return { secret: new Secret(seed, source), publicKey: Keypair.fromSecret(seed).publicKey(), source, fromCommandLine };
  } catch {
    throw new AgentPayError("bad_key", `${source} is not a valid Stellar secret seed`);
  }
}

export async function keyFromStellarCli(name: string): Promise<ResolvedKey> {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) throw new AgentPayError("bad_key", "Invalid Stellar identity name");
  try {
    const { stdout } = await run("stellar", ["keys", "secret", name], { timeout: 15_000, maxBuffer: 65_536 });
    return wrap(stdout.trim().split("\n").at(-1) ?? "", `stellar-cli identity "${name}"`, false);
  } catch (error) {
    const value = error as { code?: string; stderr?: string; message?: string };
    const detail = redact(String(value.stderr ?? value.message ?? "")).trim().split("\n")[0] ?? "";
    if (detail.includes("Secure Store does not reveal secret key")) {
      throw new AgentPayError(
        "bad_key",
        `Stellar identity "${name}" is stored in Secure Store, which cannot export the raw secret ` +
          "required by the x402 signer. Create a dedicated identity without --secure-store, or set " +
          "AGENT_PAY_STELLAR_SECRET to a dedicated low-balance payer key.",
      );
    }
    throw new AgentPayError("bad_key", value.code === "ENOENT"
      ? "The stellar CLI is not installed; use a secret environment variable"
      : `Could not read Stellar identity "${name}"${detail ? `: ${detail}` : ""}`);
  }
}

export async function resolveKey(key?: string, env: NodeJS.ProcessEnv = process.env): Promise<ResolvedKey> {
  if (key?.trim()) {
    const value = key.trim();
    return value.startsWith("S") ? wrap(value, "--key", true) : keyFromStellarCli(value);
  }
  for (const name of KEY_ENV_VARS) if (env[name]?.trim()) return wrap(env[name]!, `$${name}`, false);
  throw new AgentPayError("no_key", "No signing key; use --key <stellar-cli identity> or AGENT_PAY_STELLAR_SECRET", EXIT.USAGE);
}

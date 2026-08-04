import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import {
  AgentPayError, Secret, assetLabel, candidateFromRequirements, createSafeFetch,
  enforcePaymentPolicy, formatAmount, parseAmount, redact,
  resolveKey,
} from "../src/index.js";

const asset = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const payTo = Keypair.random().publicKey();
const candidate = candidateFromRequirements({
  scheme: "exact", network: "stellar:testnet", amount: "100000", asset, payTo,
  maxTimeoutSeconds: 300, extra: { decimals: 10, symbol: "FAKE" },
});

describe("amounts and hostile metadata", () => {
  it("converts decimal amounts exactly", () => {
    expect(parseAmount("0.01")).toBe(100000n);
    expect(parseAmount("100_000u")).toBe(100000n);
    expect(formatAmount("100000")).toBe("0.01");
  });

  it.each(["", "-1", "1.00000001", "NaN", "1e3"])("rejects invalid amount %j", (value) => {
    expect(() => parseAmount(value)).toThrow(AgentPayError);
  });

  it("accepts the exact seven-decimal boundary", () => {
    expect(parseAmount("0.0000001")).toBe(1n);
    expect(formatAmount(1n)).toBe("0.0000001");
  });

  it("uses Stellar's seven decimals and address-derived asset labels", () => {
    expect(candidate.amount).toBe("0.01");
    expect(candidate.declaredDecimals).toBe(10);
    expect(candidate.assetSymbol).toBe("USDC");
    expect(candidate.assetSymbolVerified).toBe(true);
    expect(assetLabel(`C${"A".repeat(55)}`).verified).toBe(false);
  });
});

describe("payment policy", () => {
  it("has a finite default cap", () => {
    const expensive = { ...candidate, amountBaseUnits: "10000001", amount: "1.0000001" };
    expect(() => enforcePaymentPolicy(expensive, {})).toThrow(AgentPayError);
  });

  it("enforces amount, network, asset, and recipient boundaries", () => {
    expect(() => enforcePaymentPolicy(candidate, {
      network: "stellar:testnet", maxAmount: "0.01", allowedAssets: [asset], allowedPayTo: [payTo],
    })).not.toThrow();
    expect(() => enforcePaymentPolicy(candidate, { maxAmount: "0.0099999" })).toThrow("exceeds");
    expect(() => enforcePaymentPolicy(candidate, { network: "stellar:pubnet" })).toThrow("network");
    expect(() => enforcePaymentPolicy(candidate, { allowedAssets: [`C${"A".repeat(55)}`] })).toThrow("not allowed");
    expect(() => enforcePaymentPolicy(candidate, { allowedPayTo: [Keypair.random().publicKey()] })).toThrow("not allowed");
  });

  it("requires explicit mainnet selection", () => {
    expect(() => enforcePaymentPolicy({ ...candidate, network: "stellar:pubnet" }, {})).toThrow("Mainnet");
  });

  it("rejects malformed and unsupported requirements", () => {
    expect(() => candidateFromRequirements({ scheme: "upto", network: "stellar:testnet" })).toThrow("exact");
    expect(() => candidateFromRequirements({ scheme: "exact", network: "eip155:1" })).toThrow("Unsupported");
    expect(() => candidateFromRequirements({ scheme: "exact", network: "stellar:testnet", amount: "1.5", asset, payTo })).toThrow("Invalid");
  });
});

describe("secrets", () => {
  it("cannot stringify or leak a Stellar seed", () => {
    const seed = Keypair.random().secret();
    const secret = new Secret(seed, "test");
    expect(String(secret)).toBe("[redacted]");
    expect(JSON.stringify(secret)).not.toContain(seed);
    expect(redact(`failure: ${seed}`)).not.toContain(seed);
  });

  it("resolves the preferred environment variable without exposing it", async () => {
    const seed = Keypair.random().secret();
    const key = await resolveKey(undefined, { AGENT_PAY_STELLAR_SECRET: seed });
    expect(key.publicKey).toBe(Keypair.fromSecret(seed).publicKey());
    expect(JSON.stringify(key.secret)).not.toContain(seed);
  });

  it("rejects missing and invalid environment keys", async () => {
    await expect(resolveKey(undefined, {})).rejects.toMatchObject({ code: "no_key", exitCode: 2 });
    await expect(resolveKey(undefined, { AGENT_PAY_STELLAR_SECRET: "SNOTVALID" })).rejects.toMatchObject({ code: "bad_key" });
  });
});

describe("safe fetch", () => {
  it("rejects cross-origin redirects", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response(null, { status: 302, headers: { location: "https://evil.example/x" } })) as typeof fetch;
    try { await expect(createSafeFetch()("https://good.example/x")).rejects.toMatchObject({ code: "unsafe_redirect" }); }
    finally { globalThis.fetch = original; }
  });

  it("enforces the same-origin redirect limit", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async (input) => new Response(null, { status: 302, headers: { location: String(input) } })) as typeof fetch;
    try { await expect(createSafeFetch({ maxRedirects: 1 })("https://good.example/x")).rejects.toThrow("Too many redirects"); }
    finally { globalThis.fetch = original; }
  });

  it("converts POST to GET after a 303 and removes body headers", async () => {
    const original = globalThis.fetch;
    const calls: Array<{ method?: string; contentType: string | null; body: unknown }> = [];
    globalThis.fetch = (async (_input, init) => {
      calls.push({ method: init?.method, contentType: new Headers(init?.headers).get("content-type"), body: init?.body });
      return calls.length === 1
        ? new Response(null, { status: 303, headers: { location: "/done" } })
        : new Response("ok", { status: 200 });
    }) as typeof fetch;
    try {
      await createSafeFetch()("https://good.example/start", { method: "POST", headers: { "content-type": "text/plain" }, body: "hello" });
      expect(calls[1]).toMatchObject({ method: "GET", contentType: null, body: undefined });
    } finally { globalThis.fetch = original; }
  });
});

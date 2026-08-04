import { AgentPayError, EXIT } from "./errors.js";

export const STELLAR_DECIMALS = 7;
export const KNOWN_ASSETS: Readonly<Record<string, string>> = Object.freeze({
  CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA: "USDC",
  CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75: "USDC",
});

export function parseAmount(input: string, decimals = STELLAR_DECIMALS): bigint {
  const raw = input.trim().replaceAll("_", "");
  const base = /^(\d+)(?:u|base)$/i.exec(raw);
  if (base) return BigInt(base[1]!);
  const decimal = /^\$?(\d+)(?:\.(\d+))?$/.exec(raw);
  if (!decimal) {
    throw new AgentPayError(
      "usage",
      `Cannot read "${input}" as an amount; use 0.01 or 100000u for base units`,
      EXIT.USAGE,
    );
  }
  const fraction = decimal[2] ?? "";
  if (fraction.length > decimals) {
    throw new AgentPayError("usage", `Amount has more than ${decimals} decimal places`, EXIT.USAGE);
  }
  return BigInt(decimal[1]! + fraction.padEnd(decimals, "0"));
}

export function formatAmount(amount: string | bigint, decimals = STELLAR_DECIMALS): string {
  const digits = String(amount).padStart(decimals + 1, "0");
  const whole = digits.slice(0, -decimals);
  const fraction = digits.slice(-decimals).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

export function assetLabel(asset: string): { symbol: string; verified: boolean } {
  const known = KNOWN_ASSETS[asset];
  if (known) return { symbol: known, verified: true };
  return { symbol: `${asset.slice(0, 6)}…${asset.slice(-4)}`, verified: false };
}

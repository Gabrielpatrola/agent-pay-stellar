import { assetLabel, formatAmount, parseAmount, STELLAR_DECIMALS } from "./amount.js";
import { AgentPayError, EXIT } from "./errors.js";

export type StellarNetwork = "stellar:testnet" | "stellar:pubnet";
export const DEFAULT_MAX_AMOUNT = "1.00";

export interface PaymentCandidate {
  network: string;
  scheme: string;
  amountBaseUnits: string;
  amount: string;
  asset: string;
  assetSymbol: string;
  assetSymbolVerified: boolean;
  payTo: string;
  maxTimeoutSeconds: number | null;
  declaredDecimals: number | null;
}

export interface PaymentPolicy {
  network?: StellarNetwork;
  maxAmount?: string;
  allowedAssets?: string[];
  allowedPayTo?: string[];
}

export function candidateFromRequirements(value: unknown): PaymentCandidate {
  const item = value as Record<string, unknown>;
  if (item.scheme !== "exact" || typeof item.network !== "string") {
    throw new AgentPayError("no_payable_option", "Only exact Stellar payments are supported");
  }
  if (item.network !== "stellar:testnet" && item.network !== "stellar:pubnet") {
    throw new AgentPayError("unsupported_network", `Unsupported network ${String(item.network)}`);
  }
  if (typeof item.amount !== "string" || !/^\d+$/.test(item.amount) ||
      typeof item.asset !== "string" || typeof item.payTo !== "string") {
    throw new AgentPayError("bad_challenge", "Invalid Stellar payment requirements");
  }
  const extra = (item.extra ?? {}) as Record<string, unknown>;
  const declared = typeof extra.decimals === "number" && Number.isInteger(extra.decimals)
    ? extra.decimals : typeof extra.decimals === "string" && /^\d+$/.test(extra.decimals)
      ? Number(extra.decimals) : null;
  const label = assetLabel(item.asset);
  return {
    network: item.network,
    scheme: "exact",
    amountBaseUnits: item.amount,
    amount: formatAmount(item.amount),
    asset: item.asset,
    assetSymbol: label.symbol,
    assetSymbolVerified: label.verified,
    payTo: item.payTo,
    maxTimeoutSeconds: typeof item.maxTimeoutSeconds === "number" ? item.maxTimeoutSeconds : null,
    declaredDecimals: declared,
  };
}

export function enforcePaymentPolicy(candidate: PaymentCandidate, policy: PaymentPolicy): void {
  const allowedNetwork = policy.network;
  if (allowedNetwork && candidate.network !== allowedNetwork) {
    throw new AgentPayError("unsupported_network", `Payment network is ${candidate.network}, policy allows ${allowedNetwork}`);
  }
  if (!allowedNetwork && candidate.network === "stellar:pubnet") {
    throw new AgentPayError("unsupported_network", "Mainnet requires --network stellar:pubnet", EXIT.DECLINED);
  }
  const max = policy.maxAmount ?? DEFAULT_MAX_AMOUNT;
  const cap = parseAmount(max, STELLAR_DECIMALS);
  if (BigInt(candidate.amountBaseUnits) > cap) {
    throw new AgentPayError(
      "over_max_amount",
      `Payment ${candidate.amount} exceeds --max-amount ${max}`,
      EXIT.OVER_LIMIT,
      { amountBaseUnits: candidate.amountBaseUnits, maxAmountBaseUnits: cap.toString() },
    );
  }
  if (policy.allowedAssets?.length && !policy.allowedAssets.includes(candidate.asset)) {
    throw new AgentPayError("no_payable_option", `Payment asset ${candidate.asset} is not allowed`);
  }
  if (policy.allowedPayTo?.length && !policy.allowedPayTo.includes(candidate.payTo)) {
    throw new AgentPayError("no_payable_option", `Payment recipient ${candidate.payTo} is not allowed`);
  }
}

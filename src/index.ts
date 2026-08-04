import { x402Client, x402HTTPClient, wrapFetchWithPayment } from "@x402/fetch";
import { createEd25519Signer } from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/client";
import { createSafeFetch, type SafeFetchOptions } from "./http.js";
import { AgentPayError, EXIT } from "./errors.js";
import { type ResolvedKey } from "./key.js";
import {
  candidateFromRequirements,
  enforcePaymentPolicy,
  type PaymentCandidate,
  type PaymentPolicy,
  type StellarNetwork,
} from "./policy.js";

export * from "./amount.js";
export * from "./errors.js";
export * from "./http.js";
export * from "./key.js";
export * from "./policy.js";
export * from "./prompt.js";
export * from "./secret.js";

export interface AgentPayOptions extends SafeFetchOptions {
  url: string;
  key: ResolvedKey;
  method?: string;
  headers?: HeadersInit;
  body?: BodyInit;
  policy?: PaymentPolicy;
  rpcUrl?: string;
  authorize?: (candidate: PaymentCandidate) => void | Promise<void>;
  onCandidate?: (candidate: PaymentCandidate, paymentRequired: unknown) => void;
  fetch?: typeof globalThis.fetch;
}

export interface AgentPayResult {
  response: Response;
  paymentRequired: unknown | null;
  selected: PaymentCandidate | null;
  signatureSent: boolean;
  settlement: unknown | null;
  paid: boolean;
}

export async function agentPay(options: AgentPayOptions): Promise<AgentPayResult> {
  const policy = options.policy ?? {};
  if (policy.network === "stellar:pubnet" && !options.rpcUrl) {
    throw new AgentPayError("usage", "Pubnet payment requires an explicit rpcUrl", EXIT.USAGE);
  }
  let paymentRequired: unknown | null = null;
  let selected: PaymentCandidate | null = null;
  let approved = false;
  let settlement: unknown | null = null;
  let decisionError: unknown;

  const selector = (_version: number, requirements: Array<Record<string, unknown>>) => {
    const eligible = requirements.filter((item) =>
      item.scheme === "exact" &&
      (item.network === "stellar:testnet" || item.network === "stellar:pubnet") &&
      (!policy.network || item.network === policy.network) &&
      (policy.network || item.network !== "stellar:pubnet"));
    if (!eligible[0]) {
      decisionError = new AgentPayError(
        "unsupported_network",
        policy.network
          ? `No payable Stellar option matches ${policy.network}`
          : "Mainnet requires --network stellar:pubnet",
        policy.network ? EXIT.FAILURE : EXIT.DECLINED,
      );
      throw decisionError;
    }
    return eligible[0] as never;
  };
  const client = new x402Client(selector);
  for (const network of ["stellar:testnet", "stellar:pubnet"] as StellarNetwork[]) {
    const signer = createEd25519Signer(options.key.secret.reveal(), network);
    client.register(network, options.rpcUrl
      ? new ExactStellarScheme(signer, { url: options.rpcUrl })
      : new ExactStellarScheme(signer));
  }
  client.onBeforePaymentCreation(async (context) => {
    paymentRequired = context.paymentRequired;
    selected = candidateFromRequirements(context.selectedRequirements);
    options.onCandidate?.(selected, paymentRequired);
    try {
      enforcePaymentPolicy(selected, policy);
      await options.authorize?.(selected);
      approved = true;
    } catch (error) {
      decisionError = error;
      throw error;
    }
  });
  client.onPaymentResponse(async (context) => { settlement = context.settleResponse ?? null; });

  const request = options.fetch ?? createSafeFetch(options);
  let response: Response;
  try {
    response = await wrapFetchWithPayment(request, new x402HTTPClient(client))(options.url, {
      method: options.method ?? (options.body === undefined ? "GET" : "POST"),
      headers: options.headers,
      body: options.body,
    });
  } catch (error) {
    throw decisionError ?? error;
  }
  return {
    response,
    paymentRequired,
    selected,
    signatureSent: approved,
    settlement,
    paid: approved && response.status !== 402 && response.ok,
  };
}

export async function inspectPaywall(
  url: string,
  init: RequestInit = {},
  options: SafeFetchOptions = {},
): Promise<{ response: Response; paymentRequired: unknown | null; candidates: PaymentCandidate[] }> {
  const response = await createSafeFetch(options)(url, init);
  if (response.status !== 402) return { response, paymentRequired: null, candidates: [] };
  const parser = new x402HTTPClient(new x402Client());
  let required: unknown;
  try { required = parser.getPaymentRequiredResponse((name) => response.headers.get(name)); }
  catch (error) {
    throw new AgentPayError(
      "bad_challenge",
      `Invalid x402 challenge: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const accepts = (required as { accepts?: unknown[] }).accepts ?? [];
  const candidates: PaymentCandidate[] = [];
  for (const item of accepts) {
    try { candidates.push(candidateFromRequirements(item)); } catch { /* report only payable Stellar shapes */ }
  }
  return { response, paymentRequired: required, candidates };
}

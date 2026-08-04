# Agent integration guide

Agents can use `agent-pay-stellar` as a subprocess or as an in-process TypeScript library.

## Recommended subprocess flow

First inspect the resource:

```bash
quote=$(agent-pay-stellar inspect "$URL" \
  --network stellar:testnet \
  --max-amount 0.02 \
  --json)

jq -e '.ok and .paymentRequired and .limit.withinLimit' <<<"$quote"
```

The agent can then compare `selected.asset`, `selected.payTo`, and `selected.amountBaseUnits` against its own policy. If approved, execute `fetch` with the same boundaries:

```bash
agent-pay-stellar fetch "$URL" \
  --key agent-payer \
  --network stellar:testnet \
  --max-amount 0.02 \
  --allow-asset "$EXPECTED_ASSET" \
  --allow-pay-to "$EXPECTED_RECIPIENT" \
  --yes \
  --json
```

Do not increase a cap automatically merely because the server requested more. Escalate that decision to the operator or an independent budget policy.

## JSON decisions

Treat the process exit code and `error.code` as the stable control interface.

```ts
type AgentPayEnvelope = {
  ok: boolean;
  command: "inspect" | "fetch";
  status: number | null;
  paymentRequired: boolean;
  selected: {
    network: string;
    amount: string;
    amountBaseUnits: string;
    asset: string;
    payTo: string;
  } | null;
  limit: { withinLimit: boolean } | null;
  signatureSent: boolean;
  paid: boolean;
  settlement: unknown | null;
  body: unknown;
  error: { code: string; message: string; details: Record<string, unknown> } | null;
};
```

Typical decisions:

| Condition | Agent action |
| --- | --- |
| `ok && !paymentRequired` | Consume the free response. |
| `inspect` and `limit.withinLimit` | Apply asset/recipient/business policy before fetching. |
| `error.code === "over_max_amount"` | Stop or request human approval for a new cap. |
| `error.code === "no_tty"` | Re-run with `--yes` only if an upstream policy already authorized payment. |
| `error.code === "unsafe_redirect"` | Treat the URL as unsafe; do not bypass the restriction. |
| `signatureSent && !paid` | Record a payment attempt and investigate settlement before retrying. |
| `paid` | Consume `body` and record settlement metadata. |

## In-process integration

```ts
import { agentPay, inspectPaywall, resolveKey } from "agent-pay-stellar";

const quote = await inspectPaywall(url);
// Examine quote.candidates before resolving any key.

const key = await resolveKey("agent-payer");
const result = await agentPay({
  url,
  key,
  policy: {
    network: "stellar:testnet",
    maxAmount: "0.02",
    allowedAssets: [expectedAsset],
    allowedPayTo: [expectedRecipient],
  },
  timeoutMs: 15_000,
  authorize: async (candidate) => {
    await auditLog.record({ action: "stellar-x402-payment", candidate });
  },
});
```

The library's `authorize` callback runs after policy enforcement and immediately before payment creation. Throwing from it aborts payment.

## Retry guidance

Paid handlers should be idempotent. Do not blindly retry when `signatureSent` is true: settlement may have succeeded even if the response was interrupted. Use settlement data and the resource provider's idempotency mechanism before attempting another payment.

# Verification evidence

This document separates claims that can be reproduced locally from claims that require external Stellar infrastructure.

## Automated verification

Run the complete verification suite:

```bash
npm ci
npm run check
npm test
npm run evidence
npm pack --dry-run
npm audit --omit=dev
```

The test suite uses x402 v2 challenges encoded by the official `@x402/core/http` implementation. Executable tests spawn the built CLI against ephemeral local HTTP servers and inspect every received request.

Coverage includes:

- Exact decimal and base-unit conversion.
- Values immediately at and above spending-cap boundaries.
- Default finite cap.
- Hostile server-provided decimal metadata.
- Known and unknown asset presentation.
- Network, asset, and recipient policies.
- Mainnet opt-in.
- Missing, invalid, and environment-provided keys.
- Secret redaction.
- Free resources and valid/malformed 402 challenges.
- Non-interactive confirmation refusal.
- Proof that policy refusals send no `PAYMENT-SIGNATURE` header.
- Same-origin redirect behavior and cross-origin refusal.
- Redirect limits, request method conversion, and timeouts.
- JSON envelopes on success, refusal, and usage errors.
- CLI help and version behavior.

GitHub Actions runs these checks on Node.js 20 and 22.

## Evidence harness

`npm run evidence` builds the package, starts a local protocol-real paywall, runs the published CLI entry point, and fails unless all these assertions hold:

1. `inspect` decodes a `0.01` Stellar payment.
2. The decoded payment is within a `0.05` cap.
3. A `5.00` payment is refused against a `0.01` cap with exit code 3.
4. The local server receives no payment signature during the refusal.
5. The generated throwaway secret appears in neither output stream.

The command prints a timestamped JSON evidence summary suitable for CI logs or a submission recording.

## What local evidence does not prove

Local tests do not claim that a payment was settled on Stellar. They prove challenge decoding, policy behavior, signing prevention on refusals, HTTP isolation, and the agent-facing interface.

## Testnet settlement evidence

A complete external proof requires:

- A funded Stellar testnet payer with the chosen asset.
- A payee able to receive that asset.
- An x402 resource server.
- A compatible facilitator and Soroban RPC.

Record the following when performing the live run:

```text
Date/time:
CLI version and commit:
Resource URL or reproducible server commit:
Network:
Asset contract:
Quoted amount/base units:
Payer public address:
Payee public address:
Settlement transaction hash:
Explorer URL:
HTTP status after payment:
Response body hash:
Payer balance before/after:
Payee balance before/after:
```

Never publish the secret seed or the full signed authorization. Once a live settlement is performed, add the transaction hash and explorer link to this document without replacing the reproducible local evidence.

# agent-pay-stellar

[![npm version](https://img.shields.io/npm/v/agent-pay-stellar?color=7c3aed&logo=npm)](https://www.npmjs.com/package/agent-pay-stellar)
[![npm downloads](https://img.shields.io/npm/dm/agent-pay-stellar?color=06b6d4)](https://www.npmjs.com/package/agent-pay-stellar)
[![CI](https://github.com/Gabrielpatrola/agent-pay-stellar/actions/workflows/ci.yml/badge.svg)](https://github.com/Gabrielpatrola/agent-pay-stellar/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/agent-pay-stellar?color=22c55e)](./LICENSE)

An installable CLI and TypeScript library that lets agents and shell workflows inspect and pay Stellar x402-gated URLs.

```text
request -> HTTP 402 -> inspect -> enforce policy -> authorize -> sign -> retry -> unlock
```

The project uses the official `@x402/fetch` and `@x402/stellar` payment lifecycle. Its added value is the safety and automation layer around that lifecycle.

Documentation:

- [Security model](docs/SECURITY.md)
- [Agent integration guide](docs/AGENT_INTEGRATION.md)
- [Verification evidence](docs/EVIDENCE.md)

## Install

Node.js 20 or newer is required.

```bash
npm install --global agent-pay-stellar
```

For local development:

```bash
npm install
npm run build
npm link
```

## Wallet prerequisite

Paying requires a Stellar CLI identity with a trustline and balance for the requested asset. For testnet USDC:

```bash
# Install Stellar CLI on macOS/Linux (Homebrew)
brew install stellar-cli

# Create a dedicated file-backed testnet payer and fund it with testnet XLM
stellar keys generate agent-payer --network testnet --fund

# Add the Circle testnet USDC trustline
stellar tx new change-trust \
  --source-account agent-payer \
  --network testnet \
  --line USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5

# Print the public address to fund with testnet USDC
stellar keys public-key agent-payer
```

Fund that address through the [Circle testnet faucet](https://faucet.circle.com/), selecting Stellar testnet. Then pass the identity as `--key agent-payer`. The `--fund` command supplies testnet XLM only; it does not supply USDC. Never publish the output of `stellar keys secret agent-payer`.

> **Secure Store limitation:** do not create the payer with `--secure-store`. Stellar Secure Store intentionally does not reveal secret keys, but the current `@x402/stellar` signer requires the raw `S...` key to sign contract authorization entries. Use a dedicated, low-balance, file-backed Stellar CLI identity for this tool. Never reuse a treasury or high-value wallet.

> **Payment prerequisite:** Friendbot and `stellar keys generate --fund` provide testnet XLM only. Before an x402 USDC payment can succeed, the payer must have both a USDC trustline and enough testnet USDC to cover the quoted amount. The recipient (`payTo`) must also have a USDC trustline. If the payer has no USDC, simulation fails with `resulting balance is not within the allowed range`; if the recipient lacks a trustline, settlement can fail with `op_no_trust`. Use the Circle testnet faucet to fund the payer after creating its trustline.

## Inspect before paying

`inspect` makes one unpaid request, decodes the challenge, evaluates the default spending cap, and stops. It never reads a key or creates a signer.

```bash
agent-pay-stellar inspect https://api.example.com/weather

agent-pay-stellar inspect https://api.example.com/weather \
  --max-amount 0.05 \
  --json
```

Stellar token amounts use seven decimals. Human values such as `0.01` and explicit base-unit values such as `100000u` are accepted.

## Pay and unlock

Prefer a dedicated, low-balance Stellar account managed by Stellar CLI:

```bash
stellar keys generate agent-payer --network testnet --fund

agent-pay-stellar fetch https://api.example.com/weather \
  --key agent-payer \
  --max-amount 0.05
```

The CLI shows the exact amount, asset contract, network, recipient, cap, and payer before asking for confirmation.

For an unattended agent, authorization must be explicit:

```bash
agent-pay-stellar fetch "$URL" \
  --key agent-payer \
  --max-amount 0.05 \
  --allow-asset CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA \
  --allow-pay-to G... \
  --yes \
  --json
```

Without `--yes`, a process without an interactive terminal refuses the payment.

Secrets may alternatively be supplied through `AGENT_PAY_STELLAR_SECRET`, `STELLAR_PRIVATE_KEY`, or `STELLAR_SECRET_KEY`. A dedicated file-backed Stellar CLI identity avoids placing the secret in command history or process arguments. Secure Store identities are not supported because their secrets cannot be exported to the x402 signer.

## POST and custom requests

```bash
agent-pay-stellar fetch https://api.example.com/research \
  --key agent-payer \
  -X POST \
  -H 'content-type: application/json' \
  -d '{"topic":"Soroban"}' \
  --max-amount 0.25
```

Use `--data-file request.json` to read a request body from disk. `--timeout` defaults to 30000 milliseconds, and `--max-redirects` defaults to five.

## Agent JSON contract

`--json` writes exactly one JSON document to stdout. Human output and prompts are suppressed or sent to stderr. Agents should branch on `ok`, `error.code`, and the process exit code—not on prose.

The envelope always includes:

```json
{
  "ok": true,
  "command": "inspect",
  "url": "https://api.example.com/weather",
  "status": 402,
  "paymentRequired": true,
  "challenge": {},
  "selected": {},
  "limit": {
    "maxAmount": "1.00",
    "maxAmountBaseUnits": "10000000",
    "amountBaseUnits": "100000",
    "withinLimit": true
  },
  "paid": false,
  "signatureSent": false,
  "payer": null,
  "settlement": null,
  "body": {},
  "error": null
}
```

## Stable exit codes

| Code | Meaning | Payment sent? |
| ---: | --- | --- |
| 0 | Success | Maybe; inspect `paid` |
| 1 | HTTP, challenge, or internal failure | Normally no |
| 2 | Invalid invocation or missing key | No |
| 3 | Price exceeded the cap | No |
| 4 | Declined, no TTY, or mainnet not explicitly selected | No |
| 5 | Settlement failed | Attempted |
| 6 | Payment sent but resource stayed locked | Attempted |
| 7 | Unsafe cross-origin redirect | No |

## Mainnet

Testnet is the safe default. Pubnet must be named explicitly and requires an explicit Soroban RPC endpoint:

```bash
agent-pay-stellar fetch https://api.example.com/paid \
  --network stellar:pubnet \
  --rpc-url https://your-trusted-soroban-rpc.example \
  --key mainnet-agent \
  --max-amount 0.01
```

## Library

```ts
import { agentPay, resolveKey } from "agent-pay-stellar";

const key = await resolveKey("agent-payer");
const result = await agentPay({
  url: "https://api.example.com/weather",
  key,
  policy: {
    network: "stellar:testnet",
    maxAmount: "0.05",
    allowedAssets: ["C..."],
    allowedPayTo: ["G..."],
  },
  authorize: async (payment) => {
    console.error(`Authorizing ${payment.amount} ${payment.assetSymbol}`);
  },
});

console.log(await result.response.json());
```

`inspectPaywall`, amount conversion, policy enforcement, safe fetch, key resolution, exit codes, and secret-redaction utilities are also exported.

## Security model

- The default cap is `1.00` token; there is no unlimited default.
- Caps use exact integer arithmetic and Stellar's chain-defined seven-decimal scale.
- Server-provided decimals cannot rescale a quote or its cap.
- Known asset symbols are derived from contract addresses; unknown assets are displayed by address.
- Pubnet is never selected implicitly.
- Cross-origin redirects are refused, and same-origin redirects are bounded.
- Every request has a timeout.
- Nothing is paid non-interactively unless `--yes` is present.
- Asset and recipient allowlists are available for unattended agents.
- Stellar-secret-shaped values are redacted from CLI output.
- `paid`, `signatureSent`, and settlement state are reported separately.

Use a dedicated hot wallet containing only the funds an agent needs. This CLI cannot establish that an API response is useful or truthful; `inspect`, caps, and allowlists constrain payment risk but do not replace counterparty trust.

## Verification

```bash
npm run check
npm test
npm run evidence
npm run build
npm pack --dry-run
```

The suite includes unit and executable-level tests for amount boundaries, hostile decimal metadata, default caps, network/asset/recipient policies, non-interactive refusal, redirect isolation, request semantics, timeouts, JSON output, and secret leakage. `npm run evidence` produces a timestamped, reproducible proof summary from a local protocol-encoded x402 paywall.

## Automated releases

Pushes to `main` run tests and type checking before Semantic Release evaluates the commits. Conventional commits automatically control the next version and publish both an npm package and GitHub Release:

```text
fix: correct redirect handling       -> patch release
feat: add cumulative budget policy   -> minor release
feat!: change the JSON contract      -> major release
```

npm publishing uses GitHub Actions trusted publishing with OIDC. Configure `Gabrielpatrola/agent-pay-stellar` and `.github/workflows/publish.yml` as a trusted publisher for the `agent-pay-stellar` package on npm; no `NPM_TOKEN` repository secret is required.

## License

Apache-2.0

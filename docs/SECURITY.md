# Security model

`agent-pay-stellar` moves value in response to data supplied by an HTTP server. The server is therefore treated as an untrusted counterparty, not as a source of policy.

## Protected assets

- The Stellar secret seed.
- Authorization to transfer an asset.
- The operator's approved maximum amount.
- The intended Stellar network, asset contract, and recipient.
- Payment credentials attached to an HTTP retry.
- Machine-readable output consumed by an agent.

## Trust boundaries

The resource server controls the x402 challenge, including its amount, asset, recipient, network, labels, timeout, and metadata. The facilitator and configured Soroban RPC are external services. Neither a successful settlement nor HTTP 200 proves that the returned information is useful or truthful.

## Controls

### Finite spending cap

The default cap is `1.00` unit of the quoted token. The cap is converted to base units without floating-point arithmetic and compared as an integer. `0.01` accepts exactly `100000` base units and rejects `100001`.

The cap is a token quantity, not a fiat valuation. An unknown asset priced at `0.01` is not necessarily worth USD 0.01. Unattended agents should use `--allow-asset`.

### Server metadata cannot rescale money

Stellar assets use seven decimal places. A server-provided `extra.decimals` value is retained for inspection but never used to calculate the displayed amount or spending cap. This prevents a hostile server from describing `10000000000` base units as `1` instead of `1000`.

Known display symbols are derived from asset contract addresses. Unknown contracts are displayed using their address; server-provided names do not confer trust.

### Explicit payment authorization

Interactive payment requires a `y` or `yes` response. A process without a TTY refuses unless `--yes` is supplied. The cap and optional allowlists still apply when `--yes` is used.

### Mainnet isolation

Pubnet is never selected implicitly. It requires both `--network stellar:pubnet` and an explicit `--rpc-url`. The library applies the same RPC requirement.

### Redirect isolation

Redirects are handled manually. Same-origin redirects are bounded; cross-origin redirects are refused so a payment header cannot be replayed to a different origin. HTTP 303 and applicable 301/302 responses convert a non-GET request to GET and remove body-specific headers.

### Key handling

The recommended source is a dedicated, low-balance, file-backed Stellar CLI identity. Environment variables are supported for automation. Passing a literal seed through `--key` is supported for compatibility but generates a warning because command arguments may appear in shell history and process listings.

Stellar Secure Store identities are not currently supported. Secure Store deliberately refuses to reveal the secret, while `@x402/stellar` requires the raw secret to create an Ed25519 signer for contract authorization entries. Do not work around this limitation with a treasury wallet; create a separate payer containing only the funds the agent needs.

Secret values are wrapped in a type that redacts string, JSON, and inspection output. Every CLI error and JSON envelope is redacted again before being written.

### Outcome separation

The result distinguishes:

- `signatureSent`: payment authorization was approved and a paid request was attempted.
- `settlement`: the server's decoded settlement response.
- `paid`: the paid request returned a successful, unlocked response.

This prevents an agent from interpreting “request attempted” as “payment settled and resource unlocked.”

## Recommended unattended policy

```bash
agent-pay-stellar fetch "$URL" \
  --key agent-payer \
  --network stellar:testnet \
  --max-amount 0.02 \
  --allow-asset C... \
  --allow-pay-to G... \
  --timeout 15000 \
  --yes \
  --json
```

Use a dedicated account with limited funds. Rotate it independently from treasury or operator accounts.

## Out of scope

- Determining whether an API or its response is honest.
- Converting arbitrary token prices to fiat.
- Protecting secrets already exposed through shell history.
- Securing a malicious local `stellar` executable or compromised host.
- Guaranteeing facilitator or RPC availability.
- Cumulative or daily budgets across separate CLI processes. This is a planned policy extension.

## Reporting

Do not include a live secret seed, signed payment payload, or private account information in a public issue. Reproduce reports with generated, unfunded test keys whenever possible.

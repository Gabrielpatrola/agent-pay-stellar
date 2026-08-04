import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { Keypair } from "@stellar/stellar-sdk";
import { encodePaymentRequiredHeader } from "@x402/core/http";

const ASSET = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const PAY_TO = Keypair.random().publicKey();
const SECRET = Keypair.random().secret();
const requests = [];
let base = "";

const server = createServer((request, response) => {
  requests.push({ url: request.url, paymentSignature: request.headers["payment-signature"] ?? null });
  const amount = request.url === "/expensive" ? "50000000" : "100000";
  const paymentRequired = encodePaymentRequiredHeader({
    x402Version: 2,
    error: "Payment required",
    resource: { url: `${base}${request.url}`, description: "Local protocol evidence", mimeType: "application/json" },
    accepts: [{ scheme: "exact", network: "stellar:testnet", asset: ASSET, amount, payTo: PAY_TO,
      maxTimeoutSeconds: 300, extra: { areFeesSponsored: true } }],
  });
  response.writeHead(402, { "content-type": "application/json", "payment-required": paymentRequired });
  response.end('{"error":"payment_required"}');
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
base = `http://127.0.0.1:${server.address().port}`;

try {
  const inspected = await cli(["inspect", `${base}/price`, "--max-amount", "0.05", "--json"]);
  const refused = await cli(["fetch", `${base}/expensive`, "--max-amount", "0.01", "--yes", "--json"]);
  const inspectEnvelope = JSON.parse(inspected.stdout);
  const refusalEnvelope = JSON.parse(refused.stdout);

  if (inspected.code !== 0 || inspectEnvelope.selected.amount !== "0.01") throw new Error("inspection evidence failed");
  if (refused.code !== 3 || refusalEnvelope.error.code !== "over_max_amount") throw new Error("cap evidence failed");
  if (requests.some((request) => request.paymentSignature !== null)) throw new Error("a refusal sent a payment signature");
  if ((inspected.stdout + inspected.stderr + refused.stdout + refused.stderr).includes(SECRET)) throw new Error("secret leaked");

  console.log(JSON.stringify({
    generatedAt: new Date().toISOString(),
    protocol: "x402 v2 PAYMENT-REQUIRED encoded by @x402/core",
    assertions: {
      inspectDecodedPrice: inspectEnvelope.selected.amount,
      inspectWithinLimit: inspectEnvelope.limit.withinLimit,
      overCapExitCode: refused.code,
      overCapError: refusalEnvelope.error.code,
      requestsObserved: requests.length,
      paymentSignaturesObserved: requests.filter((request) => request.paymentSignature !== null).length,
      secretAbsentFromOutput: true,
    },
  }, null, 2));
} finally {
  await new Promise((resolve) => server.close(resolve));
}

function cli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["dist/cli.js", ...args], {
      env: { ...process.env, AGENT_PAY_STELLAR_SECRET: SECRET },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });
}

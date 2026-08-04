import { AgentPayError, EXIT } from "./errors.js";

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const BODY_HEADERS = ["content-type", "content-length", "content-encoding", "content-language"];

export interface SafeFetchOptions { timeoutMs?: number; maxRedirects?: number; }

export function parseHttpUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new AgentPayError("usage", `Invalid URL: ${value}`, EXIT.USAGE); }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new AgentPayError("usage", "Only HTTP and HTTPS URLs are supported", EXIT.USAGE);
  }
  return url;
}

export function createSafeFetch(options: SafeFetchOptions = {}): typeof globalThis.fetch {
  const timeout = options.timeoutMs ?? 30_000;
  const maximum = options.maxRedirects ?? 5;
  return async (input, init) => {
    const original = new Request(input, init);
    let url = parseHttpUrl(original.url);
    const origin = url.origin;
    let method = original.method;
    let headers = new Headers(original.headers);
    let body: ArrayBuffer | undefined;
    if (method !== "GET" && method !== "HEAD") {
      const bytes = await original.arrayBuffer();
      if (bytes.byteLength) body = bytes;
    }
    for (let hop = 0; ; hop += 1) {
      const response = await fetch(url, { method, headers, body, redirect: "manual", signal: AbortSignal.timeout(timeout) });
      const location = response.headers.get("location");
      if (!REDIRECTS.has(response.status) || !location) return response;
      const next = new URL(location, url);
      if (next.protocol !== "http:" && next.protocol !== "https:") {
        throw new AgentPayError("unsafe_redirect", `Refusing redirect to ${next.protocol}`, EXIT.UNSAFE_REDIRECT);
      }
      if (next.origin !== origin) {
        throw new AgentPayError("unsafe_redirect", `Refusing cross-origin redirect ${origin} -> ${next.origin}`, EXIT.UNSAFE_REDIRECT);
      }
      if (hop >= maximum) throw new AgentPayError("http_error", `Too many redirects (>${maximum})`);
      if (response.status === 303 || (response.status !== 307 && response.status !== 308 && method !== "GET" && method !== "HEAD")) {
        method = "GET"; body = undefined;
        for (const name of BODY_HEADERS) headers.delete(name);
      }
      await response.body?.cancel();
      url = next;
    }
  };
}

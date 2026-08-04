import { inspect } from "node:util";

const SECRET_PATTERN = /\bS[A-Z2-7]{55}\b/g;

export function redact(value: string): string {
  return value.replace(SECRET_PATTERN, "S***[redacted]");
}

export class Secret {
  readonly #value: string;
  constructor(value: string, readonly source: string) { this.#value = value; }
  reveal(): string { return this.#value; }
  toString(): string { return "[redacted]"; }
  toJSON(): string { return "[redacted]"; }
  [inspect.custom](): string { return "Secret([redacted])"; }
}

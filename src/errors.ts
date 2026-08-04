export const EXIT = {
  OK: 0,
  FAILURE: 1,
  USAGE: 2,
  OVER_LIMIT: 3,
  DECLINED: 4,
  SETTLE_FAILED: 5,
  STILL_LOCKED: 6,
  UNSAFE_REDIRECT: 7,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];
export type ErrorCode =
  | "usage" | "over_max_amount" | "declined" | "no_tty" | "unsafe_redirect"
  | "no_key" | "bad_key" | "unsupported_network" | "no_payable_option"
  | "bad_challenge" | "settle_failed" | "still_locked" | "http_error" | "internal";

export class AgentPayError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly exitCode: ExitCode = EXIT.FAILURE,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "AgentPayError";
  }
}

export function usageError(message: string): AgentPayError {
  return new AgentPayError("usage", message, EXIT.USAGE);
}

import { createInterface } from "node:readline/promises";
import { AgentPayError, EXIT } from "./errors.js";

export async function confirmPayment(question: string, assumeYes: boolean): Promise<void> {
  if (assumeYes) return;
  if (process.stdin.isTTY !== true) {
    throw new AgentPayError("no_tty", "Refusing to pay without confirmation; pass --yes for unattended use", EXIT.DECLINED);
  }
  const prompt = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  try {
    const answer = (await prompt.question(`${question} [y/N] `)).trim().toLowerCase();
    if (answer !== "y" && answer !== "yes") {
      throw new AgentPayError("declined", "Payment declined; nothing was signed", EXIT.DECLINED);
    }
  } finally { prompt.close(); }
}

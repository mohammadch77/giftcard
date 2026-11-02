import type { SmsMessage, SmsProvider, SmsSendResult } from "../index";

/**
 * TEST DOUBLE — must never be imported by production code (only src/platform/composition may bridge).
 * Records messages in memory and can simulate definitive and unknown failures.
 */
export class TestSmsProvider implements SmsProvider {
  readonly kind = "test";
  readonly sent: SmsMessage[] = [];
  mode: "ok" | "reject" | "throw" = "ok";

  async send(message: SmsMessage): Promise<SmsSendResult> {
    if (this.mode === "throw") throw new Error("simulated unknown delivery failure");
    if (this.mode === "reject") return { status: "REJECTED" };
    this.sent.push(message);
    return { status: "ACCEPTED" };
  }

  /** The last 6-digit code sent to `to`, for tests only. */
  lastCode(to: string): string | undefined {
    const m = [...this.sent].reverse().find((s) => s.to === to);
    return m?.text.match(/\d{6}/)?.[0];
  }
}

import { DomainError } from "../../errors";
import type { KeyProvider } from "../key-provider";

/** TEST DOUBLE: wraps a provider and can be switched "unavailable" to test fail-closed behaviour. */
export class FlakyKeyProvider implements KeyProvider {
  readonly kind: string;
  available = true;
  /** When set, the NEXT call throws this raw error (used to prove provider messages are not leaked). */
  failWith: Error | null = null;
  readonly wrapInputs: Buffer[] = [];

  constructor(private readonly inner: KeyProvider) {
    this.kind = `flaky(${inner.kind})`;
  }

  private gate(): void {
    if (this.failWith) {
      const e = this.failWith;
      this.failWith = null;
      throw e;
    }
    if (!this.available) throw new DomainError("KEY_UNAVAILABLE", "key provider is unavailable");
  }

  currentKekVersion(): number { this.gate(); return this.inner.currentKekVersion(); }
  kekVersions(): readonly number[] { this.gate(); return this.inner.kekVersions(); }
  currentHmacVersion(): number { this.gate(); return this.inner.currentHmacVersion(); }
  hmacVersions(): readonly number[] { this.gate(); return this.inner.hmacVersions(); }
  async wrapDek(dek: Buffer, v: number, aad: Buffer): Promise<Buffer> { this.gate(); this.wrapInputs.push(dek); return this.inner.wrapDek(dek, v, aad); }
  async unwrapDek(w: Buffer, v: number, aad: Buffer): Promise<Buffer> { this.gate(); return this.inner.unwrapDek(w, v, aad); }
  async hmac(d: Buffer, v: number): Promise<Buffer> { this.gate(); return this.inner.hmac(d, v); }
}

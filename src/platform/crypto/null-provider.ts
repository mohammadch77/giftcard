import { DomainError } from "../errors";
import type { KeyProvider } from "./key-provider";

/** Fail-closed provider used when KEY_PROVIDER=none: every operation refuses. */
export class NullKeyProvider implements KeyProvider {
  readonly kind = "none";
  private refuse(): never {
    throw new DomainError("KEY_PROVIDER_NOT_CONFIGURED", "no key provider is configured");
  }
  currentKekVersion(): number { return this.refuse(); }
  kekVersions(): readonly number[] { return this.refuse(); }
  wrapDek(): Promise<Buffer> { return Promise.reject(new DomainError("KEY_PROVIDER_NOT_CONFIGURED", "no key provider is configured")); }
  unwrapDek(): Promise<Buffer> { return Promise.reject(new DomainError("KEY_PROVIDER_NOT_CONFIGURED", "no key provider is configured")); }
  currentHmacVersion(): number { return this.refuse(); }
  hmacVersions(): readonly number[] { return this.refuse(); }
  hmac(): Promise<Buffer> { return Promise.reject(new DomainError("KEY_PROVIDER_NOT_CONFIGURED", "no key provider is configured")); }
}

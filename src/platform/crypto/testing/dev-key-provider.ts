import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { DomainError } from "../../errors";
import { KEY_BYTES } from "../key-provider";
import type { KeyProvider } from "../key-provider";

/**
 * DEVELOPMENT / TEST KeyProvider — NOT a production custody solution (D8 is open).
 * Holds KEKs and peppers in process memory. Key material is supplied by the caller (env in
 * development via the guarded factory in src/platform/composition, or random keys in tests);
 * nothing is stored anywhere and no real key exists in the repository.
 * It is rejected in production by env validation AND by the composition factory.
 *
 * KEK wrap = AES-256-GCM(KEK[v], iv(12), aad) => iv | ct(32) | tag(16) = 60 bytes.
 * Pepper  = HMAC-SHA256 key, a different secret from every KEK (enforced at construction).
 */
export interface DevKeyMaterial {
  /** KEK per version number. */
  keks: ReadonlyMap<number, Buffer>;
  /** Pepper per version number. */
  peppers: ReadonlyMap<number, Buffer>;
  currentKek: number;
  currentPepper: number;
}

const WRAPPED_BYTES = 12 + 32 + 16;

export class DevKeyProvider implements KeyProvider {
  readonly kind = "dev";
  private readonly keks: Map<number, Buffer>;
  private readonly peppers: Map<number, Buffer>;
  private readonly kekCurrent: number;
  private readonly pepperCurrent: number;

  constructor(material: DevKeyMaterial) {
    this.keks = new Map([...material.keks].map(([v, k]) => [v, Buffer.from(k)]));
    this.peppers = new Map([...material.peppers].map(([v, k]) => [v, Buffer.from(k)]));
    this.kekCurrent = material.currentKek;
    this.pepperCurrent = material.currentPepper;
    if (!this.keks.has(this.kekCurrent) || !this.peppers.has(this.pepperCurrent)) {
      throw new DomainError("INVALID_ARGUMENT", "current key versions must be present");
    }
    for (const k of [...this.keks.values(), ...this.peppers.values()]) {
      if (k.length !== KEY_BYTES) throw new DomainError("INVALID_ARGUMENT", "keys must be exactly 32 bytes");
    }
    // Separation of duties: no pepper may equal any KEK, and all keys within a family are distinct.
    const all = [...this.keks.values(), ...this.peppers.values()].map((b) => b.toString("hex"));
    if (new Set(all).size !== all.length) {
      throw new DomainError("INVALID_ARGUMENT", "KEKs and HMAC peppers must all be distinct secrets");
    }
  }

  /** Random keys (tests / throw-away development). `versions` KEKs and peppers are generated. */
  static generate(versions = 1): DevKeyProvider {
    const keks = new Map<number, Buffer>();
    const peppers = new Map<number, Buffer>();
    for (let v = 1; v <= versions; v++) {
      keks.set(v, randomBytes(KEY_BYTES));
      peppers.set(v, randomBytes(KEY_BYTES));
    }
    return new DevKeyProvider({ keks, peppers, currentKek: versions, currentPepper: versions });
  }

  /** Same keys, optionally dropping versions or switching the current ones (simulate loss/rotation). */
  derive(options: { dropKek?: number[]; dropPepper?: number[]; currentKek?: number; currentPepper?: number }): DevKeyProvider {
    const keks = new Map([...this.keks].filter(([v]) => !(options.dropKek ?? []).includes(v)));
    const peppers = new Map([...this.peppers].filter(([v]) => !(options.dropPepper ?? []).includes(v)));
    return new DevKeyProvider({
      keks, peppers,
      currentKek: options.currentKek ?? this.kekCurrent,
      currentPepper: options.currentPepper ?? this.pepperCurrent,
    });
  }

  /** Add a new KEK / pepper version (rotation) and make it current. Returns a new provider. */
  withRotation(options: { newKek?: boolean; newPepper?: boolean }): DevKeyProvider {
    const keks = new Map(this.keks);
    const peppers = new Map(this.peppers);
    let currentKek = this.kekCurrent;
    let currentPepper = this.pepperCurrent;
    if (options.newKek) { currentKek = Math.max(...keks.keys()) + 1; keks.set(currentKek, randomBytes(KEY_BYTES)); }
    if (options.newPepper) { currentPepper = Math.max(...peppers.keys()) + 1; peppers.set(currentPepper, randomBytes(KEY_BYTES)); }
    return new DevKeyProvider({ keks, peppers, currentKek, currentPepper });
  }

  /** Same version numbers but DIFFERENT key bytes — simulates "KEK replaced by a wrong key". */
  withReplacedKek(version: number): DevKeyProvider {
    const keks = new Map(this.keks);
    keks.set(version, randomBytes(KEY_BYTES));
    return new DevKeyProvider({ keks, peppers: this.peppers, currentKek: this.kekCurrent, currentPepper: this.pepperCurrent });
  }

  currentKekVersion(): number { return this.kekCurrent; }
  kekVersions(): readonly number[] { return [...this.keks.keys()].sort((a, b) => a - b); }
  currentHmacVersion(): number { return this.pepperCurrent; }
  hmacVersions(): readonly number[] { return [...this.peppers.keys()].sort((a, b) => a - b); }

  private kek(version: number): Buffer {
    const k = this.keks.get(version);
    if (!k) throw new DomainError("KEY_VERSION_UNKNOWN", "KEK version is not available");
    return k;
  }

  async wrapDek(dek: Buffer, kekVersion: number, aad: Buffer): Promise<Buffer> {
    const kek = this.kek(kekVersion);
    if (dek.length !== 32) throw new DomainError("INVALID_ARGUMENT", "DEK must be 32 bytes");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", kek, iv);
    cipher.setAAD(Buffer.concat([Buffer.from(`kek:${kekVersion}:`), aad]));
    const ct = Buffer.concat([cipher.update(dek), cipher.final()]);
    return Buffer.concat([iv, ct, cipher.getAuthTag()]);
  }

  async unwrapDek(wrapped: Buffer, kekVersion: number, aad: Buffer): Promise<Buffer> {
    const kek = this.kek(kekVersion);
    if (wrapped.length !== WRAPPED_BYTES) throw new DomainError("DECRYPT_FAILED", "wrapped key failed authentication");
    try {
      const decipher = createDecipheriv("aes-256-gcm", kek, wrapped.subarray(0, 12));
      decipher.setAAD(Buffer.concat([Buffer.from(`kek:${kekVersion}:`), aad]));
      decipher.setAuthTag(wrapped.subarray(WRAPPED_BYTES - 16));
      return Buffer.concat([decipher.update(wrapped.subarray(12, WRAPPED_BYTES - 16)), decipher.final()]);
    } catch {
      throw new DomainError("DECRYPT_FAILED", "wrapped key failed authentication");
    }
  }

  async hmac(data: Buffer, hmacVersion: number): Promise<Buffer> {
    const pepper = this.peppers.get(hmacVersion);
    if (!pepper) throw new DomainError("KEY_VERSION_UNKNOWN", "pepper version is not available");
    return createHmac("sha256", pepper).update(data).digest();
  }
}

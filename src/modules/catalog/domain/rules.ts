import { z } from "zod";
import { DomainError } from "@/platform/errors";
import { rialPrice } from "@/platform/money";
import type { Rial } from "@/platform/money";

export const PRODUCT_TYPES = ["GIFT_CARD", "GAME_ACCOUNT", "GAME_SUBSCRIPTION", "STREAMING_SUBSCRIPTION", "DIGITAL_SERVICE", "OTHER"] as const;
export const FULFILLMENT_METHODS = ["AUTO_CODE", "MANUAL", "SUPPLIER_API"] as const;
export type ProductType = (typeof PRODUCT_TYPES)[number];
export type FulfillmentMethod = (typeof FULFILLMENT_METHODS)[number];
export type PublicationStatus = "DRAFT" | "PUBLISHED" | "ARCHIVED";
export type Availability = "AVAILABLE" | "TEMPORARILY_UNAVAILABLE";

/**
 * Fulfilment compatibility (C-2, approved direction applied in P1-B / migration 0027): gift cards and digital codes are automatic,
 * game accounts manual, subscriptions manual or supplier API (chosen per product). DIGITAL_SERVICE and OTHER are not named by the
 * approved direction and are unchanged (OPEN_QUESTIONS C-2b). The database table `product_type_fulfillment` is authoritative;
 * this mirror gives early, friendly errors and a test pins both together.
 */
export const FULFILLMENT_COMPATIBILITY: Readonly<Record<ProductType, readonly FulfillmentMethod[]>> = {
  GIFT_CARD: ["AUTO_CODE"],
  GAME_ACCOUNT: ["MANUAL"],
  GAME_SUBSCRIPTION: ["MANUAL", "SUPPLIER_API"],
  STREAMING_SUBSCRIPTION: ["MANUAL", "SUPPLIER_API"],
  DIGITAL_SERVICE: ["MANUAL", "SUPPLIER_API"],
  OTHER: ["AUTO_CODE", "MANUAL", "SUPPLIER_API"],
};

export function assertCompatible(type: ProductType, method: FulfillmentMethod): void {
  if (!FULFILLMENT_COMPATIBILITY[type].includes(method)) {
    throw new DomainError("CATALOG_INVALID", `fulfilment method ${method} is not allowed for ${type}`);
  }
}

/** Publication state machine (mirrors the DB rules). */
export const PUBLICATION_TRANSITIONS: Readonly<Record<PublicationStatus, readonly PublicationStatus[]>> = {
  DRAFT: ["PUBLISHED", "ARCHIVED"],
  PUBLISHED: ["DRAFT", "ARCHIVED"],
  ARCHIVED: [],
};

const slug = (max: number) => z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "invalid slug").max(max);
const name = (max: number) => z.string().trim().min(1).max(max);
const uuid = z.string().uuid();

export const categoryInput = z.strictObject({ slug: slug(80), name: name(120), parentId: uuid.optional(), sortOrder: z.number().int().min(-10000).max(10000).optional() });
export const brandInput = z.strictObject({ slug: slug(80), name: name(120) });
export const regionInput = z.strictObject({ code: z.string().regex(/^[A-Z]{2,8}$/), name: name(80) });
export const gameInput = z.strictObject({ slug: slug(80), name: name(160) });
export const platformInput = z.strictObject({ slug: slug(80), name: name(120) });
export const productInput = z.strictObject({
  type: z.enum(PRODUCT_TYPES), brandId: uuid, categoryId: uuid, gameId: uuid.optional(), slug: slug(120), name: name(200), description: z.string().max(5000).optional(),
});
export const productUpdate = z.strictObject({ name: name(200).optional(), description: z.string().max(5000).nullable().optional(), brandId: uuid.optional(), categoryId: uuid.optional(), gameId: uuid.nullable().optional() });

/** Keys that name a credential. The catalog is PUBLIC: such a key can never be a descriptive attribute (credentials live sealed in inventory/fulfilment only). */
const CREDENTIAL_WORDS = new Set(["pass", "passwd", "pwd", "pin", "otp", "cvv", "key", "mail", "email", "login", "auth", "cookie", "session", "recovery", "private", "2fa", "username", "user"]);
const CREDENTIAL_SUBSTRINGS = ["password", "secret", "token", "credential", "apikey", "passcode"];
export const looksLikeCredentialKey = (k: string): boolean => CREDENTIAL_SUBSTRINGS.some((x) => k.includes(x)) || k.split("_").some((w) => CREDENTIAL_WORDS.has(w));

/** Descriptive attributes only: flat object, scalar values, bounded size. NEVER put secrets or costs here (it is public). */
export const attrsSchema = z
  .record(z.string().regex(/^[a-z][a-z0-9_]{0,39}$/), z.union([z.string().max(200), z.number().finite(), z.boolean()]))
  .refine((o) => Object.keys(o).length <= 20, "too many attributes")
  .refine((o) => !Object.keys(o).some(looksLikeCredentialKey), "an attribute name looks like a credential; credentials are never catalog data");

const listText = z.string().trim().min(1).max(120);
/** B2: typed, public account attributes. `accountType` is a code (not a legal category); there is no field that can hold a login. */
export const gameAccountAttributesInput = z.strictObject({
  accountType: z.string().regex(/^[A-Z][A-Z0-9_]{1,29}$/, "account type is an UPPER_SNAKE code"),
  level: z.number().int().min(0).max(100_000).nullable().optional(),
  includedItems: z.array(listText).max(50).optional(),
  features: z.array(listText).max(30).optional(),
});
export type GameAccountAttributesInput = z.infer<typeof gameAccountAttributesInput>;
export const gamePlatformLinkInput = z.strictObject({ gameId: uuid, platformId: uuid });
export const gamePlatformRegionLinkInput = z.strictObject({ gameId: uuid, platformId: uuid, regionId: uuid });
export const fulfillmentChangeInput = z.strictObject({ to: z.enum(FULFILLMENT_METHODS), reason: z.string().trim().min(10).max(500) });

const optionalDate = z.date().nullable().optional();
export const variantInput = z.strictObject({
  sku: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
  name: name(200),
  fulfillmentMethod: z.enum(FULFILLMENT_METHODS),
  regionId: uuid.optional(),
  platformId: uuid.optional(),
  faceValue: z.number().int().positive().max(1_000_000_000).optional(),
  faceCurrency: z.string().regex(/^[A-Z]{3}$/).optional(),
  durationDays: z.number().int().min(1).max(3660).optional(),
  attrs: attrsSchema.optional(),
  price: z.number(), // validated through platform/money (integer Rial, multiple of 10)
  salePrice: z.number().nullable().optional(),
  saleStartsAt: optionalDate,
  saleEndsAt: optionalDate,
});
/** NOTE: `fulfillmentMethod` is deliberately NOT updatable here — it changes only through the protected `changeFulfillmentMethod`. */
export const variantUpdate = z.strictObject({
  name: name(200).optional(), regionId: uuid.nullable().optional(), platformId: uuid.nullable().optional(), faceValue: z.number().int().positive().max(1_000_000_000).nullable().optional(),
  faceCurrency: z.string().regex(/^[A-Z]{3}$/).nullable().optional(), durationDays: z.number().int().min(1).max(3660).nullable().optional(),
  attrs: attrsSchema.optional(),
});

export interface PriceInput { price: Rial; salePrice: Rial | null; saleStartsAt: Date | null; saleEndsAt: Date | null }

/** Validate a price change with the shared Rial primitives (no second money implementation). */
export function parsePrice(i: { price: number; salePrice?: number | null | undefined; saleStartsAt?: Date | null | undefined; saleEndsAt?: Date | null | undefined }): PriceInput {
  const price = rialPrice(i.price);
  const salePrice = i.salePrice == null ? null : rialPrice(i.salePrice);
  const saleStartsAt = i.saleStartsAt ?? null;
  const saleEndsAt = i.saleEndsAt ?? null;
  if (salePrice === null && (saleStartsAt || saleEndsAt)) throw new DomainError("CATALOG_INVALID", "a sale window needs a sale price");
  if (salePrice !== null && (salePrice <= 0 || salePrice >= price)) throw new DomainError("CATALOG_INVALID", "sale price must be above zero and below the regular price");
  if (saleStartsAt && saleEndsAt && saleEndsAt <= saleStartsAt) throw new DomainError("CATALOG_INVALID", "sale window must end after it starts");
  return { price, salePrice, saleStartsAt, saleEndsAt };
}

export function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input);
  if (!r.success) throw new DomainError("CATALOG_INVALID", `invalid input: ${r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  return r.data;
}

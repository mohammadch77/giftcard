import { DomainError } from "@/platform/errors";

/**
 * Iranian mobile numbers only (V1 decision). Accepts 0912…, 912…, 98912…, +98912…, 0098912…,
 * Persian/Arabic digits, spaces, dashes, dots and parentheses. Canonical form: +989XXXXXXXXX.
 */
const PERSIAN = /[۰-۹]/g;
const ARABIC = /[٠-٩]/g;
export const PHONE_RE = /^\+989\d{9}$/;

export function tryNormalizePhone(raw: string): string | null {
  if (typeof raw !== "string" || raw.length > 40) return null;
  let v = raw.normalize("NFKC").replace(PERSIAN, (c) => String(c.charCodeAt(0) - 0x06f0)).replace(ARABIC, (c) => String(c.charCodeAt(0) - 0x0660));
  v = v.replace(/[\s\-().​-‏‪-‮⁦-⁩﻿]/g, "");
  if (!/^\+?\d+$/.test(v)) return null;
  if (v.startsWith("+")) v = v.slice(1);
  if (v.startsWith("0098")) v = v.slice(4);
  else if (v.startsWith("98")) v = v.slice(2);
  else if (v.startsWith("0")) v = v.slice(1);
  const e164 = `+98${v}`;
  return PHONE_RE.test(e164) ? e164 : null;
}

export function normalizePhone(raw: string): string {
  const p = tryNormalizePhone(raw);
  if (!p) throw new DomainError("PHONE_INVALID", "not a valid Iranian mobile number");
  return p;
}

/** Support-facing masking: +989123456789 -> +98912***6789. */
export function maskPhone(e164: string): string {
  return PHONE_RE.test(e164) ? `${e164.slice(0, 6)}***${e164.slice(-4)}` : "***";
}

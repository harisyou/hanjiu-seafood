export type CheckoutFingerprintItem = {
  variant_id: string;
  quantity: number;
  supply_type?: "in_stock" | "preorder";
  processing_preset_id?: string | null;
  processing_option_ids?: string[] | null;
  processing_note?: string | null;
};

export type CheckoutFingerprintInput = {
  customer_name: string;
  phone: string;
  email?: string | null;
  fulfillment: string;
  note?: string | null;
  items: CheckoutFingerprintItem[];
};

export const CHECKOUT_IDEMPOTENCY_STORAGE_KEY = "hanjiu-checkout-submission-v1";

type CheckoutRetryState = { key: string; fingerprint: string };

function normalizedText(value: string | null | undefined) {
  return value?.trim() || null;
}

// PostgreSQL left(text, n) counts text characters, not JavaScript UTF-16 code units.
// Array.from keeps astral Unicode characters intact so browser retry identity matches
// the server's canonical payload even for emoji or non-BMP customer notes.
function postgresLeft(value: string, length: number) {
  return Array.from(value).slice(0, length).join("");
}

export function canonicalizeCheckoutRequest(input: CheckoutFingerprintInput) {
  return {
    customer_name: postgresLeft(input.customer_name.trim(), 100) || null,
    phone: input.phone.replace(/\D/g, ""),
    email: normalizedText(input.email)?.toLowerCase() || null,
    fulfillment: input.fulfillment,
    note: normalizedText(input.note),
    items: input.items
      .map((item) => ({
        variant_id: item.variant_id.toLowerCase(),
        quantity: Number(item.quantity),
        supply_type: item.supply_type || "in_stock",
        processing_preset_id: normalizedText(item.processing_preset_id),
        processing_option_ids: [...new Set(item.processing_option_ids || [])].sort(),
        processing_note: normalizedText(item.processing_note) ? postgresLeft(normalizedText(item.processing_note)!, 500) : null
      }))
      // Canonical UUIDs are lowercase ASCII hex. Code-unit ordering therefore matches
      // PostgreSQL UUID ordering without locale-dependent localeCompare behavior.
      .sort((left, right) => left.variant_id < right.variant_id ? -1 : left.variant_id > right.variant_id ? 1 : 0)
  };
}

export function checkoutRequestFingerprint(input: CheckoutFingerprintInput) {
  // Property and array order are fixed by canonicalizeCheckoutRequest. The database
  // independently hashes its own canonical jsonb payload; this browser value only
  // decides whether a retry lifecycle may reuse its UUID key.
  return JSON.stringify(canonicalizeCheckoutRequest(input));
}

export function checkoutRetryKey(fingerprint: string) {
  if (typeof window === "undefined") throw new Error("checkout_retry_requires_browser");
  try {
    const saved = JSON.parse(window.sessionStorage.getItem(CHECKOUT_IDEMPOTENCY_STORAGE_KEY) || "null") as CheckoutRetryState | null;
    if (saved?.key && saved.fingerprint === fingerprint) return saved.key;
  } catch {
    // A malformed session value is not trusted; replace it with a fresh lifecycle.
  }
  if (!window.crypto?.randomUUID) throw new Error("checkout_idempotency_key_unavailable");
  const key = window.crypto.randomUUID();
  window.sessionStorage.setItem(CHECKOUT_IDEMPOTENCY_STORAGE_KEY, JSON.stringify({ key, fingerprint } satisfies CheckoutRetryState));
  return key;
}

export function clearCheckoutRetryKey(key: string) {
  if (typeof window === "undefined") return;
  try {
    const saved = JSON.parse(window.sessionStorage.getItem(CHECKOUT_IDEMPOTENCY_STORAGE_KEY) || "null") as CheckoutRetryState | null;
    if (saved?.key === key) window.sessionStorage.removeItem(CHECKOUT_IDEMPOTENCY_STORAGE_KEY);
  } catch {
    window.sessionStorage.removeItem(CHECKOUT_IDEMPOTENCY_STORAGE_KEY);
  }
}

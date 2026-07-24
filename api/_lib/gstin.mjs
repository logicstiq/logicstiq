// ═══════════════════════════════════════════════════════════════════════════════════════════
// gstin.mjs — LogistiQ — GSTIN validation (format + checksum). Pure, plain-Node testable.
// Used by the Paperwork Hub and both Sourcing pages to flag invalid GSTINs before a document is
// generated. Deterministic (no AI) — a GSTIN is either valid or not.
// ─────────────────────────────────────────────────────────────────────────────
const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
// 2 state digits · 10-char PAN (5 letters, 4 digits, 1 letter) · entity code · 'Z' · checksum
const FORMAT = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;

// State code → state (subset; extend as needed). First 2 digits of a GSTIN.
export const GST_STATE = { '27': 'Maharashtra', '29': 'Karnataka', '07': 'Delhi', '24': 'Gujarat', '33': 'Tamil Nadu', '06': 'Haryana', '09': 'Uttar Pradesh', '19': 'West Bengal', '36': 'Telangana', '32': 'Kerala', '08': 'Rajasthan', '23': 'Madhya Pradesh', '03': 'Punjab' };

/**
 * isValidGstin(g) → { valid, reason, expected?, state? }
 * Runs the official GSTIN check-digit algorithm (modified Luhn mod 36).
 */
export function isValidGstin(g) {
  const s = (g == null ? '' : String(g)).trim().toUpperCase();
  if (!s) return { valid: false, reason: 'empty' };
  if (!FORMAT.test(s)) return { valid: false, reason: 'format' };
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const cp = CHARS.indexOf(s[i]);
    const factor = (i % 2 === 0) ? 1 : 2;
    let p = cp * factor;
    p = Math.floor(p / 36) + (p % 36);
    sum += p;
  }
  const expected = CHARS[(36 - (sum % 36)) % 36];
  const valid = expected === s[14];
  return { valid, reason: valid ? 'ok' : 'checksum', expected, state: GST_STATE[s.slice(0, 2)] || null };
}

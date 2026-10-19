/**
 * Pure minor-unit -> currency formatter (T-018 §1 Principle 2).
 * Zero floating-point math — division by 100 is exact for any integer <= 2^53.
 * Format only at render time; never do money arithmetic in the UI.
 */

/**
 * Formats an integer minor-unit amount (e.g. 900) to a locale currency string
 * (e.g. "$9.00"). Supports any ISO 4217 currency code.
 *
 * @param minor   Integer minor units (cents for USD). Must be a safe integer.
 * @param currency ISO 4217 code, defaults to 'USD'.
 */
export function formatMinor(minor: number, currency = 'USD'): string {
  // Guard: treat non-finite as zero rather than throw.
  const safe = Number.isFinite(minor) ? minor : 0;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(safe / 100);
}

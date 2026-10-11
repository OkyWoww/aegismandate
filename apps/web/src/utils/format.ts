/**
 * Currency and date formatting utilities for MandatePay (spec.md §1, rule.md §2.2)
 * All monetary amounts in MandatePay are stored in integer minor units (USD cents).
 */

export function formatMinorUnits(amountMinor: number, currency = 'USD'): string {
  if (isNaN(amountMinor)) {
    return '$0.00';
  }
  const dollars = amountMinor / 100;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(dollars);
}

export function formatDateTime(isoString: string): string {
  try {
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return isoString;
    return d.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
  } catch {
    return isoString;
  }
}

export function formatRelativeTime(isoString: string, now = new Date()): string {
  try {
    const target = new Date(isoString);
    const diffMs = target.getTime() - now.getTime();
    if (diffMs <= 0) return 'Expired';
    const hours = Math.floor(diffMs / 3600000);
    const mins = Math.floor((diffMs % 3600000) / 60000);
    const secs = Math.floor((diffMs % 60000) / 1000);
    return `${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  } catch {
    return 'Active';
  }
}

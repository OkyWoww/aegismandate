/**
 * AuditStrip — renders directly under the 3 metric cards (T-018 §3).
 *
 * chain_valid = true  → green badge "Chain valid · head #<seq> · sha256:<first12>…"
 * chain_valid = false → high-contrast RED alert banner, never hidden (T-018 §5)
 *
 * Clicking the strip opens the full chain audit drawer (passed via onOpenDrawer).
 */

import React from 'react';
import type { DashboardAudit } from './useImpactSummary.js';

export interface AuditStripProps {
  audit: DashboardAudit | null;
  /** Called to open the AuditDrawer in "all events" mode */
  onOpenDrawer: () => void;
}

export function AuditStrip({ audit, onOpenDrawer }: AuditStripProps) {
  if (!audit) {
    // Not yet loaded — render nothing rather than a fake state.
    return null;
  }

  // Extract first 12 chars of the hash for the compact display.
  const shortHash = audit.head_hash ? audit.head_hash.slice(0, 12) : '????????????';

  if (!audit.chain_valid) {
    return (
      <div
        data-testid="chain-invalid-banner"
        className="w-full rounded-xl border border-red-500 bg-red-950 px-4 py-3 flex items-center gap-3 text-red-200 font-mono text-sm font-bold"
        role="alert"
        aria-live="assertive"
      >
        {/* Never hide this banner */}
        <span className="shrink-0 text-red-400 text-lg">⚠</span>
        <span>Chain invalid · tamper detected</span>
      </div>
    );
  }

  return (
    <button
      data-testid="chain-valid-strip"
      onClick={onOpenDrawer}
      className="w-full rounded-xl border border-emerald-800/60 bg-emerald-950/40 px-4 py-2.5 flex items-center gap-2 text-emerald-400 font-mono text-xs hover:bg-emerald-950/70 transition cursor-pointer text-left"
    >
      <span className="text-emerald-400 text-sm shrink-0">✓</span>
      <span>
        Chain valid · head #{audit.head_seq} · sha256:{shortHash}…
      </span>
    </button>
  );
}

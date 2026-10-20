/**
 * useImpactSummary — polls GET /v1/dashboard/summary?mandate_id=<id> every 1000 ms
 * while the component is visible (T-018 §4).
 *
 * States (T-018 §5):
 *   isLoading = true   before the first successful response  (render skeleton, never $0.00)
 *   isStale   = true   when a fetch fails after first load   (keep last good data + badge)
 *   error     = string when a fetch fails and there is no prior data
 */

import { useState, useEffect, useRef, useCallback } from 'react';

// ── Shape of the API response (matches server.ts summary handler) ──────────

export interface DashboardMandate {
  id: string;
  currency: string;
  total_budget_minor: number;
  captured_minor: number;
  reserved_minor: number;
  remaining_minor: number;
}

export interface DashboardBlocked {
  count: number;
  attempted_total_minor: number;
  unknown_amount_count: number;
  paypal_calls: number;
}

export interface DashboardVerified {
  count: number;
  captured_total_minor: number;
}

export interface DashboardAudit {
  head_seq: number;
  head_hash: string;
  chain_valid: boolean;
}

export interface DashboardSummary {
  mandate: DashboardMandate;
  blocked: DashboardBlocked;
  verified: DashboardVerified;
  audit: DashboardAudit;
  /** 'MOCK' when captured orders bear sandbox-mock IDs; 'LIVE' for real PayPal sandbox (rule.md §3.6) */
  execution_mode: 'MOCK' | 'LIVE';
  generated_at: string;
}

// ── Hook ───────────────────────────────────────────────────────────────────

export interface ImpactSummaryState {
  data: DashboardSummary | null;
  /** True before the first successful response — render skeleton, never $0.00. */
  isLoading: boolean;
  /** True when a fetch fails after an initial load — keep last good data. */
  isStale: boolean;
  error: string | null;
}

const POLL_INTERVAL_MS = 1000;

function getBaseUrl(): string {
  try {
    const metaEnv = (import.meta as unknown as { env?: { VITE_API_URL?: string } }).env;
    return metaEnv?.VITE_API_URL ?? '';
  } catch {
    return '';
  }
}

export function useImpactSummary(mandateId: string): ImpactSummaryState {
  const [state, setState] = useState<ImpactSummaryState>({
    data: null,
    isLoading: true,
    isStale: false,
    error: null,
  });

  // Keep a stable ref to the latest data so the error handler can reference it
  // without capturing a stale closure.
  const latestData = useRef<DashboardSummary | null>(null);

  const fetchSummary = useCallback(async () => {
    const url = `${getBaseUrl()}/v1/dashboard/summary?mandate_id=${encodeURIComponent(mandateId)}`;
    try {
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const json = (await res.json()) as DashboardSummary;
      latestData.current = json;
      setState({
        data: json,
        isLoading: false,
        isStale: false,
        error: null,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (latestData.current !== null) {
        // Error after initial load: keep last good data, mark stale.
        setState((prev) => ({ ...prev, isStale: true, error: msg }));
      } else {
        // Error before any successful load.
        setState({ data: null, isLoading: false, isStale: false, error: msg });
      }
    }
  }, [mandateId]);

  useEffect(() => {
    // Reset when mandateId changes.
    setState({ data: null, isLoading: true, isStale: false, error: null });
    latestData.current = null;

    fetchSummary();
    const id = setInterval(fetchSummary, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [fetchSummary]);

  return state;
}

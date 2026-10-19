/**
 * AuditDrawer — slide-over panel for raw audit chain events (T-018 §3).
 *
 * Filter modes:
 *   'deny'     — opened from Blocked card → only INTENT_DECIDED with verdict=DENY
 *   'captured' — opened from Verified Spend card → only ORDER_CAPTURED events
 *   'all'      — opened from AuditStrip → all chain events for the mandate
 *
 * Fetches GET /v1/audit/events?mandate_id=<id>&limit=50 once when opened.
 * The server already supports mandate_id and type filtering (server.ts line 686-689).
 */

import React, { useEffect, useState } from 'react';
import type { AuditEventItem } from '../../api/client.js';

export type DrawerFilter = 'deny' | 'captured' | 'all';

export interface AuditDrawerProps {
  mandateId: string;
  filter: DrawerFilter;
  isOpen: boolean;
  onClose: () => void;
}

interface FetchState {
  events: AuditEventItem[];
  isLoading: boolean;
  error: string | null;
}

function getBaseUrl(): string {
  try {
    const metaEnv = (import.meta as unknown as { env?: { VITE_API_URL?: string } }).env;
    return metaEnv?.VITE_API_URL ?? '';
  } catch {
    return '';
  }
}

function buildUrl(mandateId: string, filter: DrawerFilter): string {
  const params = new URLSearchParams({ mandate_id: mandateId, limit: '50' });
  // Server supports ?type= to filter by event type.
  if (filter === 'captured') {
    params.set('type', 'ORDER_CAPTURED');
  }
  // For 'deny' we filter client-side after fetching INTENT_DECIDED events
  // because the server type filter is an exact match on `type`, and the
  // verdict lives inside the payload.  We add type=INTENT_DECIDED to reduce
  // the result set.
  if (filter === 'deny') {
    params.set('type', 'INTENT_DECIDED');
  }
  return `${getBaseUrl()}/v1/audit/events?${params.toString()}`;
}

function filterEvents(events: AuditEventItem[], filter: DrawerFilter): AuditEventItem[] {
  if (filter === 'deny') {
    return events.filter((e) => {
      const payload = e.payload as Record<string, unknown>;
      return payload?.['verdict'] === 'DENY';
    });
  }
  // 'all' and 'captured' are already server-filtered.
  return events;
}

function drawerTitle(filter: DrawerFilter): string {
  if (filter === 'deny') return 'Blocked Intents (DENY decisions)';
  if (filter === 'captured') return 'Verified Spend (ORDER_CAPTURED events)';
  return 'Full Audit Chain';
}

function formatTs(ts: string): string {
  try {
    return new Date(ts).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
  } catch {
    return ts;
  }
}

export function AuditDrawer({ mandateId, filter, isOpen, onClose }: AuditDrawerProps) {
  const [fetchState, setFetchState] = useState<FetchState>({
    events: [],
    isLoading: false,
    error: null,
  });

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setFetchState({ events: [], isLoading: true, error: null });

    fetch(buildUrl(mandateId, filter))
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<{ events: AuditEventItem[] }>;
      })
      .then((json) => {
        if (cancelled) return;
        const filtered = filterEvents(json.events ?? [], filter);
        setFetchState({ events: filtered, isLoading: false, error: null });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setFetchState({
          events: [],
          isLoading: false,
          error: err instanceof Error ? err.message : String(err),
        });
      });

    return () => {
      cancelled = true;
    };
  }, [isOpen, mandateId, filter]);

  if (!isOpen) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-slate-950/70 z-40"
        onClick={onClose}
        data-testid="drawer-backdrop"
      />

      {/* Panel */}
      <aside
        className="fixed top-0 right-0 h-full w-full max-w-xl bg-slate-900 border-l border-slate-800 z-50 flex flex-col shadow-2xl"
        data-testid="audit-drawer"
        role="dialog"
        aria-label={drawerTitle(filter)}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800">
          <h2 className="font-semibold text-white text-sm">{drawerTitle(filter)}</h2>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-white transition text-xl leading-none cursor-pointer"
            aria-label="Close drawer"
          >
            ×
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-2 font-mono text-xs">
          {fetchState.isLoading && (
            <p className="text-slate-400" data-testid="drawer-loading">
              Loading events…
            </p>
          )}

          {fetchState.error && !fetchState.isLoading && (
            <p className="text-red-400" data-testid="drawer-error">
              Failed to load events: {fetchState.error}
            </p>
          )}

          {!fetchState.isLoading && !fetchState.error && fetchState.events.length === 0 && (
            <p className="text-slate-500" data-testid="drawer-empty">
              No matching events.
            </p>
          )}

          {fetchState.events.map((ev) => (
            <div
              key={ev.seq}
              className="bg-slate-950 rounded-xl border border-slate-800 p-3 space-y-1"
              data-testid={`event-row-${ev.seq}`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-blue-400 font-bold">#{ev.seq}</span>
                <span className="text-slate-400 shrink-0">{formatTs(ev.ts)}</span>
              </div>
              <div className="flex flex-wrap gap-2">
                <span className="text-emerald-400 font-semibold">{ev.type}</span>
                <span className="text-slate-500">{ev.actor}</span>
              </div>
              <div className="text-slate-300 break-all">
                {typeof ev.payload === 'object'
                  ? JSON.stringify(ev.payload, null, 0)
                  : String(ev.payload)}
              </div>
              <div className="text-slate-600 break-all text-[10px]">
                hash: {ev.hash}
              </div>
            </div>
          ))}
        </div>
      </aside>
    </>
  );
}

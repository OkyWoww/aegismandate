/**
 * ImpactHero — composes the 3 MetricCards, AuditStrip, and AuditDrawer (T-018 §3).
 *
 * Layout: 3 cards in a single desktop row (stacked on narrow screens), then AuditStrip.
 * Cards:
 *   1. Protected Budget  — remaining_minor of total_budget_minor
 *   2. Blocked           — blocked.attempted_total_minor
 *   3. Verified Spend    — verified.captured_total_minor
 *
 * Empty state: all amounts zero and all counts zero → show "—" / "No activity yet".
 * Stale: API down after initial load → keep last data + "stale · retrying" badge.
 */

import React, { useState } from 'react';
import { MetricCard } from './MetricCard.js';
import { AuditStrip } from './AuditStrip.js';
import { AuditDrawer, type DrawerFilter } from './AuditDrawer.js';
import { useImpactSummary } from './useImpactSummary.js';
import { formatMinor } from './format.js';

export interface ImpactHeroProps {
  mandateId: string;
}

export function ImpactHero({ mandateId }: ImpactHeroProps) {
  const { data, isLoading, isStale } = useImpactSummary(mandateId);

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerFilter, setDrawerFilter] = useState<DrawerFilter>('all');

  function openDrawer(filter: DrawerFilter) {
    setDrawerFilter(filter);
    setDrawerOpen(true);
  }

  // ── Determine empty state ────────────────────────────────────────────────
  const isEmpty =
    data !== null &&
    data.mandate.captured_minor === 0 &&
    data.mandate.reserved_minor === 0 &&
    data.blocked.count === 0 &&
    data.verified.count === 0;

  // ── Protected Budget card ────────────────────────────────────────────────
  const currency = data?.mandate.currency ?? 'USD';

  const budgetValue = data
    ? `${formatMinor(data.mandate.remaining_minor, currency)} of ${formatMinor(data.mandate.total_budget_minor, currency)}`
    : '';

  const budgetSubLine = data
    ? data.mandate.reserved_minor > 0
      ? `Reserved ${formatMinor(data.mandate.reserved_minor, currency)} pending approval`
      : 'Mandate cap active'
    : '';

  // ── Blocked card ─────────────────────────────────────────────────────────
  const blockedValue = data
    ? formatMinor(data.blocked.attempted_total_minor, currency)
    : '';

  // Finding #5: "attempted & blocked" wording to distinguish attempt from block (T-018 audit)
  const blockedSubLine = data
    ? `${data.blocked.count} attack${data.blocked.count === 1 ? '' : 's'} attempted & blocked · ${data.blocked.paypal_calls} PayPal call${data.blocked.paypal_calls === 1 ? '' : 's'}${data.blocked.unknown_amount_count > 0 ? ` (${data.blocked.unknown_amount_count} unparsed)` : ''}`
    : '';

  // ── Verified Spend card ───────────────────────────────────────────────────
  const isMock = data?.execution_mode === 'MOCK';

  const verifiedValue = data
    ? formatMinor(data.verified.captured_total_minor, currency)
    : '';

  // rule.md §3.6: clearly label mock seed data; never misrepresent as live PayPal sandbox capture
  const verifiedSubLine = data
    ? isMock
      ? `${data.verified.count} order${data.verified.count === 1 ? '' : 's'} captured (mock seed)`
      : `${data.verified.count} order${data.verified.count === 1 ? '' : 's'} captured via PayPal sandbox`
    : '';

  return (
    <section data-testid="impact-hero" className="space-y-3">
      {/* 3-card row */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <MetricCard
          title="Protected Budget"
          value={budgetValue}
          subLine={budgetSubLine}
          isLoading={isLoading}
          isStale={isStale}
          isEmpty={isEmpty}
        />

        <MetricCard
          title="Blocked"
          value={blockedValue}
          subLine={blockedSubLine}
          isLoading={isLoading}
          isStale={isStale}
          isEmpty={isEmpty}
          onClick={() => openDrawer('deny')}
        />

        <MetricCard
          title="Verified Spend"
          value={verifiedValue}
          subLine={verifiedSubLine}
          isLoading={isLoading}
          isStale={isStale}
          isEmpty={isEmpty}
          {...(isMock ? { badge: 'MOCK SEED' } : {})}
          onClick={() => openDrawer('captured')}
        />
      </div>

      {/* Audit strip */}
      <AuditStrip
        audit={data?.audit ?? null}
        onOpenDrawer={() => openDrawer('all')}
      />

      {/* Audit drawer (slide-over) */}
      <AuditDrawer
        mandateId={mandateId}
        filter={drawerFilter}
        isOpen={drawerOpen}
        onClose={() => setDrawerOpen(false)}
      />
    </section>
  );
}

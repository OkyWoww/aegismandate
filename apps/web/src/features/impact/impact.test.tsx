/**
 * Impact Dashboard Hero — component tests (T-018 §7 Criteria 4, 6, 7, 8, 10)
 *
 * All tests use renderToString (react-dom/server) to stay compatible with the
 * existing vitest node environment (no jsdom required).
 *
 * Criteria covered:
 *   Criterion 4  — skeleton rendered before first data (no $0.00 flash)
 *   Criterion 6  — empty state shows "—" / "No activity yet"
 *   Criterion 8  — stale badge when fetch fails after initial load
 *                  red banner when chain_valid === false
 *   Criterion 10 — reserved sub-line when reserved_minor > 0
 */

import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';

import { formatMinor } from './format.js';
import { MetricCard } from './MetricCard.js';
import { AuditStrip } from './AuditStrip.js';
import { AuditDrawer } from './AuditDrawer.js';
import type { DashboardAudit } from './useImpactSummary.js';

// ─────────────────────────────────────────────────────────────────────────────
// 1. formatMinor (pure unit tests — zero FP math)
// ─────────────────────────────────────────────────────────────────────────────
describe('formatMinor', () => {
  it('converts integer minor units to locale currency string', () => {
    expect(formatMinor(900, 'USD')).toBe('$9.00');
    expect(formatMinor(14600, 'USD')).toBe('$146.00');
    expect(formatMinor(20000, 'USD')).toBe('$200.00');
    expect(formatMinor(50000, 'USD')).toBe('$500.00');
    expect(formatMinor(0, 'USD')).toBe('$0.00');
  });

  it('defaults to USD when currency is omitted', () => {
    expect(formatMinor(100)).toBe('$1.00');
  });

  it('treats non-finite values as zero (no throw)', () => {
    expect(formatMinor(NaN, 'USD')).toBe('$0.00');
    expect(formatMinor(Infinity, 'USD')).toBe('$0.00');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. MetricCard — loading skeleton (Criterion 4)
// ─────────────────────────────────────────────────────────────────────────────
describe('MetricCard — loading skeleton (Criterion 4)', () => {
  it('renders skeleton elements when isLoading=true and never shows $0.00', () => {
    const html = renderToString(
      <MetricCard
        title="Protected Budget"
        value=""
        subLine=""
        isLoading={true}
        isStale={false}
        isEmpty={false}
      />,
    );

    // Skeleton placeholder must be present.
    expect(html).toContain('data-testid="skeleton"');
    // MUST NOT contain a fake $0.00 value during loading.
    expect(html).not.toContain('$0.00');
    // The metric-value span must NOT be rendered during loading.
    expect(html).not.toContain('data-testid="metric-value"');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. MetricCard — empty state (Criterion 6)
// ─────────────────────────────────────────────────────────────────────────────
describe('MetricCard — empty state (Criterion 6)', () => {
  it('shows em dash and "No activity yet" when isEmpty=true', () => {
    const html = renderToString(
      <MetricCard
        title="Blocked"
        value="$0.00"
        subLine=""
        isLoading={false}
        isStale={false}
        isEmpty={true}
      />,
    );

    expect(html).toContain('data-testid="empty-dash"');
    expect(html).toContain('No activity yet');
    // Must NOT render the real value — that would be misleading.
    expect(html).not.toContain('data-testid="metric-value"');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. MetricCard — stale badge (Criterion 8)
// ─────────────────────────────────────────────────────────────────────────────
describe('MetricCard — stale badge (Criterion 8)', () => {
  it('shows "stale · retrying" badge when isStale=true with existing data', () => {
    const html = renderToString(
      <MetricCard
        title="Verified Spend"
        value="$9.00"
        subLine="1 order captured (mock seed)"
        isLoading={false}
        isStale={true}
        isEmpty={false}
      />,
    );

    expect(html).toContain('data-testid="stale-badge"');
    // The last good data must still be visible.
    expect(html).toContain('data-testid="metric-value"');
  });

  it('does NOT show stale badge when data is fresh', () => {
    const html = renderToString(
      <MetricCard
        title="Verified Spend"
        value="$9.00"
        subLine="1 order captured"
        isLoading={false}
        isStale={false}
        isEmpty={false}
      />,
    );

    expect(html).not.toContain('data-testid="stale-badge"');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. MetricCard — reserved sub-line (Criterion 10 / spec §3 + §7 Criterion 4)
// ─────────────────────────────────────────────────────────────────────────────
describe('MetricCard — reserved sub-line (Criterion 10)', () => {
  it('shows "Reserved $X pending approval" when reserved_minor > 0', () => {
    const reservedMinor = 4500;
    const subLine = `Reserved ${formatMinor(reservedMinor, 'USD')} pending approval`;

    const html = renderToString(
      <MetricCard
        title="Protected Budget"
        value={`${formatMinor(14600, 'USD')} of ${formatMinor(20000, 'USD')}`}
        subLine={subLine}
        isLoading={false}
        isStale={false}
        isEmpty={false}
      />,
    );

    expect(html).toContain('Reserved');
    expect(html).toContain('pending approval');
    // The formatted amount must be present in the sub-line.
    expect(html).toContain(formatMinor(reservedMinor, 'USD'));
  });

  it('shows "Mandate cap active" when reserved_minor === 0', () => {
    const html = renderToString(
      <MetricCard
        title="Protected Budget"
        value={`${formatMinor(19100, 'USD')} of ${formatMinor(20000, 'USD')}`}
        subLine="Mandate cap active"
        isLoading={false}
        isStale={false}
        isEmpty={false}
      />,
    );

    expect(html).toContain('Mandate cap active');
    expect(html).not.toContain('pending approval');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. AuditStrip — chain_valid states (Criterion 8)
// ─────────────────────────────────────────────────────────────────────────────
describe('AuditStrip — chain_valid states (Criterion 8)', () => {
  const validAudit: DashboardAudit = {
    head_seq: 42,
    head_hash: 'ab12cd34ef56789012ab',
    chain_valid: true,
  };

  const invalidAudit: DashboardAudit = {
    head_seq: 42,
    head_hash: 'ab12cd34ef56789012ab',
    chain_valid: false,
  };

  it('renders green chain-valid strip when chain_valid=true', () => {
    const html = renderToString(
      <AuditStrip audit={validAudit} onOpenDrawer={() => undefined} />,
    );

    expect(html).toContain('data-testid="chain-valid-strip"');
    expect(html).toContain('Chain valid');
    // SSR wraps interpolated values in comment nodes: `#<!-- -->42<!-- -->`
    expect(html).toContain('42');
    // First 12 chars of head_hash
    expect(html).toContain('ab12cd34ef56');
    expect(html).not.toContain('data-testid="chain-invalid-banner"');
  });

  it('renders high-contrast red banner when chain_valid=false — never hidden', () => {
    const html = renderToString(
      <AuditStrip audit={invalidAudit} onOpenDrawer={() => undefined} />,
    );

    expect(html).toContain('data-testid="chain-invalid-banner"');
    expect(html).toContain('Chain invalid');
    expect(html).toContain('tamper detected');
    expect(html).not.toContain('data-testid="chain-valid-strip"');
  });

  it('renders nothing while audit data is null (before first fetch)', () => {
    const html = renderToString(
      <AuditStrip audit={null} onOpenDrawer={() => undefined} />,
    );

    // Nothing visible yet — no green, no red.
    expect(html).not.toContain('Chain valid');
    expect(html).not.toContain('Chain invalid');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. AuditDrawer — closed state renders nothing
// ─────────────────────────────────────────────────────────────────────────────
describe('AuditDrawer — closed state', () => {
  it('renders nothing when isOpen=false', () => {
    const html = renderToString(
      <AuditDrawer
        mandateId="mnd_test_01"
        filter="all"
        isOpen={false}
        onClose={() => undefined}
      />,
    );

    expect(html).toBe('');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. MetricCard — MOCK SEED badge (Finding #2 / rule.md §3.6)
// ─────────────────────────────────────────────────────────────────────────────
describe('MetricCard — MOCK SEED badge (rule.md §3.6)', () => {
  it('shows "MOCK SEED" badge when badge prop is provided', () => {
    const html = renderToString(
      <MetricCard
        title="Verified Spend"
        value="$9.00"
        subLine="1 order captured (mock seed)"
        isLoading={false}
        isStale={false}
        isEmpty={false}
        badge="MOCK SEED"
      />,
    );

    expect(html).toContain('data-testid="mode-badge"');
    expect(html).toContain('MOCK SEED');
    // Must still show the value
    expect(html).toContain('data-testid="metric-value"');
  });

  it('does NOT show mode badge when badge prop is omitted', () => {
    const html = renderToString(
      <MetricCard
        title="Verified Spend"
        value="$9.00"
        subLine="1 order captured via PayPal sandbox"
        isLoading={false}
        isStale={false}
        isEmpty={false}
      />,
    );

    expect(html).not.toContain('data-testid="mode-badge"');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. MetricCard — blocked sub-line copy (Finding #3)
// ─────────────────────────────────────────────────────────────────────────────
describe('MetricCard — blocked sub-line wording (Finding #3)', () => {
  it('sub-line says "attempted & blocked" not just "blocked"', () => {
    const html = renderToString(
      <MetricCard
        title="Blocked"
        value="$500.00"
        subLine="1 attack attempted & blocked · 0 PayPal calls"
        isLoading={false}
        isStale={false}
        isEmpty={false}
      />,
    );

    expect(html).toContain('attempted &amp; blocked');
    expect(html).not.toContain('attacks blocked ·');
  });
});


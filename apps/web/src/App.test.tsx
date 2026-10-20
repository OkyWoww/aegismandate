import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { formatMinorUnits, formatDateTime, formatRelativeTime } from './utils/format.js';
import { MandateOverviewCard } from './components/MandateOverviewCard.js';
import { StepUpApprovalsQueue, type PendingStepUpProposal } from './components/StepUpApprovalsQueue.js';
import { AuditLedgerFeed } from './components/AuditLedgerFeed.js';
import { AttackSimulationConsole } from './components/AttackSimulationConsole.js';
import { App } from './App.js';
import type { MandateResponse, AuditEventItem } from './api/client.js';

describe('MandatePay Dashboard & Web UI (Task T-015, specs/design.md §9, demo.md §2-§4)', () => {
  // --------------------------------------------------------------------------
  // 1. Currency & Formatter Unit Tests
  // --------------------------------------------------------------------------
  describe('Currency & Unit Formatters (formatMinorUnits)', () => {
    it('strictly converts integer minor units (cents) to formatted USD strings ($X.XX)', () => {
      expect(formatMinorUnits(0)).toBe('$0.00');
      expect(formatMinorUnits(900)).toBe('$9.00');
      expect(formatMinorUnits(1400)).toBe('$14.00');
      expect(formatMinorUnits(4500)).toBe('$45.00');
      expect(formatMinorUnits(32000)).toBe('$320.00');
      expect(formatMinorUnits(50000)).toBe('$500.00');
    });

    it('handles NaN or invalid inputs gracefully', () => {
      expect(formatMinorUnits(NaN)).toBe('$0.00');
    });

    it('formats relative TTL countdown correctly', () => {
      const future = new Date(Date.now() + 3600000 + 120000).toISOString(); // ~1h 2m
      const countdown = formatRelativeTime(future);
      expect(countdown).toMatch(/^\d{2}:\d{2}:\d{2}$/);

      const past = new Date(Date.now() - 5000).toISOString();
      expect(formatRelativeTime(past)).toBe('Expired');
    });

    it('formats date timestamps', () => {
      const formatted = formatDateTime('2026-10-20T10:00:00Z');
      expect(typeof formatted).toBe('string');
      expect(formatted.length).toBeGreaterThan(0);
    });
  });

  // --------------------------------------------------------------------------
  // 2. Mandate Overview Card Component
  // --------------------------------------------------------------------------
  describe('MandateOverviewCard Component', () => {
    const mockMandate: MandateResponse = {
      mandate: {
        mandate_id: 'mnd_render_test_01',
        version: 1,
        owner_id: 'usr_test_owner',
        agent_id: 'agt_test_agent',
        status: 'ACTIVE',
        currency: 'USD',
        valid_from: '2026-10-20T00:00:00Z',
        valid_until: '2026-10-20T12:00:00Z',
        total_budget_minor: 20000,
        per_txn_limit_minor: 8000,
        auto_approve_limit_minor: 3000,
        max_txns_per_hour: 4,
        allowed_merchants: ['mrc_demo_store'],
        allowed_categories: ['office_supplies'],
        max_items_per_intent: 5,
        max_pending_approvals: 3,
        signature: 'hmac-sha256:7f9a12c84918e932bfa1205391dc',
      },
      spend: {
        mandate_id: 'mnd_render_test_01',
        captured_minor: 900,
        reserved_minor: 4500,
        committed_minor: 5400,
        remaining_minor: 14600,
        total_budget_minor: 20000,
        currency: 'USD',
        updated_at: '2026-10-20T01:00:00Z',
      },
    };

    it('renders mandate parameters, active status, and formatted currency caps', () => {
      const html = renderToString(<MandateOverviewCard mandateData={mockMandate} />);

      expect(html).toContain('mnd_render_test_01');
      expect(html).toContain('ACTIVE');
      expect(html).toContain('$146.00'); // Remaining budget
      expect(html).toContain('$200.00'); // Total budget
      expect(html).toContain('$30.00');  // Auto-approve cap
      expect(html).toContain('$80.00');  // Per-txn limit
      expect(html).toContain('mrc_demo_store');
      expect(html).toContain('office_supplies');
    });

    it('renders suspended alert when mandate status is SUSPENDED', () => {
      const suspendedMandate: MandateResponse = {
        ...mockMandate,
        mandate: { ...mockMandate.mandate, status: 'SUSPENDED' },
      };
      const html = renderToString(<MandateOverviewCard mandateData={suspendedMandate} />);
      expect(html).toContain('SUSPENDED');
    });
  });

  // --------------------------------------------------------------------------
  // 3. Step-Up Approvals Queue Component
  // --------------------------------------------------------------------------
  describe('StepUpApprovalsQueue Component', () => {
    const mockProposals: PendingStepUpProposal[] = [
      {
        intentId: 'int_lamp_test_01',
        merchantRef: 'mrc_demo_store',
        items: [
          {
            sku: 'SKU-DESK-LAMP',
            name: 'Architect LED Desk Lamp',
            qty: 1,
            unitPriceMinor: 4500,
          },
        ],
        totalMinor: 4500,
        currency: 'USD',
        rationale: 'Desk lamp for studio workbench',
        reasonCodes: ['OVER_AUTO_LIMIT'],
        payloadHash: 'a718f430b8d8102384a1c5d9018e47bf10283c7104b610fa7284918c57102e81',
        riskScore: 15,
      },
    ];

    it('renders pending proposal with itemized prices and payload hash binding', () => {
      const html = renderToString(<StepUpApprovalsQueue proposals={mockProposals} />);

      expect(html).toContain('int_lamp_test_01');
      expect(html).toContain('SKU-DESK-LAMP');
      expect(html).toContain('Architect LED Desk Lamp');
      expect(html).toContain('$45.00');
      expect(html).toContain('OVER_AUTO_LIMIT');
      expect(html).toContain('a718f430b8d8102384a1c5d9018e47bf10283c7104b610fa7284918c57102e81');
      expect(html).toContain('Approve &amp; Authorize PayPal');
    });

    it('renders empty queue state when no proposals are pending', () => {
      const html = renderToString(<StepUpApprovalsQueue proposals={[]} />);
      expect(html).toContain('No step-up approvals pending review');
    });

    it('renders owner key toggle button in "no key" state when sessionStorage is empty (SSR / first visit)', () => {
      // In Node/SSR there is no window.sessionStorage, so readSessionToken() returns ''.
      const html = renderToString(<StepUpApprovalsQueue proposals={mockProposals} />);

      // The key toggle button must always be present
      expect(html).toContain('data-testid="owner-key-toggle"');
      // No key stored → button must say "No Owner Key", never expose a hardcoded secret
      expect(html).toContain('No Owner Key');
      expect(html).not.toContain('Owner Key Set');
      // The key input panel is hidden by default (not rendered until toggled or approve clicked)
      expect(html).not.toContain('data-testid="owner-key-input-panel"');
      // Absolutely no secret must appear anywhere in the rendered output
      expect(html).not.toContain('mp_owner_sec_');
    });

    it('renders approve button with correct data-testid for programmatic access', () => {
      const html = renderToString(<StepUpApprovalsQueue proposals={mockProposals} />);

      expect(html).toContain('data-testid="approve-btn-int_lamp_test_01"');
      // No status panel shown initially
      expect(html).not.toContain('data-testid="status-captured-int_lamp_test_01"');
      expect(html).not.toContain('data-testid="status-awaiting-int_lamp_test_01"');
      expect(html).not.toContain('data-testid="status-failed-int_lamp_test_01"');
    });
  });

  // --------------------------------------------------------------------------
  // 4. Audit Ledger Feed Component
  // --------------------------------------------------------------------------
  describe('AuditLedgerFeed Component', () => {
    const mockAuditEvents: AuditEventItem[] = [
      {
        seq: 1,
        ts: '2026-10-20T08:00:00Z',
        actor: 'control_plane',
        type: 'MANDATE_CREATED',
        ref: 'mnd_test_01',
        payload: { owner: 'usr_test' },
        prev_hash: '0000000000000000000000000000000000000000000000000000000000000000',
        hash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      },
      {
        seq: 2,
        ts: '2026-10-20T08:01:00Z',
        actor: 'agent',
        type: 'INTENT_RECEIVED',
        ref: 'int_test_01',
        payload: { claimed_total_minor: 900 },
        prev_hash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        hash: '9f83c24198fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852c001',
      },
    ];

    it('renders audit ledger feed and verify integrity action', () => {
      const html = renderToString(<AuditLedgerFeed events={mockAuditEvents} />);

      expect(html).toContain('Tamper-Evident Audit Ledger');
      expect(html).toContain('Verify Ledger Integrity');
      expect(html).toContain('MANDATE_CREATED');
      expect(html).toContain('INTENT_RECEIVED');
      expect(html).toContain('#1');
      expect(html).toContain('#2');
      expect(html).toContain('control_plane');
      expect(html).toContain('agent');
    });
  });

  // --------------------------------------------------------------------------
  // 5. Attack Simulation Console Component
  // --------------------------------------------------------------------------
  describe('AttackSimulationConsole Component', () => {
    it('renders all 4 representative test scenarios', () => {
      const html = renderToString(<AttackSimulationConsole />);

      expect(html).toContain('Attack Simulation &amp; Live Console');
      expect(html).toContain('SCENARIO-1');
      expect(html).toContain('SCENARIO-2');
      expect(html).toContain('SCENARIO-3');
      expect(html).toContain('SCENARIO-4');
      expect(html).toContain('Normal In-Mandate Purchase ($9.00)');
      expect(html).toContain('Over-Limit Step-Up Purchase ($45.00)');
      expect(html).toContain('Evil Store Prompt Injection ($500.00)');
      expect(html).toContain('Direct Denial Standing Desk ($320.00)');
      expect(html).toContain('Submit Intent Proposal');
    });
  });

  // --------------------------------------------------------------------------
  // 6. Complete App Dashboard Render
  // --------------------------------------------------------------------------
  describe('App Full Dashboard Render', () => {
    it('renders complete dashboard without throwing', () => {
      const html = renderToString(<App />);

      expect(html).toContain('AegisMandate');
      expect(html).toContain('PayPal AI Hackathon');
      expect(html).toContain('Agentic Commerce Containment &amp; Mandate Control');
      expect(html).toContain('Active Financial Mandate');
      expect(html).toContain('Step-Up Approvals Queue');
      expect(html).toContain('Tamper-Evident Audit Ledger');
    });
  });
});

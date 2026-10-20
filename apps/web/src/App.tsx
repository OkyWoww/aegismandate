import React, { useState, useEffect, useCallback } from 'react';
import {
  ShieldCheck,
  Lock,
  Layers,
  Terminal,
  CheckCircle2,
  RefreshCw,
  ExternalLink,
} from 'lucide-react';
import { MandateOverviewCard } from './components/MandateOverviewCard.js';
import { StepUpApprovalsQueue, type PendingStepUpProposal } from './components/StepUpApprovalsQueue.js';
import { AuditLedgerFeed } from './components/AuditLedgerFeed.js';
import { AttackSimulationConsole } from './components/AttackSimulationConsole.js';
import { ImpactHero } from './features/impact/ImpactHero.js';
import { api, type MandateResponse, type AuditEventItem, type ProposeResponse } from './api/client.js';

const DEMO_MANDATE_ID = 'mnd_demo_001';

// Initial fallback mandate data matching demo.md §1
const INITIAL_MANDATE_DATA: MandateResponse = {
  mandate: {
    mandate_id: DEMO_MANDATE_ID,
    version: 1,
    owner_id: 'usr_demo_buyer',
    agent_id: 'agt_shopper_01',
    status: 'ACTIVE',
    currency: 'USD',
    valid_from: new Date().toISOString(),
    valid_until: new Date(Date.now() + 12 * 3600 * 1000).toISOString(),
    total_budget_minor: 20000,
    per_txn_limit_minor: 8000,
    auto_approve_limit_minor: 3000,
    max_txns_per_hour: 3,
    allowed_merchants: ['mrc_demo_store'],
    allowed_categories: ['office_supplies', 'books'],
    max_items_per_intent: 5,
    max_pending_approvals: 3,
    signature: 'hmac-sha256:7f9a12c84918e932bfa1205391dc',
  },
  spend: {
    mandate_id: DEMO_MANDATE_ID,
    captured_minor: 900,
    reserved_minor: 4500,
    committed_minor: 5400,
    remaining_minor: 14600,
    total_budget_minor: 20000,
    currency: 'USD',
    updated_at: new Date().toISOString(),
  },
};

// Initial seeded step-up proposal for demo ($45.00 Architect Lamp)
const INITIAL_STEP_UP_PROPOSALS: PendingStepUpProposal[] = [
  {
    intentId: 'int_stepup_lamp_demo',
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
    rationale: 'Purchase architect desk lamp with clamp mount and color temperature adjustments',
    reasonCodes: ['OVER_AUTO_LIMIT'],
    payloadHash: 'a718f430b8d8102384a1c5d9018e47bf10283c7104b610fa7284918c57102e81',
    riskScore: 20,
  },
];

// Initial seeded audit events
const INITIAL_AUDIT_EVENTS: AuditEventItem[] = [
  {
    seq: 1,
    ts: new Date(Date.now() - 3600000).toISOString(),
    actor: 'control_plane',
    type: 'MANDATE_CREATED',
    ref: DEMO_MANDATE_ID,
    payload: { owner_id: 'usr_demo_buyer', budget_minor: 20000, currency: 'USD' },
    prev_hash: '0000000000000000000000000000000000000000000000000000000000000000',
    hash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  },
  {
    seq: 2,
    ts: new Date(Date.now() - 3500000).toISOString(),
    actor: 'control_plane',
    type: 'MANDATE_ACTIVATED',
    ref: DEMO_MANDATE_ID,
    payload: { status: 'ACTIVE', version: 1 },
    prev_hash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    hash: '9f83c24198fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852c001',
  },
  {
    seq: 3,
    ts: new Date(Date.now() - 1800000).toISOString(),
    actor: 'agent',
    type: 'INTENT_RECEIVED',
    ref: 'int_pen_pack_01',
    payload: { merchant_ref: 'mrc_demo_store', claimed_total_minor: 900 },
    prev_hash: '9f83c24198fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852c001',
    hash: '8a12c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852d002',
  },
  {
    seq: 4,
    ts: new Date(Date.now() - 1795000).toISOString(),
    actor: 'control_plane',
    type: 'INTENT_DECIDED',
    ref: 'int_pen_pack_01',
    payload: { verdict: 'ALLOW', verified_total_minor: 900 },
    prev_hash: '8a12c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852d002',
    hash: '7b23c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852e003',
  },
  {
    seq: 5,
    ts: new Date(Date.now() - 1790000).toISOString(),
    actor: 'control_plane',
    type: 'BUDGET_CAPTURED',
    ref: 'int_pen_pack_01',
    payload: { order_id: 'ORDER-PAYPAL-SANDBOX-01', capture_id: 'CAPTURE-PAYPAL-SANDBOX-01', amount_minor: 900 },
    prev_hash: '7b23c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852e003',
    hash: '6c34c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852f004',
  },
];

export function App() {
  const [activeTab, setActiveTab] = useState<'dashboard' | 'console' | 'architecture'>('dashboard');
  const [mandateData, setMandateData] = useState<MandateResponse>(INITIAL_MANDATE_DATA);
  const [pendingApprovals, setPendingApprovals] = useState<PendingStepUpProposal[]>(INITIAL_STEP_UP_PROPOSALS);
  const [auditEvents, setAuditEvents] = useState<AuditEventItem[]>(INITIAL_AUDIT_EVENTS);
  const [isConnected, setIsConnected] = useState<boolean>(false);

  // Poll real backend if available
  const loadBackendData = useCallback(async () => {
    try {
      const mandateRes = await api.getMandate(DEMO_MANDATE_ID);
      setMandateData(mandateRes);
      setIsConnected(true);
    } catch {
      setIsConnected(false);
    }

    try {
      const auditRes = await api.getAuditEvents({ limit: 50 });
      if (auditRes.events && auditRes.events.length > 0) {
        setAuditEvents(auditRes.events);
      }
    } catch {
      // Fallback
    }
  }, []);

  useEffect(() => {
    loadBackendData();
    const interval = setInterval(loadBackendData, 5000);
    return () => clearInterval(interval);
  }, [loadBackendData]);

  // Handle successful human approval
  const handleApprovalExecuted = (intentId: string) => {
    setPendingApprovals((prev) => prev.filter((p) => p.intentId !== intentId));
    loadBackendData();
  };

  // Handle simulation execution
  // Fetch payload_hash from server — never compute it in the browser (FR-28).
  const handleScenarioExecuted = async (res: ProposeResponse, sc: { amountMinor: number; payload: Record<string, unknown> }) => {
    loadBackendData();
    if (res.verdict === 'STEP_UP') {
      // Fetch the server-stored payload_hash for this intent (FR-28: must come from server, not browser)
      let payloadHash = '';
      try {
        const intentDetail = await api.getIntent(res.intent_id);
        payloadHash = intentDetail.payload_hash ?? '';
      } catch {
        // If fetch fails, leave hash empty — approve call will return 422 PAYLOAD_HASH_REQUIRED
        // which is surfaced in the UI via StepUpApprovalsQueue's statusMap.
      }

      const newProposal: PendingStepUpProposal = {
        intentId: res.intent_id,
        merchantRef: String(sc.payload['merchant_ref'] ?? 'mrc_demo_store'),
        items: (sc.payload['items'] as Array<{ sku: string; name?: string; qty: number; claimed_unit_price_minor: number }>).map((it) => ({
          sku: it.sku,
          name: it.sku === 'SKU-DESK-LAMP' ? 'Architect LED Desk Lamp' : it.sku,
          qty: it.qty,
          unitPriceMinor: it.claimed_unit_price_minor,
        })),
        totalMinor: sc.amountMinor,
        currency: 'USD',
        rationale: String(sc.payload['rationale'] ?? ''),
        reasonCodes: res.decision?.reason_codes ?? ['OVER_AUTO_LIMIT'],
        payloadHash,
        riskScore: res.decision?.risk?.score,
      };

      setPendingApprovals((prev) => [newProposal, ...prev.filter((p) => p.intentId !== res.intent_id)]);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans selection:bg-blue-600 selection:text-white">
      {/* Top Navbar */}
      <header className="border-b border-slate-800 bg-slate-900/80 backdrop-blur sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-blue-600 flex items-center justify-center text-white shadow-lg shadow-blue-500/20">
              <ShieldCheck className="w-5 h-5" />
            </div>
            <div>
              <span className="font-extrabold text-lg tracking-tight text-white">AegisMandate</span>
              <span className="ml-2 text-[10px] font-mono uppercase bg-blue-950 text-blue-400 border border-blue-800/80 px-2 py-0.5 rounded">
                PayPal AI Hackathon
              </span>
            </div>
          </div>

          <div className="flex items-center gap-3 text-xs font-mono">
            <div
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border ${
                isConnected
                  ? 'bg-emerald-950/60 border-emerald-800 text-emerald-400'
                  : 'bg-slate-900 border-slate-800 text-slate-400'
              }`}
            >
              <span
                className={`w-2 h-2 rounded-full ${
                  isConnected ? 'bg-emerald-400 animate-pulse' : 'bg-slate-500'
                }`}
              ></span>
              <span>{isConnected ? 'API Connected (:8787)' : 'Local Offline Mode'}</span>
            </div>

            <div className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-950/60 border border-amber-800/60 text-amber-300">
              <Lock className="w-3.5 h-3.5" />
              <span>Cognitive Agent: Isolated (No PayPal Keys)</span>
            </div>
          </div>
        </div>
      </header>

      {/* Hero Banner */}
      <section className="border-b border-slate-800 bg-gradient-to-b from-slate-900 via-slate-900/60 to-slate-950 px-6 py-6">
        <div className="max-w-7xl mx-auto flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="px-2 py-0.5 rounded bg-blue-950 text-blue-300 border border-blue-800 text-[11px] font-mono font-bold uppercase">
                Control Plane Dashboard
              </span>
              <span className="text-xs text-slate-500">•</span>
              <span className="text-xs font-mono text-slate-400">Spec-Driven Development (Phase 3)</span>
            </div>
            <h1 className="text-2xl md:text-3xl font-extrabold tracking-tight text-white">
              Agentic Commerce Containment & Mandate Control
            </h1>
            <p className="text-slate-400 text-xs md:text-sm max-w-3xl leading-relaxed">
              Untrusted shopper agents submit purchase intent proposals. The deterministic policy engine verifies merchant registry payees, catalog prices, budget limits, and risk before any PayPal sandbox execution.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => loadBackendData()}
              className="px-3.5 py-2 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-300 text-xs font-mono flex items-center gap-1.5 transition cursor-pointer"
              title="Refresh status"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>Sync</span>
            </button>
          </div>
        </div>
      </section>

      {/* Navigation Tabs */}
      <div className="border-b border-slate-800 bg-slate-900/40 px-6">
        <div className="max-w-7xl mx-auto flex gap-6 text-sm font-medium">
          {[
            { id: 'dashboard', label: 'Mandate & Approvals Overview', icon: Layers },
            { id: 'console', label: 'Live Attack Simulation Console', icon: Terminal },
            { id: 'architecture', label: 'Security Model & Boundary Invariants', icon: ShieldCheck },
          ].map((tab) => {
            const Icon = tab.icon;
            const active = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id as typeof activeTab)}
                className={`py-3 flex items-center gap-2 border-b-2 transition cursor-pointer ${
                  active
                    ? 'border-blue-500 text-blue-400 font-semibold'
                    : 'border-transparent text-slate-400 hover:text-slate-200'
                }`}
              >
                <Icon className="w-4 h-4" />
                <span>{tab.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Main Content */}
      <main className="max-w-7xl mx-auto px-6 py-8 flex-1 w-full space-y-8">
        {activeTab === 'dashboard' && (
          <div className="space-y-8">
            {/* 0. Impact Dashboard Hero (T-018) — additive, above existing sections */}
            <ImpactHero mandateId={DEMO_MANDATE_ID} />

            {/* 1. Mandate Overview Card */}
            <MandateOverviewCard mandateData={mandateData} onRefresh={loadBackendData} />

            {/* 2. Pending Step-Up Approvals Queue */}
            <StepUpApprovalsQueue
              proposals={pendingApprovals}
              onApproved={handleApprovalExecuted}
              onRejected={(id) => setPendingApprovals((prev) => prev.filter((p) => p.intentId !== id))}
            />

            {/* 3. Real-time Audit Ledger Feed */}
            <AuditLedgerFeed events={auditEvents} onRefreshEvents={loadBackendData} />
          </div>
        )}

        {activeTab === 'console' && (
          <div className="space-y-8">
            <AttackSimulationConsole onScenarioExecuted={handleScenarioExecuted} />

            {/* Step-Up Approvals Queue also accessible in console tab if items are queued */}
            {pendingApprovals.length > 0 && (
              <StepUpApprovalsQueue
                proposals={pendingApprovals}
                onApproved={handleApprovalExecuted}
                onRejected={(id) => setPendingApprovals((prev) => prev.filter((p) => p.intentId !== id))}
              />
            )}
          </div>
        )}

        {activeTab === 'architecture' && (
          <div className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              {/* Cognitive Plane Isolation */}
              <div className="bg-slate-900/60 border border-amber-900/40 rounded-2xl p-6 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-mono font-bold uppercase text-amber-400">Cognitive Plane</span>
                  <span className="text-[10px] px-2 py-0.5 rounded bg-amber-950 text-amber-300 border border-amber-800">
                    Untrusted Runtime
                  </span>
                </div>
                <h3 className="text-base font-bold text-white">Shopper Agent (apps/agent)</h3>
                <p className="text-xs text-slate-400 leading-relaxed">
                  Processes user prompts and browses untrusted web content. Strictly isolated by compile-time and lint-time boundary rules: zero PayPal dependencies or credentials permitted.
                </p>
                <div className="p-3 bg-slate-950 rounded-xl border border-slate-800 font-mono text-[11px] text-slate-300 space-y-1">
                  <div className="text-emerald-400 font-semibold flex items-center gap-1.5">
                    <CheckCircle2 className="w-3.5 h-3.5" /> INV-1 / AC-7 Verified
                  </div>
                  <div>Only submits: <span className="text-amber-400">PurchaseIntentProposal</span></div>
                </div>
              </div>

              {/* Policy Containment Plane */}
              <div className="bg-slate-900/60 border border-blue-900/40 rounded-2xl p-6 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-mono font-bold uppercase text-blue-400">Control Plane</span>
                  <span className="text-[10px] px-2 py-0.5 rounded bg-blue-950 text-blue-300 border border-blue-800">
                    Pure Policy Engine
                  </span>
                </div>
                <h3 className="text-base font-bold text-white">Rules Engine P-00 to P-12</h3>
                <p className="text-xs text-slate-400 leading-relaxed">
                  100% deterministic pure function with strict rule precedence (DENY &gt; STEP_UP &gt; ALLOW). Re-verifies merchant payees and catalog prices server-side, eliminating TOCTOU attacks.
                </p>
                <div className="p-3 bg-slate-950 rounded-xl border border-slate-800 font-mono text-[11px] text-slate-300 space-y-1">
                  <div className="text-emerald-400 font-semibold flex items-center gap-1.5">
                    <CheckCircle2 className="w-3.5 h-3.5" /> 13 Deterministic Rules
                  </div>
                  <div>Precedence: <span className="text-blue-400">DENY &gt; STEP_UP &gt; ALLOW</span></div>
                </div>
              </div>

              {/* PayPal Execution Plane */}
              <div className="bg-slate-900/60 border border-emerald-900/40 rounded-2xl p-6 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-mono font-bold uppercase text-emerald-400">Settlement Plane</span>
                  <span className="text-[10px] px-2 py-0.5 rounded bg-emerald-950 text-emerald-300 border border-emerald-800">
                    PayPal Sandbox
                  </span>
                </div>
                <h3 className="text-base font-bold text-white">Hardened Executor</h3>
                <p className="text-xs text-slate-400 leading-relaxed">
                  Executes orders with deterministic idempotency keys, atomic reservation accounting, and payload-hash binding verification. Records every state change in the tamper-evident ledger.
                </p>
                <div className="p-3 bg-slate-950 rounded-xl border border-slate-800 font-mono text-[11px] text-slate-300 space-y-1">
                  <div className="text-emerald-400 font-semibold flex items-center gap-1.5">
                    <CheckCircle2 className="w-3.5 h-3.5" /> Plan B Locked Architecture
                  </div>
                  <div>Idempotency: <span className="text-emerald-400">PayPal-Request-Id</span></div>
                </div>
              </div>
            </div>

            {/* Invariant Verification Table */}
            <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-6 space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-base font-bold text-white">Security Invariants & Architectural Guarantees</h3>
                  <p className="text-xs text-slate-400">Formally defined in specs/spec.md §2 and verified across test suites</p>
                </div>
                <span className="px-2.5 py-1 rounded bg-emerald-950 text-emerald-300 border border-emerald-800 text-xs font-mono font-bold">
                  12/12 Attacks Blocked
                </span>
              </div>

              <div className="bg-slate-950 rounded-xl border border-slate-800 overflow-hidden text-xs">
                <table className="w-full text-left font-mono">
                  <thead className="bg-slate-900/80 text-slate-400 border-b border-slate-800 text-[11px]">
                    <tr>
                      <th className="py-2.5 px-3">Invariant</th>
                      <th className="py-2.5 px-3">Rule / Mechanism</th>
                      <th className="py-2.5 px-3">Attack Vector Mitigated</th>
                      <th className="py-2.5 px-3 text-right">Verification Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60 text-slate-300 text-xs">
                    <tr>
                      <td className="py-2 px-3 font-bold text-blue-400">INV-1 (Isolation)</td>
                      <td className="py-2 px-3 font-sans">ESLint no-restricted-imports & zero PayPal credentials</td>
                      <td className="py-2 px-3">Credential theft & direct agent execution</td>
                      <td className="py-2 px-3 text-right text-emerald-400 font-bold">ENFORCED</td>
                    </tr>
                    <tr>
                      <td className="py-2 px-3 font-bold text-blue-400">INV-2 (Payee Truth)</td>
                      <td className="py-2 px-3 font-sans">Server-side Merchant Registry (P-03 Payee Security)</td>
                      <td className="py-2 px-3">A-02 (Payee redirection & injected IBAN/email)</td>
                      <td className="py-2 px-3 text-right text-emerald-400 font-bold">ENFORCED</td>
                    </tr>
                    <tr>
                      <td className="py-2 px-3 font-bold text-blue-400">INV-3 (Price Truth)</td>
                      <td className="py-2 px-3 font-sans">Authoritative catalog price verification (P-04)</td>
                      <td className="py-2 px-3">A-04 (Price inflation / claiming $0.01)</td>
                      <td className="py-2 px-3 text-right text-emerald-400 font-bold">ENFORCED</td>
                    </tr>
                    <tr>
                      <td className="py-2 px-3 font-bold text-blue-400">INV-8 (Budget)</td>
                      <td className="py-2 px-3 font-sans">Atomic BEGIN IMMEDIATE reservation accounting (FR-26)</td>
                      <td className="py-2 px-3">A-03 (Concurrent flood draining budget)</td>
                      <td className="py-2 px-3 text-right text-emerald-400 font-bold">ENFORCED</td>
                    </tr>
                    <tr>
                      <td className="py-2 px-3 font-bold text-blue-400">INV-9 (Audit)</td>
                      <td className="py-2 px-3 font-sans">SHA-256 hash chaining with genesis prev_hash</td>
                      <td className="py-2 px-3">A-07 (Audit tampering / history manipulation)</td>
                      <td className="py-2 px-3 text-right text-emerald-400 font-bold">ENFORCED</td>
                    </tr>
                    <tr>
                      <td className="py-2 px-3 font-bold text-blue-400">INV-10 (Payload Binding)</td>
                      <td className="py-2 px-3 font-sans">Canonical payload hash verification (FR-28, AC-9)</td>
                      <td className="py-2 px-3">A-06 (Post-approval payload tampering)</td>
                      <td className="py-2 px-3 text-right text-emerald-400 font-bold">ENFORCED</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-slate-800 bg-slate-950 py-4 px-6 text-center text-xs text-slate-500 font-mono flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span>MandatePay</span>
          <span>•</span>
          <span>PayPal AI Hackathon Submission</span>
        </div>

        <div className="flex items-center gap-4">
          <a
            href="https://github.com/OkyWoww/mandatepay"
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1 text-slate-400 hover:text-slate-200 transition"
          >
            <span>GitHub Repository</span>
            <ExternalLink className="w-3 h-3" />
          </a>
        </div>
      </footer>
    </div>
  );
}

export default App;

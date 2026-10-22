import React, { useEffect, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  XCircle,
  ArrowUpRight,
  ShieldAlert,
  Hash,
  KeyRound,
  ExternalLink,
  Clock,
  Hourglass,
} from 'lucide-react';
import { formatMinorUnits } from '../utils/format.js';
import { api, type ApproveResponse } from '../api/client.js';

// Session-storage key for the owner authorization token (rule.md §4.9 — zero secrets in source).
const SESSION_KEY = 'aegis_owner_key';

/** Read persisted owner key from sessionStorage, empty string when unavailable (SSR / not set). */
export function readSessionToken(): string {
  try {
    return (typeof window !== 'undefined' && window.sessionStorage.getItem(SESSION_KEY)) || '';
  } catch {
    return '';
  }
}

export interface PendingStepUpProposal {
  intentId: string;
  merchantRef: string;
  items: Array<{ sku: string; name?: string; qty: number; unitPriceMinor: number }>;
  totalMinor: number;
  currency: string;
  rationale: string;
  reasonCodes: string[];
  /** Server-stored payload hash, forwarded verbatim as expected_payload_hash (FR-28). */
  payloadHash: string;
  riskScore?: number | undefined;
  /** Authorization deadline (step-up TTL, or payer-approval TTL once the order exists). */
  expiresAt?: string | null | undefined;
  orderId?: string | null | undefined;
  /** PayPal sandbox buyer approval URL (only after owner approval). */
  approveUrl?: string | null | undefined;
}

interface StepUpApprovalsQueueProps {
  /** Intents awaiting the OWNER's decision (GET /v1/approvals → approvals). */
  proposals: PendingStepUpProposal[];
  /** Intents the owner already approved; the BUYER must approve on PayPal Sandbox. */
  awaitingPayer?: PendingStepUpProposal[];
  /** Shown instead of the empty state when the queue could not be loaded (e.g. no Owner Key). */
  notice?: string | null;
  onApproved?: (intentId: string, result: ApproveResponse) => void;
  onRejected?: (intentId: string) => void;
  /** Fired when the owner finishes editing the key so the parent can reload the queue. */
  onOwnerKeyChange?: (token: string) => void;
}

// Per-intent status variants
type IntentStatus =
  | { kind: 'captured'; orderId: string | undefined }
  | { kind: 'awaiting_payer'; orderId: string | undefined; approveUrl: string | undefined }
  | { kind: 'failed'; message: string };

/** mm:ss (or h:mm:ss) for a non-negative duration in ms. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Live countdown to expires_at so reviewers see the authorization window. */
const Countdown: React.FC<{ expiresAt: string | null | undefined; testId: string; label?: string }> = ({
  expiresAt,
  testId,
  label = 'Authorization deadline',
}) => {
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  if (!expiresAt) return null;
  const deadline = Date.parse(expiresAt);
  if (Number.isNaN(deadline)) return null;

  const remaining = deadline - now;
  const expired = remaining <= 0;
  const tone = expired
    ? 'bg-rose-950/60 border-rose-800 text-rose-300'
    : remaining < 60_000
      ? 'bg-rose-950/50 border-rose-800/70 text-rose-300 animate-pulse'
      : remaining < 300_000
        ? 'bg-amber-950/60 border-amber-800/70 text-amber-300'
        : 'bg-emerald-950/50 border-emerald-800/60 text-emerald-300';

  return (
    <span
      data-testid={testId}
      data-expired={expired ? 'true' : 'false'}
      className={`inline-flex items-center gap-1.5 text-[11px] font-mono px-2 py-0.5 rounded border ${tone}`}
    >
      <Clock className="w-3 h-3" />
      {expired ? 'Expired' : `${label}: ${formatCountdown(remaining)}`}
    </span>
  );
};

/** Turn an approve response into an explicit, actionable message (401 / 403 / 422 …). */
function describeApproveFailure(res: ApproveResponse): string {
  const code = res.error ?? res.refusal_reason;
  switch (res.http_status) {
    case 401:
      return 'Approval failed (401 UNAUTHORIZED): Owner Key is empty or invalid. Check Owner Key and retry.';
    case 403:
      return 'Approval failed (403 FORBIDDEN): This token is not an Owner Key — only owner can approve step-up.';
    case 422:
      if (code === 'PAYLOAD_HASH_MISMATCH') {
        return 'Approval rejected (422 PAYLOAD_HASH_MISMATCH): Approved hash does not match current server payload (FR-28). No funds transferred; reservation released.';
      }
      return `Approval rejected (422 ${code ?? 'UNPROCESSABLE'}): ${res.message ?? 'request cannot be processed'}`;
    default: {
      const detail = res.message ?? res.refusal_reason ?? res.error ?? `unexpected status: ${res.status}`;
      const prefix = res.http_status ? `Approval failed (${res.http_status}${code ? ` ${code}` : ''})` : 'Approval failed';
      return `${prefix}: ${detail}`;
    }
  }
}

export const StepUpApprovalsQueue: React.FC<StepUpApprovalsQueueProps> = ({
  proposals,
  awaitingPayer = [],
  notice = null,
  onApproved,
  onRejected,
  onOwnerKeyChange,
}) => {
  // Owner authorization token — loaded from sessionStorage on mount; never hardcoded (rule.md §4.9).
  const [ownerToken, setOwnerToken] = useState<string>(readSessionToken);
  const [tokenInputVisible, setTokenInputVisible] = useState(false);

  /** Update state and persist to sessionStorage so the key survives tab navigation. */
  const handleTokenChange = (value: string) => {
    setOwnerToken(value);
    try {
      if (typeof window !== 'undefined') {
        if (value) {
          window.sessionStorage.setItem(SESSION_KEY, value);
        } else {
          window.sessionStorage.removeItem(SESSION_KEY);
        }
      }
    } catch {
      // sessionStorage write blocked (private browsing quota); silently ignore.
    }
  };

  const [approvingId, setApprovingId] = useState<string | null>(null);
  const [statusMap, setStatusMap] = useState<Record<string, IntentStatus>>({});

  const setStatus = (intentId: string, status: IntentStatus | undefined) =>
    setStatusMap((prev) => {
      const next = { ...prev };
      if (status) next[intentId] = status;
      else delete next[intentId];
      return next;
    });

  const handleApprove = async (proposal: PendingStepUpProposal) => {
    const token = ownerToken.trim();
    if (!token) {
      setTokenInputVisible(true);
      return;
    }

    setApprovingId(proposal.intentId);
    setStatus(proposal.intentId, undefined); // clear a previous failure before retrying
    try {
      // proposal.payloadHash is the server-provided hash, sent as-is (never computed in the browser).
      const res = await api.approveIntent(proposal.intentId, proposal.payloadHash, token);

      if (res.status === 'CAPTURED') {
        setStatus(proposal.intentId, { kind: 'captured', orderId: res.order_id });
        if (onApproved) onApproved(proposal.intentId, res);
      } else if (res.status === 'AWAITING_PAYER_APPROVAL') {
        // Order created on PayPal; the buyer must click the sandbox approve URL before capture.
        setStatus(proposal.intentId, {
          kind: 'awaiting_payer',
          orderId: res.order_id,
          approveUrl: res.approve_url,
        });
        if (onApproved) onApproved(proposal.intentId, res);
      } else {
        setStatus(proposal.intentId, { kind: 'failed', message: describeApproveFailure(res) });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setStatus(proposal.intentId, { kind: 'failed', message: `Network error: ${msg}` });
    } finally {
      setApprovingId(null);
    }
  };

  const handleReject = async (proposal: PendingStepUpProposal) => {
    const token = ownerToken.trim();
    if (!token) {
      setTokenInputVisible(true);
      return;
    }
    setApprovingId(proposal.intentId);
    try {
      const res = await api.rejectIntent(proposal.intentId, token);
      if (res.ok) {
        if (onRejected) onRejected(proposal.intentId);
      } else {
        setStatus(proposal.intentId, {
          kind: 'failed',
          message: `Rejection failed (${res.status}): ${res.message ?? 'request rejected by server'}`,
        });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setStatus(proposal.intentId, { kind: 'failed', message: `Network error: ${msg}` });
    } finally {
      setApprovingId(null);
    }
  };

  /** Banner shown once the owner approved: buyer still has to approve on PayPal Sandbox. */
  const renderPayerBanner = (item: PendingStepUpProposal, orderId: string | null | undefined, approveUrl: string | null | undefined) => {
    const isBusy = approvingId === item.intentId;
    return (
      <div
        data-testid={`status-awaiting-${item.intentId}`}
        className="p-4 rounded-lg border bg-blue-950/60 border-blue-800 text-blue-200 text-xs font-mono space-y-3"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Hourglass className="w-4 h-4 shrink-0 text-blue-400" />
            <span className="font-sans font-bold text-sm text-blue-100">
              Awaiting Buyer Approval on PayPal Sandbox
            </span>
          </div>
          <Countdown
            expiresAt={item.expiresAt}
            testId={`countdown-payer-${item.intentId}`}
            label="Buyer approval deadline"
          />
        </div>
        <p className="text-[11px] text-blue-300/90">
          Owner approved. Order{' '}
          <span className="text-blue-200 font-bold">{orderId ?? 'PayPal'}</span> created; funds will only be captured after
          buyer approves on PayPal Sandbox.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {approveUrl && (
            <a
              data-testid={`paypal-approve-link-${item.intentId}`}
              href={approveUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-[11px] font-semibold transition"
            >
              <ExternalLink className="w-3.5 h-3.5" />
              Approve on PayPal Sandbox
            </a>
          )}
          <button
            data-testid={`recapture-btn-${item.intentId}`}
            disabled={isBusy}
            onClick={() => handleApprove(item)}
            className="px-3 py-1.5 rounded-lg text-[11px] font-semibold bg-slate-700 hover:bg-slate-600 text-slate-200 flex items-center gap-1.5 transition cursor-pointer disabled:opacity-50"
          >
            {isBusy ? (
              <span className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
            ) : (
              <ArrowUpRight className="w-3.5 h-3.5" />
            )}
            <span>Check Capture Status</span>
          </button>
        </div>
      </div>
    );
  };

  // Results for intents that already left both lists (e.g. captured, or failed and swept by the server).
  const visibleIds = new Set([...proposals, ...awaitingPayer].map((p) => p.intentId));
  const orphanResults = Object.entries(statusMap).filter(
    ([id, st]) => !visibleIds.has(id) && (st.kind === 'captured' || st.kind === 'failed'),
  );

  return (
    <div
      data-testid="step-up-queue"
      className="bg-slate-900/80 border border-slate-800 rounded-2xl p-6 shadow-xl backdrop-blur space-y-4"
    >
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between border-b border-slate-800 pb-4 flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center text-amber-400">
            <AlertCircle className="w-5 h-5" />
          </div>
          <div>
            <h3 className="text-base font-bold text-white tracking-tight">Step-Up Approvals Queue</h3>
            <p className="text-xs text-slate-400">
              Purchases exceeding auto-approve limits awaiting cryptographic human authorization (FR-16, FR-28)
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Owner key indicator / toggle */}
          <button
            data-testid="owner-key-toggle"
            onClick={() => setTokenInputVisible((v) => !v)}
            title="Configure Owner Authorization Key"
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-[11px] font-mono transition cursor-pointer ${
              ownerToken.trim()
                ? 'bg-emerald-950/50 border-emerald-800/60 text-emerald-400 hover:bg-emerald-950'
                : 'bg-rose-950/50 border-rose-800/60 text-rose-400 hover:bg-rose-950'
            }`}
          >
            <KeyRound className="w-3 h-3" />
            <span>{ownerToken.trim() ? 'Owner Key Set' : 'No Owner Key'}</span>
          </button>

          <span className="text-xs font-mono px-2.5 py-1 rounded bg-amber-950 text-amber-300 border border-amber-800/80 font-bold">
            {proposals.length} Pending
          </span>
        </div>
      </div>

      {/* ── Owner Key Input (collapsible) ──────────────────────────────────── */}
      {tokenInputVisible && (
        <div
          data-testid="owner-key-input-panel"
          className="flex items-center gap-2 p-3 rounded-xl bg-slate-950/70 border border-slate-700"
        >
          <KeyRound className="w-4 h-4 text-slate-500 shrink-0" />
          <input
            data-testid="owner-key-input"
            type="password"
            value={ownerToken}
            onChange={(e) => handleTokenChange(e.target.value)}
            placeholder="Enter Owner Authorization Key (Bearer token)"
            className="flex-1 bg-transparent text-xs font-mono text-slate-200 placeholder-slate-600 outline-none"
            aria-label="Owner Authorization Key"
          />
          <button
            data-testid="owner-key-done"
            onClick={() => {
              setTokenInputVisible(false);
              if (onOwnerKeyChange) onOwnerKeyChange(ownerToken.trim());
            }}
            className="text-[11px] text-slate-400 hover:text-white font-mono px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 transition cursor-pointer"
          >
            Done
          </button>
        </div>
      )}

      {/* ── Results for intents that already left the lists ────────────────── */}
      {orphanResults.map(([id, st]) =>
        st.kind === 'captured' ? (
          <div
            key={id}
            data-testid={`status-captured-${id}`}
            className="p-3 rounded-lg border bg-emerald-950/60 border-emerald-800 text-emerald-300 text-xs font-mono flex items-center gap-2"
          >
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            <span>
              {id}: PayPal Order {st.orderId ?? 'unknown'} settled successfully!
            </span>
          </div>
        ) : st.kind === 'failed' ? (
          <div
            key={id}
            data-testid={`status-failed-${id}`}
            className="p-3 rounded-lg border bg-rose-950/60 border-rose-800 text-rose-300 text-xs font-mono flex items-start gap-2"
          >
            <XCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>
              {id}: {st.message}
            </span>
          </div>
        ) : null,
      )}

      {/* ── Owner queue ────────────────────────────────────────────────────── */}
      {proposals.length === 0 ? (
        notice ? (
          <div
            data-testid="queue-notice"
            className="p-3 rounded-lg border bg-amber-950/40 border-amber-800/60 text-amber-300 text-xs font-mono flex items-center gap-2"
          >
            <KeyRound className="w-4 h-4 shrink-0" />
            <span>{notice}</span>
          </div>
        ) : awaitingPayer.length === 0 ? (
          <div className="py-12 text-center text-slate-500 font-mono text-xs space-y-2">
            <CheckCircle2 className="w-8 h-8 text-slate-600 mx-auto" />
            <p>No step-up approvals pending review.</p>
            <p className="text-[11px] text-slate-600">
              Intents over $30.00 will pause here for operator sign-off before PayPal is called.
            </p>
          </div>
        ) : null
      ) : (
        <div className="space-y-4 pt-2">
          {proposals.map((item) => {
            const isApproving = approvingId === item.intentId;
            const currentStatus = statusMap[item.intentId];

            return (
              <div
                key={item.intentId}
                data-testid={`proposal-${item.intentId}`}
                className="bg-slate-950/80 border border-slate-800 rounded-xl p-5 space-y-4 hover:border-slate-700 transition"
              >
                {/* Proposal Header */}
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs font-bold text-amber-400">{item.intentId}</span>
                    <span className="text-slate-600">•</span>
                    <span className="text-xs font-medium text-slate-300">{item.merchantRef}</span>
                  </div>

                  <div className="flex items-center gap-2">
                    <Countdown expiresAt={item.expiresAt} testId={`countdown-${item.intentId}`} />
                    <span className="text-xs font-bold font-mono px-2 py-0.5 rounded bg-amber-950/60 border border-amber-800/60 text-amber-300">
                      STEP_UP
                    </span>
                    <span className="text-base font-extrabold text-white">
                      {formatMinorUnits(item.totalMinor, item.currency)}
                    </span>
                  </div>
                </div>

                {/* Itemized Table */}
                <div className="bg-slate-900/60 rounded-lg border border-slate-800/80 overflow-hidden text-xs">
                  <table className="w-full text-left font-mono">
                    <thead className="bg-slate-900/90 text-slate-400 border-b border-slate-800 text-[11px]">
                      <tr>
                        <th className="py-2 px-3">Item / SKU</th>
                        <th className="py-2 px-3 text-center">Qty</th>
                        <th className="py-2 px-3 text-right">Unit Price</th>
                        <th className="py-2 px-3 text-right">Subtotal</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/60 text-slate-200 text-xs">
                      {item.items.map((it, idx) => (
                        <tr key={idx}>
                          <td className="py-2 px-3">
                            <span className="font-sans font-medium text-slate-100">{it.name || it.sku}</span>
                            <span className="text-[10px] text-slate-500 block">{it.sku}</span>
                          </td>
                          <td className="py-2 px-3 text-center text-slate-300">{it.qty}</td>
                          <td className="py-2 px-3 text-right text-slate-400">
                            {formatMinorUnits(it.unitPriceMinor, item.currency)}
                          </td>
                          <td className="py-2 px-3 text-right font-bold text-slate-100">
                            {formatMinorUnits(it.unitPriceMinor * it.qty, item.currency)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Rationale and Triggers */}
                <div className="flex flex-wrap items-center justify-between text-xs gap-3">
                  <div className="space-y-1">
                    <span className="text-[11px] uppercase tracking-wider text-slate-500 font-mono font-semibold">
                      Agent Rationale
                    </span>
                    <p className="text-slate-300 italic text-xs">&ldquo;{item.rationale}&rdquo;</p>
                  </div>

                  <div className="flex items-center gap-2">
                    {item.reasonCodes.map((code, cIdx) => (
                      <span
                        key={cIdx}
                        className="px-2 py-0.5 rounded text-[10px] font-mono bg-blue-950 border border-blue-800 text-blue-300"
                      >
                        {code}
                      </span>
                    ))}
                    {item.riskScore !== undefined && (
                      <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-purple-950 border border-purple-800 text-purple-300 flex items-center gap-1">
                        <ShieldAlert className="w-3 h-3" /> Risk: {item.riskScore}
                      </span>
                    )}
                  </div>
                </div>

                {/* Payload Hash Binding Callout */}
                <div className="p-2.5 bg-slate-900/90 rounded border border-slate-800 font-mono text-[11px] flex items-center justify-between text-slate-400">
                  <div className="flex items-center gap-2 truncate">
                    <Hash className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                    <span className="text-slate-500 shrink-0">Bound Payload Hash (FR-28):</span>
                    <span className="text-amber-400/90 truncate">{item.payloadHash}</span>
                  </div>
                </div>

                {/* ── Status Panel (retryable failures stay visible next to the buttons) ── */}
                {currentStatus?.kind === 'captured' && (
                  <div
                    data-testid={`status-captured-${item.intentId}`}
                    className="p-3 rounded-lg border bg-emerald-950/60 border-emerald-800 text-emerald-300 text-xs font-mono flex items-center gap-2"
                  >
                    <CheckCircle2 className="w-4 h-4 shrink-0" />
                    <span>PayPal Order {currentStatus.orderId ?? 'unknown'} settled successfully!</span>
                  </div>
                )}

                {currentStatus?.kind === 'awaiting_payer' &&
                  renderPayerBanner(item, currentStatus.orderId, currentStatus.approveUrl)}

                {currentStatus?.kind === 'failed' && (
                  <div
                    data-testid={`status-failed-${item.intentId}`}
                    role="alert"
                    className="p-3 rounded-lg border bg-rose-950/60 border-rose-800 text-rose-300 text-xs font-mono flex items-start gap-2"
                  >
                    <XCircle className="w-4 h-4 shrink-0 mt-0.5" />
                    <span>{currentStatus.message}</span>
                  </div>
                )}

                {/* ── Action Buttons (hidden once approved / captured; shown again after a failure) ── */}
                {(!currentStatus || currentStatus.kind === 'failed') && (
                  <div className="flex items-center justify-end gap-3 pt-1">
                    <button
                      data-testid={`reject-btn-${item.intentId}`}
                      disabled={isApproving}
                      onClick={() => handleReject(item)}
                      className="px-4 py-2 rounded-lg text-xs font-semibold text-slate-400 hover:text-white hover:bg-slate-800 border border-slate-800 transition cursor-pointer disabled:opacity-50"
                    >
                      Reject Proposal
                    </button>

                    <button
                      data-testid={`approve-btn-${item.intentId}`}
                      disabled={isApproving}
                      onClick={() => handleApprove(item)}
                      className="px-4 py-2 rounded-lg text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white flex items-center gap-2 shadow-lg shadow-emerald-600/20 transition cursor-pointer disabled:opacity-50"
                    >
                      {isApproving ? (
                        <>
                          <span className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin"></span>
                          <span>Verifying &amp; Executing...</span>
                        </>
                      ) : (
                        <>
                          <ArrowUpRight className="w-4 h-4" />
                          <span>Approve &amp; Authorize PayPal</span>
                        </>
                      )}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ── Awaiting BUYER approval (owner already approved) — not part of the owner queue ── */}
      {awaitingPayer.length > 0 && (
        <div data-testid="awaiting-payer-section" className="space-y-3 pt-2">
          <span className="text-[11px] uppercase tracking-wider text-slate-500 font-mono font-semibold">
            Awaiting Buyer ({awaitingPayer.length})
          </span>
          {awaitingPayer.map((item) => (
            <div
              key={item.intentId}
              data-testid={`payer-wait-${item.intentId}`}
              className="bg-slate-950/80 border border-blue-900/60 rounded-xl p-4 space-y-3"
            >
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                <div className="flex items-center gap-2">
                  <span className="font-mono font-bold text-blue-300">{item.intentId}</span>
                  <span className="text-slate-600">•</span>
                  <span className="text-slate-300">{item.merchantRef}</span>
                </div>
                <span className="text-sm font-extrabold text-white">
                  {formatMinorUnits(item.totalMinor, item.currency)}
                </span>
              </div>
              {renderPayerBanner(item, item.orderId, item.approveUrl)}
              {statusMap[item.intentId]?.kind === 'failed' && (
                <div
                  data-testid={`status-failed-${item.intentId}`}
                  role="alert"
                  className="p-3 rounded-lg border bg-rose-950/60 border-rose-800 text-rose-300 text-xs font-mono flex items-start gap-2"
                >
                  <XCircle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>{(statusMap[item.intentId] as { kind: 'failed'; message: string }).message}</span>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

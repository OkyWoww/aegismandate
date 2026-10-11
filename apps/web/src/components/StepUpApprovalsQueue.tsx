import React, { useState } from 'react';
import { AlertCircle, CheckCircle2, XCircle, ArrowUpRight, ShieldAlert, Hash } from 'lucide-react';
import { formatMinorUnits } from '../utils/format.js';
import { api, type ApproveResponse } from '../api/client.js';

export interface PendingStepUpProposal {
  intentId: string;
  merchantRef: string;
  items: Array<{ sku: string; name?: string; qty: number; unitPriceMinor: number }>;
  totalMinor: number;
  currency: string;
  rationale: string;
  reasonCodes: string[];
  payloadHash: string;
  riskScore?: number | undefined;
}

interface StepUpApprovalsQueueProps {
  proposals: PendingStepUpProposal[];
  onApproved?: (intentId: string, result: ApproveResponse) => void;
  onRejected?: (intentId: string) => void;
}

export const StepUpApprovalsQueue: React.FC<StepUpApprovalsQueueProps> = ({
  proposals,
  onApproved,
  onRejected,
}) => {
  const [approvingId, setApprovingId] = useState<string | null>(null);
  const [statusMap, setStatusMap] = useState<Record<string, { status: string; message: string }>>({});

  const handleApprove = async (proposal: PendingStepUpProposal) => {
    setApprovingId(proposal.intentId);
    try {
      const res = await api.approveIntent(proposal.intentId, proposal.payloadHash);
      if (res.status === 'CAPTURED') {
        setStatusMap((prev) => ({
          ...prev,
          [proposal.intentId]: {
            status: 'CAPTURED',
            message: `PayPal Order ${res.order_id ?? 'captured'} settled successfully!`,
          },
        }));
        if (onApproved) onApproved(proposal.intentId, res);
      } else {
        setStatusMap((prev) => ({
          ...prev,
          [proposal.intentId]: {
            status: 'FAILED',
            message: `Approval failed: ${res.refusal_reason ?? res.error ?? 'Unknown error'}`,
          },
        }));
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setStatusMap((prev) => ({
        ...prev,
        [proposal.intentId]: {
          status: 'FAILED',
          message: `Network error during approval: ${msg}`,
        },
      }));
    } finally {
      setApprovingId(null);
    }
  };

  return (
    <div className="bg-slate-900/80 border border-slate-800 rounded-2xl p-6 shadow-xl backdrop-blur space-y-4">
      <div className="flex items-center justify-between border-b border-slate-800 pb-4">
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

        <span className="text-xs font-mono px-2.5 py-1 rounded bg-amber-950 text-amber-300 border border-amber-800/80 font-bold">
          {proposals.length} Pending
        </span>
      </div>

      {proposals.length === 0 ? (
        <div className="py-12 text-center text-slate-500 font-mono text-xs space-y-2">
          <CheckCircle2 className="w-8 h-8 text-slate-600 mx-auto" />
          <p>No step-up approvals pending review.</p>
          <p className="text-[11px] text-slate-600">
            Intents over $30.00 will pause here for operator sign-off before PayPal is called.
          </p>
        </div>
      ) : (
        <div className="space-y-4 pt-2">
          {proposals.map((item) => {
            const isApproving = approvingId === item.intentId;
            const currentStatus = statusMap[item.intentId];

            return (
              <div
                key={item.intentId}
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

                {/* Status Message or Action Buttons */}
                {currentStatus ? (
                  <div
                    className={`p-3 rounded-lg border text-xs font-mono flex items-center gap-2 ${
                      currentStatus.status === 'CAPTURED'
                        ? 'bg-emerald-950/60 border-emerald-800 text-emerald-300'
                        : 'bg-rose-950/60 border-rose-800 text-rose-300'
                    }`}
                  >
                    {currentStatus.status === 'CAPTURED' ? (
                      <CheckCircle2 className="w-4 h-4 shrink-0" />
                    ) : (
                      <XCircle className="w-4 h-4 shrink-0" />
                    )}
                    <span>{currentStatus.message}</span>
                  </div>
                ) : (
                  <div className="flex items-center justify-end gap-3 pt-1">
                    <button
                      onClick={() => onRejected && onRejected(item.intentId)}
                      className="px-4 py-2 rounded-lg text-xs font-semibold text-slate-400 hover:text-white hover:bg-slate-800 border border-slate-800 transition cursor-pointer"
                    >
                      Reject Proposal
                    </button>

                    <button
                      disabled={isApproving}
                      onClick={() => handleApprove(item)}
                      className="px-4 py-2 rounded-lg text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white flex items-center gap-2 shadow-lg shadow-emerald-600/20 transition cursor-pointer disabled:opacity-50"
                    >
                      {isApproving ? (
                        <>
                          <span className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin"></span>
                          <span>Verifying & Executing...</span>
                        </>
                      ) : (
                        <>
                          <ArrowUpRight className="w-4 h-4" />
                          <span>Approve & Authorize PayPal</span>
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
    </div>
  );
};

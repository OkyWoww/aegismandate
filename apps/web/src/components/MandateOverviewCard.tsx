import React from 'react';
import { ShieldCheck, Clock, ShoppingBag, Layers, AlertTriangle } from 'lucide-react';
import { formatMinorUnits, formatDateTime, formatRelativeTime } from '../utils/format.js';
import type { MandateResponse } from '../api/client.js';

interface MandateOverviewCardProps {
  mandateData: MandateResponse;
  onRefresh?: () => void;
}

export const MandateOverviewCard: React.FC<MandateOverviewCardProps> = ({ mandateData }) => {
  const { mandate, spend } = mandateData;
  const isSuspended = mandate.status === 'SUSPENDED';
  const total = mandate.total_budget_minor || 1;
  const committed = spend.captured_minor + spend.reserved_minor;
  const percentUsed = Math.min(100, Math.round((committed / total) * 100));

  return (
    <div className="bg-slate-900/80 border border-slate-800 rounded-2xl p-6 shadow-xl backdrop-blur">
      {/* Top Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-5">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-blue-600/20 border border-blue-500/30 flex items-center justify-center text-blue-400">
            <ShieldCheck className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-mono font-bold uppercase tracking-wider text-slate-400">Mandate ID</span>
              <span className="font-mono text-xs text-blue-400">{mandate.mandate_id}</span>
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-800 text-slate-300">v{mandate.version}</span>
            </div>
            <h2 className="text-lg font-bold text-white tracking-tight">Active Financial Mandate</h2>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg border font-mono text-xs font-semibold bg-slate-950 border-slate-800">
            <Clock className="w-3.5 h-3.5 text-amber-400" />
            <span className="text-slate-400">TTL:</span>
            <span className="text-amber-400">{formatRelativeTime(mandate.valid_until)}</span>
          </div>

          <span
            className={`px-3 py-1.5 rounded-lg text-xs font-mono font-bold uppercase tracking-wide border flex items-center gap-1.5 ${
              isSuspended
                ? 'bg-rose-950/80 text-rose-300 border-rose-800 animate-pulse'
                : 'bg-emerald-950/80 text-emerald-300 border-emerald-800'
            }`}
          >
            {isSuspended && <AlertTriangle className="w-3.5 h-3.5 text-rose-400" />}
            <span>{mandate.status}</span>
          </span>
        </div>
      </div>

      {/* Budget Meter */}
      <div className="py-6 border-b border-slate-800 space-y-3">
        <div className="flex justify-between items-baseline">
          <div>
            <span className="text-xs text-slate-400 uppercase tracking-wider font-semibold">Remaining Budget</span>
            <div className="text-3xl font-extrabold text-white tracking-tight">
              {formatMinorUnits(spend.remaining_minor, mandate.currency)}
            </div>
          </div>
          <div className="text-right font-mono text-xs text-slate-400">
            <span>Committed: </span>
            <span className="text-white font-bold">{formatMinorUnits(committed, mandate.currency)}</span>
            <span> / {formatMinorUnits(mandate.total_budget_minor, mandate.currency)}</span>
          </div>
        </div>

        {/* Progress Bar */}
        <div className="w-full h-3 bg-slate-950 rounded-full overflow-hidden border border-slate-800 flex">
          <div
            className="bg-emerald-500 h-full transition-all duration-500"
            style={{ width: `${Math.round((spend.captured_minor / total) * 100)}%` }}
            title={`Captured: ${formatMinorUnits(spend.captured_minor)}`}
          />
          <div
            className="bg-amber-500 h-full transition-all duration-500"
            style={{ width: `${Math.round((spend.reserved_minor / total) * 100)}%` }}
            title={`Reserved: ${formatMinorUnits(spend.reserved_minor)}`}
          />
        </div>

        <div className="flex justify-between text-[11px] font-mono text-slate-400 pt-1">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-emerald-500 inline-block"></span>
            <span>Captured: {formatMinorUnits(spend.captured_minor)}</span>
            <span className="w-2 h-2 rounded-full bg-amber-500 inline-block ml-2"></span>
            <span>Reserved: {formatMinorUnits(spend.reserved_minor)}</span>
          </div>
          <span>{percentUsed}% Allocated</span>
        </div>
      </div>

      {/* Constraints & Limits Grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 pt-5">
        <div className="p-3.5 bg-slate-950 rounded-xl border border-slate-800/80">
          <span className="text-[11px] font-mono uppercase text-slate-400 block mb-1">Auto-Approve Cap</span>
          <span className="text-base font-bold text-emerald-400">
            {formatMinorUnits(mandate.auto_approve_limit_minor, mandate.currency)}
          </span>
          <span className="text-[10px] text-slate-500 block mt-0.5">Autonomous execution</span>
        </div>

        <div className="p-3.5 bg-slate-950 rounded-xl border border-slate-800/80">
          <span className="text-[11px] font-mono uppercase text-slate-400 block mb-1">Per-Txn Limit</span>
          <span className="text-base font-bold text-blue-400">
            {formatMinorUnits(mandate.per_txn_limit_minor, mandate.currency)}
          </span>
          <span className="text-[10px] text-slate-500 block mt-0.5">Hard financial ceiling</span>
        </div>

        <div className="p-3.5 bg-slate-950 rounded-xl border border-slate-800/80">
          <span className="text-[11px] font-mono uppercase text-slate-400 block mb-1">Hourly Velocity</span>
          <span className="text-base font-bold text-purple-400">
            {mandate.max_txns_per_hour} txns / hr
          </span>
          <span className="text-[10px] text-slate-500 block mt-0.5">Flood protection (P-09)</span>
        </div>

        <div className="p-3.5 bg-slate-950 rounded-xl border border-slate-800/80">
          <span className="text-[11px] font-mono uppercase text-slate-400 block mb-1">Expires At</span>
          <span className="text-xs font-mono font-semibold text-slate-300 block truncate">
            {formatDateTime(mandate.valid_until)}
          </span>
          <span className="text-[10px] text-slate-500 block mt-0.5">Strict TTL enforcement</span>
        </div>
      </div>

      {/* Scope Allowlist & Signature */}
      <div className="mt-4 pt-4 border-t border-slate-800/60 flex flex-wrap items-center justify-between text-xs font-mono text-slate-400 gap-2">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5">
            <ShoppingBag className="w-3.5 h-3.5 text-blue-400" />
            <span>Merchants: </span>
            <span className="text-slate-200">{mandate.allowed_merchants.join(', ')}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <Layers className="w-3.5 h-3.5 text-purple-400" />
            <span>Categories: </span>
            <span className="text-slate-200">{mandate.allowed_categories.join(', ')}</span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-slate-500">HMAC-SHA256:</span>
          <span className="text-[11px] text-amber-400/90 font-mono truncate max-w-[160px]">
            {mandate.signature.slice(0, 20)}...
          </span>
        </div>
      </div>
    </div>
  );
};

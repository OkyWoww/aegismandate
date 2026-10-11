import React, { useState } from 'react';
import { Database, ShieldCheck, AlertOctagon, RefreshCw, KeyRound } from 'lucide-react';
import { formatDateTime } from '../utils/format.js';
import { api, type AuditEventItem, type AuditVerifyResponse } from '../api/client.js';

interface AuditLedgerFeedProps {
  events: AuditEventItem[];
  onRefreshEvents?: () => void;
}

export const AuditLedgerFeed: React.FC<AuditLedgerFeedProps> = ({ events, onRefreshEvents }) => {
  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<AuditVerifyResponse | null>(null);
  const [filterActor, setFilterActor] = useState<string>('all');

  const handleVerify = async () => {
    setVerifying(true);
    try {
      const res = await api.verifyAudit();
      setVerifyResult(res);
    } catch {
      setVerifyResult({
        valid: false,
        count: 0,
        broken_at_seq: 1,
        reason: 'Verification query failed',
      });
    } finally {
      setVerifying(false);
    }
  };

  const filteredEvents = filterActor === 'all'
    ? events
    : events.filter((e) => e.actor === filterActor);

  return (
    <div className="bg-slate-900/80 border border-slate-800 rounded-2xl p-6 shadow-xl backdrop-blur space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-purple-600/10 border border-purple-500/20 flex items-center justify-center text-purple-400">
            <Database className="w-5 h-5" />
          </div>
          <div>
            <h3 className="text-base font-bold text-white tracking-tight">Tamper-Evident Audit Ledger</h3>
            <p className="text-xs text-slate-400">
              SHA-256 cryptographic hash-chained events with BEGIN IMMEDIATE transaction serialization (FR-21, FR-22)
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {onRefreshEvents && (
            <button
              onClick={onRefreshEvents}
              className="p-2 rounded-lg bg-slate-950 border border-slate-800 text-slate-400 hover:text-white transition cursor-pointer"
              title="Refresh events"
            >
              <RefreshCw className="w-4 h-4" />
            </button>
          )}

          <button
            disabled={verifying}
            onClick={handleVerify}
            className="px-4 py-2 rounded-lg text-xs font-semibold bg-blue-600 hover:bg-blue-500 text-white flex items-center gap-2 shadow-lg shadow-blue-600/20 transition cursor-pointer disabled:opacity-50"
          >
            {verifying ? (
              <>
                <span className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin"></span>
                <span>Verifying Hash Chain...</span>
              </>
            ) : (
              <>
                <KeyRound className="w-4 h-4" />
                <span>Verify Ledger Integrity</span>
              </>
            )}
          </button>
        </div>
      </div>

      {/* Verification Status Banner */}
      {verifyResult && (
        <div
          className={`p-4 rounded-xl border text-xs font-mono flex items-center justify-between ${
            verifyResult.valid
              ? 'bg-emerald-950/60 border-emerald-800 text-emerald-300'
              : 'bg-rose-950/80 border-rose-800 text-rose-300 animate-pulse'
          }`}
        >
          <div className="flex items-center gap-3">
            {verifyResult.valid ? (
              <ShieldCheck className="w-5 h-5 text-emerald-400 shrink-0" />
            ) : (
              <AlertOctagon className="w-5 h-5 text-rose-400 shrink-0" />
            )}
            <div>
              <span className="font-bold text-sm block">
                {verifyResult.valid ? 'Cryptographic Chain Valid (PASS)' : 'Hash Chain Tampering Detected (FAIL)'}
              </span>
              <span className="text-[11px] opacity-90">
                {verifyResult.valid
                  ? `All ${verifyResult.count} audit events verified from genesis with zero sequence gaps.`
                  : `Chain verification failed at sequence #${verifyResult.broken_at_seq}: ${verifyResult.reason}`}
              </span>
            </div>
          </div>

          <span className="px-2.5 py-1 rounded bg-black/40 border border-current font-bold text-[11px]">
            {verifyResult.valid ? 'VERIFIED' : 'TAMPERED'}
          </span>
        </div>
      )}

      {/* Actor Filters */}
      <div className="flex items-center gap-2 text-xs font-mono">
        <span className="text-slate-500">Filter Actor:</span>
        {['all', 'control_plane', 'agent', 'user', 'paypal'].map((act) => (
          <button
            key={act}
            onClick={() => setFilterActor(act)}
            className={`px-2.5 py-1 rounded border transition cursor-pointer ${
              filterActor === act
                ? 'bg-blue-950 border-blue-700 text-blue-300 font-bold'
                : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200'
            }`}
          >
            {act}
          </button>
        ))}
      </div>

      {/* Events Table */}
      <div className="bg-slate-950 rounded-xl border border-slate-800 overflow-hidden text-xs">
        <div className="overflow-x-auto max-h-[420px]">
          <table className="w-full text-left font-mono">
            <thead className="bg-slate-900/90 text-slate-400 border-b border-slate-800 text-[11px] sticky top-0 z-10 backdrop-blur">
              <tr>
                <th className="py-2.5 px-3 w-16">Seq</th>
                <th className="py-2.5 px-3 w-28">Timestamp</th>
                <th className="py-2.5 px-3 w-28">Actor</th>
                <th className="py-2.5 px-3 w-40">Event Type</th>
                <th className="py-2.5 px-3 w-32">Reference</th>
                <th className="py-2.5 px-3">Payload Summary</th>
                <th className="py-2.5 px-3 w-28 text-right">SHA-256 Hash</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60 text-slate-300 text-xs">
              {filteredEvents.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-8 text-center text-slate-500">
                    No audit records matching filter criteria.
                  </td>
                </tr>
              ) : (
                filteredEvents.map((e) => {
                  const actorColor =
                    e.actor === 'control_plane'
                      ? 'bg-blue-950 text-blue-300 border-blue-800'
                      : e.actor === 'agent'
                        ? 'bg-amber-950 text-amber-300 border-amber-800'
                        : e.actor === 'user'
                          ? 'bg-emerald-950 text-emerald-300 border-emerald-800'
                          : 'bg-purple-950 text-purple-300 border-purple-800';

                  const typeColor =
                    e.type.includes('DENIED') || e.type.includes('REFUSED') || e.type.includes('FAILED')
                      ? 'text-rose-400 font-bold'
                      : e.type.includes('APPROVED') || e.type.includes('CAPTURED')
                        ? 'text-emerald-400 font-bold'
                        : 'text-slate-200';

                  const summary = typeof e.payload === 'object' && e.payload !== null
                    ? JSON.stringify(e.payload).slice(0, 70) + (JSON.stringify(e.payload).length > 70 ? '...' : '')
                    : String(e.payload);

                  return (
                    <tr key={e.seq} className="hover:bg-slate-900/50 transition">
                      <td className="py-2 px-3 font-bold text-slate-400">{`#${e.seq}`}</td>
                      <td className="py-2 px-3 text-slate-500 text-[11px] whitespace-nowrap">
                        {formatDateTime(e.ts)}
                      </td>
                      <td className="py-2 px-3">
                        <span className={`px-2 py-0.5 rounded text-[10px] font-bold border ${actorColor}`}>
                          {e.actor}
                        </span>
                      </td>
                      <td className={`py-2 px-3 text-xs ${typeColor}`}>{e.type}</td>
                      <td className="py-2 px-3 text-slate-400 truncate max-w-[120px]">{e.ref}</td>
                      <td className="py-2 px-3 text-slate-400 text-[11px] font-sans truncate max-w-[240px]">
                        {summary}
                      </td>
                      <td className="py-2 px-3 text-right font-mono text-[10px] text-amber-400/80">
                        {e.hash.slice(0, 10)}...
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

/**
 * MetricCard — displays a single impact metric (T-018 §3).
 *
 * States:
 *   skeleton  — isLoading = true before first data (never shows $0.00)
 *   stale     — isStale = true after first data; shows "stale · retrying" badge
 *   normal    — data present, not stale
 *   empty     — all counts/amounts are zero; shows "—" + "No activity yet"
 *
 * Value transitions animate with a 400 ms CSS transition via a key-swap technique.
 */

import React, { useRef, useState, useEffect } from 'react';

export interface MetricCardProps {
  /** Card heading label */
  title: string;
  /** Pre-formatted big value (e.g. "$146.00 of $200.00") or empty to use emptyValue */
  value: string;
  /** Sub-line below the big value */
  subLine: string;
  /** Whether the first data fetch has not yet completed */
  isLoading: boolean;
  /** Whether data is stale (fetch failed after initial load) */
  isStale: boolean;
  /** Whether the metric is in an empty / no-activity state */
  isEmpty: boolean;
  /** Optional badge label shown in the card header (e.g. "MOCK SEED") */
  badge?: string;
  /** Called when the card is clicked (e.g. opens drawer) */
  onClick?: () => void;
}

// Skeleton shimmer block
function Skeleton({ className }: { className?: string }) {
  return (
    <div
      data-testid="skeleton"
      className={`rounded bg-slate-700/50 animate-pulse ${className ?? ''}`}
    />
  );
}

export function MetricCard({
  title,
  value,
  subLine,
  isLoading,
  isStale,
  isEmpty,
  badge,
  onClick,
}: MetricCardProps) {
  // Animated value swap: track the displayed value independently so we can
  // apply a 400 ms fade-scale transition whenever it changes.
  const [displayedValue, setDisplayedValue] = useState(value);
  const [animating, setAnimating] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (value === displayedValue) return;
    setAnimating(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      setDisplayedValue(value);
      setAnimating(false);
    }, 400);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [value]);

  const interactiveClass = onClick
    ? 'cursor-pointer hover:border-slate-600 transition-colors'
    : '';

  return (
    <div
      className={`bg-slate-900/70 border border-slate-800 rounded-2xl p-5 flex flex-col gap-3 ${interactiveClass}`}
      onClick={onClick}
      data-testid="metric-card"
    >
      {/* Card label */}
      <div className="flex items-center justify-between">
        <span className="text-xs font-mono font-semibold uppercase tracking-wide text-slate-400">
          {title}
        </span>

        <div className="flex items-center gap-1.5">
          {/* Arbitrary badge (e.g. "MOCK SEED") — rule.md §3.6 */}
          {badge && !isLoading && (
            <span
              data-testid="mode-badge"
              className="text-[10px] font-mono px-2 py-0.5 rounded bg-slate-800 border border-slate-700 text-slate-400"
            >
              {badge}
            </span>
          )}

          {/* Stale badge */}
          {isStale && !isLoading && (
            <span
              data-testid="stale-badge"
              className="text-[10px] font-mono px-2 py-0.5 rounded bg-amber-950 border border-amber-700 text-amber-400"
            >
              stale · retrying
            </span>
          )}
        </div>
      </div>

      {/* Big value area */}
      {isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-9 w-36" />
          <Skeleton className="h-4 w-48" />
        </div>
      ) : isEmpty ? (
        <div className="space-y-1">
          <span
            data-testid="empty-dash"
            className="text-4xl font-extrabold text-slate-500 leading-none tracking-tight"
          >
            —
          </span>
          <p className="text-xs text-slate-500" data-testid="empty-subline">
            No activity yet
          </p>
        </div>
      ) : (
        <div className="space-y-1">
          <span
            data-testid="metric-value"
            className="text-4xl font-extrabold text-white leading-none tracking-tight"
            style={{
              transition: 'opacity 0.4s ease, transform 0.4s ease',
              opacity: animating ? 0.4 : 1,
              transform: animating ? 'scale(0.96)' : 'scale(1)',
            }}
          >
            {displayedValue}
          </span>
          <p className="text-xs text-slate-400" data-testid="metric-subline">
            {subLine}
          </p>
        </div>
      )}
    </div>
  );
}

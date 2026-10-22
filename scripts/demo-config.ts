/**
 * Shared demo configuration for scripts/demo-*.ts.
 *
 * Step-up approvals expire after mandate.step_up.timeout_seconds. The library default is 300s;
 * demo scripts use 900s (15 min) so a card does not expire in the middle of a video recording.
 * Override with DEMO_STEP_UP_TIMEOUT_SECONDS.
 */
export const DEMO_STEP_UP_TIMEOUT_SECONDS: number = (() => {
  const raw = Number(process.env['DEMO_STEP_UP_TIMEOUT_SECONDS'] ?? 900);
  return Number.isInteger(raw) && raw > 0 ? raw : 900;
})();

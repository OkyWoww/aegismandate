import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const TOTAL_RUNS = 20;
let passCount = 0;
let failCount = 0;
const results: Array<{ run: number; status: 'PASS' | 'FAIL'; captureId?: string; durationMs: number; error?: string }> = [];

console.log('='.repeat(80));
console.log(` STARTING 20-RUN CONSECUTIVE LIVE SANDBOX VERIFICATION GATE (T-025 / T-029)`);
console.log(` Target Command: pnpm e2e:live`);
console.log(` Total Runs    : ${TOTAL_RUNS}`);
console.log('='.repeat(80));

const logDir = path.resolve('data/live-20-runs');
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

for (let i = 1; i <= TOTAL_RUNS; i++) {
  const t0 = Date.now();
  console.log(`\n>>> [RUN ${String(i).padStart(2, '0')}/${TOTAL_RUNS}] Executing live PayPal sandbox capture...`);
  try {
    const rawOutput = execSync('pnpm e2e:live', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 90000,
    });

    const elapsed = Date.now() - t0;
    fs.writeFileSync(path.join(logDir, `run-${String(i).padStart(2, '0')}.log`), rawOutput, 'utf8');

    const captureMatch = rawOutput.match(/Authentic Capture ID\s*:\s*([A-Za-z0-9]+)/);
    const captureId = captureMatch ? captureMatch[1] : undefined;

    if (rawOutput.includes('LIVE E2E VERIFICATION COMPLETED (PASS)') && captureId) {
      passCount++;
      results.push({ run: i, status: 'PASS', captureId, durationMs: elapsed });
      console.log(`    Result: ✅ PASS in ${elapsed}ms | Authentic Capture ID: ${captureId} (${passCount}/${i} passed)`);
    } else {
      failCount++;
      results.push({ run: i, status: 'FAIL', durationMs: elapsed, error: 'Verification marker missing' });
      console.log(`    Result: ❌ FAIL in ${elapsed}ms | Unexpected output`);
    }
  } catch (err: unknown) {
    const elapsed = Date.now() - t0;
    failCount++;
    const errObj = err as { stdout?: string; stderr?: string; message?: string };
    const errMsg = errObj.message || String(err);
    const errOutput = String(errObj.stdout || '') + '\n' + String(errObj.stderr || errMsg);
    fs.writeFileSync(path.join(logDir, `run-${String(i).padStart(2, '0')}-fail.log`), errOutput, 'utf8');
    results.push({ run: i, status: 'FAIL', durationMs: elapsed, error: errMsg });
    console.log(`    Result: ❌ FAIL in ${elapsed}ms | Error: ${errMsg}`);
  }
}

console.log('\n' + '='.repeat(80));
console.log(` 20-RUN LIVE SANDBOX GATE EXECUTION SUMMARY`);
console.log('='.repeat(80));
console.log(` Total Runs Completed : ${TOTAL_RUNS}`);
console.log(` Passed               : ${passCount} / ${TOTAL_RUNS}`);
console.log(` Failed               : ${failCount} / ${TOTAL_RUNS}`);
console.log(` Success Rate         : ${((passCount / TOTAL_RUNS) * 100).toFixed(1)}%`);
console.log('='.repeat(80));

for (const r of results) {
  const mark = r.status === 'PASS' ? '✅ PASS' : '❌ FAIL';
  const detail = r.captureId ? `Capture ID: ${r.captureId}` : `Error: ${r.error}`;
  console.log(`Run ${String(r.run).padStart(2, '0')}: ${mark} (${r.durationMs}ms) - ${detail}`);
}
console.log('='.repeat(80));

if (failCount > 0) {
  process.exit(1);
} else {
  process.exit(0);
}

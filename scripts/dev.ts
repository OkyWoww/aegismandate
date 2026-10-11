/**
 * MandatePay Local Development Orchestrator (Task T-016)
 * Concurrently boots Fastify API (port 3001) and Vite Dashboard (port 3000).
 * Handles graceful process shutdown with zero orphaned background tasks.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { runSeed } from '../apps/stores/src/index.js';

const API_PORT = process.env.PORT || '3001';
const WEB_PORT = process.env.WEB_PORT || '3000';
const DB_PATH = process.env.DB_PATH || './data/mandatepay.db';

async function main() {
  console.log('='.repeat(70));
  console.log(' MANDATEPAY LOCAL DEVELOPMENT ORCHESTRATOR');
  console.log('='.repeat(70));

  // 1. Ensure DB directory and seed if needed
  const dbDir = path.dirname(DB_PATH);
  if (dbDir && !fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  if (!fs.existsSync(DB_PATH)) {
    console.log('[Seed] Database file not found. Seeding initial demo data...');
    runSeed({ dbPath: DB_PATH });
    console.log('[Seed] Initial demo data seeded successfully.');
  } else {
    console.log(`[DB] Using existing database: ${DB_PATH}`);
  }

  console.log('\n[Booting Services]');
  console.log(`  - Control Plane API:   http://localhost:${API_PORT}`);
  console.log(`  - Web Operator UI:     http://localhost:${WEB_PORT}`);
  console.log(`  - Health Probe:        http://localhost:${API_PORT}/health`);
  console.log('='.repeat(70) + '\n');

  const children: ChildProcess[] = [];

  const cleanup = () => {
    console.log('\n[Shutdown] Terminating MandatePay services cleanly...');
    for (const child of children) {
      if (child && !child.killed) {
        try {
          if (process.platform === 'win32' && child.pid) {
            spawn('taskkill', ['/pid', child.pid.toString(), '/f', '/t']);
          } else {
            child.kill('SIGTERM');
          }
        } catch {
          // ignore error on exit
        }
      }
    }
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  process.on('exit', cleanup);

  // 2. Spawn Fastify API
  const apiProcess = spawn('npx', ['tsx', 'apps/api/src/index.ts'], {
    env: { ...process.env, PORT: API_PORT },
    stdio: 'inherit',
    shell: true,
  });
  children.push(apiProcess);

  // 3. Spawn Vite Web Dashboard
  const webProcess = spawn('npx', ['vite', `--port=${WEB_PORT}`, '--host=0.0.0.0'], {
    env: { ...process.env, VITE_API_URL: `http://localhost:${API_PORT}` },
    stdio: 'inherit',
    shell: true,
  });
  children.push(webProcess);

  apiProcess.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.error(`[API Process] Exited unexpectedly with code ${code}`);
      cleanup();
    }
  });

  webProcess.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.error(`[Web Process] Exited unexpectedly with code ${code}`);
      cleanup();
    }
  });
}

main().catch((err) => {
  console.error('[Orchestrator Fatal Error]:', err);
  process.exit(1);
});

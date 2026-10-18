import { openDb, verifyAuditLedger } from '../packages/audit/src/index.js';
import { MandateService, initMandateTables } from '../apps/api/src/mandate-service.js';
import { initExecutorTables, sweepExpiredIntents } from '../apps/api/src/executor.js';
import { runSeed } from '../apps/stores/src/index.js';
import path from 'node:path';
import fs from 'node:fs';

const DB_PATH = path.resolve(process.cwd(), './data/verify-sweeper-state.db');
const HMAC_KEY = 'c60ce1e12686c9af19411c60913db7c25a3ccbc241dfcf9b8f321e4cac148a2c';

if (fs.existsSync(DB_PATH)) {
  try { fs.unlinkSync(DB_PATH); } catch { /* ignore */ }
}

runSeed({ dbPath: DB_PATH, hmacKey: HMAC_KEY });
const db = openDb(DB_PATH);
initMandateTables(db);
initExecutorTables(db);
const mandateService = new MandateService(db, HMAC_KEY);

const now = new Date();
const pastDate = new Date(now.getTime() - 3600 * 1000).toISOString();
const expiredDate = new Date(now.getTime() - 1800 * 1000).toISOString();
const currentDate = now.toISOString();

// Run 02 intent simulation (PayPal Order 4BB568059X548430E)
const intent02 = 'int_e2e_run02_4BB568';
mandateService.reserve({
  mandateId: 'mnd_demo_001',
  intentId: intent02,
  amountMinor: 900,
});
db.prepare(`
  INSERT INTO executed_intents (
    intent_id, mandate_id, verdict, status, order_id,
    decision_json, expires_at, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run(
  intent02, 'mnd_demo_001', 'ALLOW', 'AWAITING_PAYER_APPROVAL', '4BB568059X548430E',
  JSON.stringify({ verdict: 'ALLOW', approved: true }), expiredDate, pastDate, pastDate
);

// Run 03 intent simulation (PayPal Order 3TB6499366333323A)
const intent03 = 'int_e2e_run03_3TB649';
mandateService.reserve({
  mandateId: 'mnd_demo_001',
  intentId: intent03,
  amountMinor: 900,
});
db.prepare(`
  INSERT INTO executed_intents (
    intent_id, mandate_id, verdict, status, order_id,
    decision_json, expires_at, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run(
  intent03, 'mnd_demo_001', 'ALLOW', 'AWAITING_PAYER_APPROVAL', '3TB6499366333323A',
  JSON.stringify({ verdict: 'ALLOW', approved: true }), expiredDate, pastDate, pastDate
);

console.log('='.repeat(80));
console.log(' STATE OF FAILED RUN 02 & RUN 03 BEFORE SWEEPER:');
console.log('='.repeat(80));
const beforeIntents = db.prepare('SELECT intent_id, status, order_id, expires_at, refusal_reason FROM executed_intents WHERE intent_id IN (?, ?)').all(intent02, intent03);
console.log('Executed Intents:', JSON.stringify(beforeIntents, null, 2));

const beforeReservations = db.prepare('SELECT intent_id, state, amount_minor FROM reservations WHERE intent_id IN (?, ?)').all(intent02, intent03);
console.log('Reservations:', JSON.stringify(beforeReservations, null, 2));

console.log('\n>>> EXECUTING SWEEPER (sweepExpiredIntents)...');
const swept = sweepExpiredIntents(db, mandateService, currentDate);
console.log(`Swept Intent IDs (${swept.length}):`, swept);

console.log('\n' + '='.repeat(80));
console.log(' STATE OF FAILED RUN 02 & RUN 03 AFTER SWEEPER:');
console.log('='.repeat(80));
const afterIntents = db.prepare('SELECT intent_id, status, order_id, expires_at, refusal_reason FROM executed_intents WHERE intent_id IN (?, ?)').all(intent02, intent03);
console.log('Executed Intents:', JSON.stringify(afterIntents, null, 2));

const afterReservations = db.prepare('SELECT intent_id, state, amount_minor FROM reservations WHERE intent_id IN (?, ?)').all(intent02, intent03);
console.log('Reservations (HELD -> RELEASED):', JSON.stringify(afterReservations, null, 2));

console.log('\n' + '='.repeat(80));
console.log(' CRYPTOGRAPHIC AUDIT VERIFICATION (GET /v1/audit/verify):');
console.log('='.repeat(80));
const auditVerify = verifyAuditLedger(db);
console.log('verifyAuditLedger result:', JSON.stringify(auditVerify, null, 2));

const expiryAuditEvents = db.prepare("SELECT seq, ts, type, actor, ref, payload, hash FROM audit_events WHERE type = 'INTENT_EXPIRED'").all();
console.log('INTENT_EXPIRED Audit Events:', JSON.stringify(expiryAuditEvents, null, 2));

db.close();
try { fs.unlinkSync(DB_PATH); } catch { /* ignore */ }

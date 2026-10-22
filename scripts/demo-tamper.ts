/**
 * Demo helper: modify ONE audit row so "Verify Ledger Integrity" turns red.
 * Use only on the local demo database, never on evidence data.
 *
 *   pnpm demo:tamper           # flips one byte of a payload in the demo DB
 *   pnpm demo:tamper --restore # restores the original payload
 */
import 'dotenv/config';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';

const DB_PATH = process.env['DB_PATH'] ?? './data/mandatepay.db';
const BACKUP = `${DB_PATH}.tamper-backup.json`;

function main() {
  const restore = process.argv.includes('--restore');
  const db = new DatabaseSync(DB_PATH);
  try {
    if (restore) {
      if (!fs.existsSync(BACKUP)) {
        console.log('Nothing to restore (no backup file).');
        return;
      }
      const { seq, payload } = JSON.parse(fs.readFileSync(BACKUP, 'utf8')) as { seq: number; payload: string };
      db.prepare('UPDATE audit_events SET payload = ? WHERE seq = ?').run(payload, seq);
      fs.unlinkSync(BACKUP);
      console.log(`Restored audit_events seq=${seq}.`);
      return;
    }

    const row = db
      .prepare("SELECT seq, payload FROM audit_events WHERE type = 'ORDER_CAPTURED' OR type = 'INTENT_RECEIVED' ORDER BY seq DESC LIMIT 1")
      .get() as { seq: number; payload: string } | undefined;
    if (!row) {
      console.log('No suitable audit row found. Run pnpm demo:seed first.');
      process.exit(1);
    }
    if (fs.existsSync(BACKUP)) {
      console.log('Already tampered. Run with --restore first.');
      process.exit(1);
    }
    fs.writeFileSync(BACKUP, JSON.stringify(row));
    const tampered = row.payload.replace(/\d/, (d) => String((Number(d) + 1) % 10));
    db.prepare('UPDATE audit_events SET payload = ? WHERE seq = ?').run(tampered, row.seq);
    console.log(`Tampered audit_events seq=${row.seq} (one digit changed). Click Verify Ledger Integrity.`);
  } finally {
    db.close();
  }
}

main();

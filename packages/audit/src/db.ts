import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface DatabasePreparedStatement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Array<Record<string, unknown>>;
}

export interface DatabaseConnection {
  exec(sql: string): void;
  pragma(pragmaStr: string): unknown;
  prepare(sql: string): DatabasePreparedStatement;
  close(): void;
  isOpen(): boolean;
  isInTransaction(): boolean;
}

/**
 * Creates and initializes a SQLite connection conforming strictly to tech.md §1.1:
 * Built on Node 22+ built-in node:sqlite (DatabaseSync)
 * - WAL mode (journal_mode = WAL)
 * - busy_timeout = 5000 (competing BEGIN IMMEDIATE waits instead of throwing SQLITE_BUSY)
 * - synchronous = NORMAL (safe with WAL, faster commits)
 * - foreign_keys = ON
 */
export function openDb(dbPath: string): DatabaseConnection {
  // Ensure parent directory exists for file-based DBs
  if (dbPath !== ':memory:' && !dbPath.startsWith('file::memory:')) {
    const dir = path.dirname(dbPath);
    if (dir && dir !== '.' && !fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  const rawDb = new DatabaseSync(dbPath);
  let opened = true;
  let inTx = false;

  const dbInstance: DatabaseConnection = {
    exec: (sql: string) => {
      const trimmed = sql.trim().toUpperCase();
      if (trimmed.startsWith('BEGIN')) inTx = true;
      if (trimmed.startsWith('COMMIT') || trimmed.startsWith('ROLLBACK')) inTx = false;
      return rawDb.exec(sql);
    },
    pragma: (pragmaStr: string) => {
      return rawDb.exec(`PRAGMA ${pragmaStr};`);
    },
    prepare: (sql: string) => {
      const stmt = rawDb.prepare(sql);
      return {
        run: (...params: unknown[]) => {
          const res = (stmt.run as (...args: unknown[]) => { changes: number | bigint; lastInsertRowid: number | bigint })(...params);
          return {
            changes: Number(res.changes),
            lastInsertRowid: res.lastInsertRowid,
          };
        },
        get: (...params: unknown[]) => (stmt.get as (...args: unknown[]) => Record<string, unknown> | undefined)(...params),
        all: (...params: unknown[]) => (stmt.all as (...args: unknown[]) => Array<Record<string, unknown>>)(...params),
      };
    },
    close: () => {
      opened = false;
      rawDb.close();
    },
    isOpen: () => opened,
    isInTransaction: () => inTx,
  };

  // Set mandatory SQLite pragmas per tech.md §1.1
  dbInstance.pragma('journal_mode = WAL');
  dbInstance.pragma('busy_timeout = 5000');
  dbInstance.pragma('synchronous = NORMAL');
  dbInstance.pragma('foreign_keys = ON');

  return dbInstance;
}

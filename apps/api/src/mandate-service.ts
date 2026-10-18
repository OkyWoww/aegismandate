import { randomUUID } from 'node:crypto';
import type { DatabaseConnection } from '@mandatepay/audit';
import { appendAuditEvent, initAuditTable } from '@mandatepay/audit';
import {
  MandateSchema,
  type Mandate,
  type MandateSpend,
  type MandateReservation,
  type MandateWallet,
  type AuditActor,
} from '@mandatepay/schemas';
import {
  createDraftMandate,
  activateDraftMandate,
  createNewMandateVersion,
  checkMandateUsable,
  isMandateExpired,
  assertValidMandateTransition,
  signMandate,
  type DraftMandateInput,
} from '@mandatepay/policy';

/**
 * Initializes SQLite tables for Mandate management and Reservation accounting
 * per design.md §5 and spec.md §2 (FR-1 to FR-6, FR-26).
 */
export function initMandateTables(db: DatabaseConnection): void {
  initAuditTable(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS mandates (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      status TEXT NOT NULL,
      json TEXT NOT NULL,
      version INTEGER NOT NULL,
      signature TEXT NOT NULL,
      valid_from TEXT NOT NULL,
      valid_until TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_mandates_owner ON mandates(owner_id);
    CREATE INDEX IF NOT EXISTS idx_mandates_status ON mandates(status);

    CREATE TABLE IF NOT EXISTS mandate_spend (
      mandate_id TEXT PRIMARY KEY,
      captured_minor INTEGER NOT NULL DEFAULT 0,
      reserved_minor INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (mandate_id) REFERENCES mandates(id)
    );

    CREATE TABLE IF NOT EXISTS reservations (
      id TEXT PRIMARY KEY,
      mandate_id TEXT NOT NULL,
      intent_id TEXT NOT NULL UNIQUE,
      amount_minor INTEGER NOT NULL,
      state TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (mandate_id) REFERENCES mandates(id)
    );
    CREATE INDEX IF NOT EXISTS idx_res_mandate ON reservations(mandate_id);
    CREATE INDEX IF NOT EXISTS idx_res_intent ON reservations(intent_id);
  `);
}

export function withImmediateTransaction<T>(
  db: DatabaseConnection,
  fn: () => T,
  maxRetries = 10,
  delayMs = 25,
): T {
  if (db.isInTransaction()) {
    return fn();
  }
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = fn();
        db.exec('COMMIT');
        return result;
      } catch (err) {
        try {
          db.exec('ROLLBACK');
        } catch {
          // ignore rollback failure
        }
        throw err;
      }
    } catch (err: unknown) {
      const msg = String(err);
      const isBusy = msg.includes('SQLITE_BUSY') || msg.includes('busy') || msg.includes('locked');
      if (isBusy && attempt < maxRetries) {
        const jitter = Math.floor(Math.random() * 15);
        const wait = delayMs * Math.pow(1.5, attempt) + jitter;
        const start = Date.now();
        while (Date.now() - start < wait) {
          // busy spin wait
        }
        continue;
      }
      throw err;
    }
  }
  throw new Error('Transaction failed after maximum retries');
}

export interface ReserveParams {
  mandateId: string;
  intentId: string;
  amountMinor: number;
}

export interface ReserveResult {
  success: boolean;
  reservation?: MandateReservation;
  spend?: MandateSpend;
  reason?: string;
}

export interface ReleaseResult {
  success: boolean;
  releasedMinor?: number;
  reason?: string;
}

export interface CaptureResult {
  success: boolean;
  capturedMinor?: number;
  reason?: string;
}

/**
 * Stateful Mandate Control Plane Service (Trusted Control Plane).
 * Guarantees:
 * - SQLite atomic transactions (BEGIN IMMEDIATE in WAL mode)
 * - Reservation spend tracking (captured_minor, reserved_minor per FR-26)
 * - Invariant: captured_minor + reserved_minor <= total_budget_minor (INV-8)
 * - Immutable mandate documents once signed with version incrementing (spec.md §3.1)
 * - HMAC-SHA256 signature verification (FR-6)
 * - Cryptographic audit logging for all lifecycle transitions (FR-21)
 */
export class MandateService {
  constructor(
    private readonly db: DatabaseConnection,
    private readonly hmacKey: string,
    private readonly getNow: () => string = () => new Date().toISOString(),
  ) {
    initMandateTables(this.db);
  }

  /**
   * Creates a new DRAFT mandate (FR-1, FR-2).
   */
  public createDraft(input: DraftMandateInput, actor: AuditActor = 'user'): Mandate {
    const now = this.getNow();
    const draft = createDraftMandate(input);

    return withImmediateTransaction(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO mandates (id, owner_id, agent_id, status, json, version, signature, valid_from, valid_until, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          draft.mandate_id,
          draft.owner_id,
          draft.agent_id,
          draft.status,
          JSON.stringify(draft),
          draft.version,
          draft.signature,
          draft.valid_from,
          draft.valid_until,
          draft.created_at,
          now,
        );

      this.db
        .prepare(
          `INSERT INTO mandate_spend (mandate_id, captured_minor, reserved_minor, updated_at)
           VALUES (?, 0, 0, ?)`,
        )
        .run(draft.mandate_id, now);

      appendAuditEvent(this.db, {
        actor,
        type: 'MANDATE_CREATED',
        ref: draft.mandate_id,
        payload: {
          mandate_id: draft.mandate_id,
          status: draft.status,
          owner_id: draft.owner_id,
          total_budget_minor: draft.total_budget_minor,
          version: draft.version,
        },
        ts: now,
      });

      return draft;
    });
  }

  /**
   * Activates a DRAFT mandate by linking wallet, signing with HMAC-SHA256,
   * and transitioning status to 'ACTIVE' (FR-2, FR-6).
   */
  public activate(
    mandateId: string,
    wallet?: MandateWallet,
    actor: AuditActor = 'user',
  ): Mandate {
    const now = this.getNow();

    return withImmediateTransaction(this.db, () => {
      const current = this.getRawMandate(mandateId);
      if (!current) {
        throw new Error(`Mandate '${mandateId}' not found`);
      }

      assertValidMandateTransition(current.status, 'ACTIVE');

      const active = activateDraftMandate(current, this.hmacKey, wallet);

      this.db
        .prepare(
          `UPDATE mandates
           SET status = ?, json = ?, signature = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(active.status, JSON.stringify(active), active.signature, now, mandateId);

      appendAuditEvent(this.db, {
        actor,
        type: 'MANDATE_ACTIVATED',
        ref: mandateId,
        payload: {
          mandate_id: mandateId,
          status: active.status,
          signature: active.signature,
          wallet: active.wallet,
        },
        ts: now,
      });

      return active;
    });
  }

  /**
   * Revokes a mandate at any time → 'REVOKED' (FR-4).
   * Revocation takes immediate effect for all in-flight, not-yet-executed intents
   * and releases all pending 'HELD' reservations.
   */
  public revoke(
    mandateId: string,
    reason = 'User requested revocation',
    actor: AuditActor = 'user',
  ): Mandate {
    const now = this.getNow();

    return withImmediateTransaction(this.db, () => {
      const current = this.getRawMandate(mandateId);
      if (!current) {
        throw new Error(`Mandate '${mandateId}' not found`);
      }

      assertValidMandateTransition(current.status, 'REVOKED');

      const revokedDoc = signMandate(
        {
          ...current,
          status: 'REVOKED',
        },
        this.hmacKey,
      );

      this.db
        .prepare(
          `UPDATE mandates
           SET status = 'REVOKED', json = ?, signature = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(JSON.stringify(revokedDoc), revokedDoc.signature, now, mandateId);

      // Release all pending HELD reservations immediately
      this.db
        .prepare(
          `UPDATE reservations
           SET state = 'RELEASED', updated_at = ?
           WHERE mandate_id = ? AND state = 'HELD'`,
        )
        .run(now, mandateId);

      // Reset reserved_minor in mandate_spend
      this.db
        .prepare(
          `UPDATE mandate_spend
           SET reserved_minor = 0, updated_at = ?
           WHERE mandate_id = ?`,
        )
        .run(now, mandateId);

      appendAuditEvent(this.db, {
        actor,
        type: 'MANDATE_REVOKED',
        ref: mandateId,
        payload: {
          mandate_id: mandateId,
          reason,
        },
        ts: now,
      });

      return revokedDoc;
    });
  }

  /**
   * Suspends an ACTIVE mandate (e.g. circuit breaker trigger per FR-30).
   */
  public suspend(
    mandateId: string,
    reason = 'Circuit breaker triggered',
    actor: AuditActor = 'control_plane',
  ): Mandate {
    const now = this.getNow();

    return withImmediateTransaction(this.db, () => {
      const current = this.getRawMandate(mandateId);
      if (!current) {
        throw new Error(`Mandate '${mandateId}' not found`);
      }

      assertValidMandateTransition(current.status, 'SUSPENDED');

      const suspendedDoc = signMandate(
        {
          ...current,
          status: 'SUSPENDED',
        },
        this.hmacKey,
      );

      this.db
        .prepare(
          `UPDATE mandates
           SET status = 'SUSPENDED', json = ?, signature = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(JSON.stringify(suspendedDoc), suspendedDoc.signature, now, mandateId);

      appendAuditEvent(this.db, {
        actor,
        type: 'MANDATE_SUSPENDED',
        ref: mandateId,
        payload: {
          mandate_id: mandateId,
          reason,
        },
        ts: now,
      });

      return suspendedDoc;
    });
  }

  /**
   * Resumes a SUSPENDED mandate back to 'ACTIVE' (FR-30).
   */
  public resume(mandateId: string, actor: AuditActor = 'user'): Mandate {
    const now = this.getNow();

    return withImmediateTransaction(this.db, () => {
      const current = this.getRawMandate(mandateId);
      if (!current) {
        throw new Error(`Mandate '${mandateId}' not found`);
      }

      assertValidMandateTransition(current.status, 'ACTIVE');

      // If expired while suspended, transition to EXPIRED instead
      if (isMandateExpired(current, now)) {
        return this.markExpired(current, now);
      }

      const activeDoc = signMandate(
        {
          ...current,
          status: 'ACTIVE',
        },
        this.hmacKey,
      );

      this.db
        .prepare(
          `UPDATE mandates
           SET status = 'ACTIVE', json = ?, signature = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(JSON.stringify(activeDoc), activeDoc.signature, now, mandateId);

      appendAuditEvent(this.db, {
        actor,
        type: 'MANDATE_RESUMED',
        ref: mandateId,
        payload: {
          mandate_id: mandateId,
        },
        ts: now,
      });

      return activeDoc;
    });
  }

  /**
   * Retrieves a mandate by ID and auto-expires if past valid_until (FR-3, NFR-6).
   */
  public getMandate(mandateId: string): Mandate | null {
    const current = this.getRawMandate(mandateId);
    if (!current) return null;

    const now = this.getNow();

    // Check TTL expiry
    if (
      (current.status === 'ACTIVE' || current.status === 'SUSPENDED') &&
      isMandateExpired(current, now)
    ) {
      return withImmediateTransaction(this.db, () => this.markExpired(current, now));
    }

    return current;
  }

  /**
   * Updates mandate configuration by creating a new version (spec.md §3.1).
   * Increments version, preserves document immutability, re-signs with HMAC.
   */
  public updateMandateConfig(
    mandateId: string,
    updates: Partial<Omit<Mandate, 'mandate_id' | 'version' | 'created_at' | 'signature'>>,
    actor: AuditActor = 'user',
  ): Mandate {
    const now = this.getNow();

    return withImmediateTransaction(this.db, () => {
      const current = this.getRawMandate(mandateId);
      if (!current) {
        throw new Error(`Mandate '${mandateId}' not found`);
      }
      if (current.status !== 'ACTIVE' && current.status !== 'DRAFT') {
        throw new Error(`Cannot update mandate in '${current.status}' status`);
      }

      const nextVersion = createNewMandateVersion(current, updates, this.hmacKey);

      this.db
        .prepare(
          `UPDATE mandates
           SET version = ?, json = ?, signature = ?, valid_until = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          nextVersion.version,
          JSON.stringify(nextVersion),
          nextVersion.signature,
          nextVersion.valid_until,
          now,
          mandateId,
        );

      appendAuditEvent(this.db, {
        actor,
        type: 'MANDATE_UPDATED',
        ref: mandateId,
        payload: {
          mandate_id: mandateId,
          version: nextVersion.version,
          total_budget_minor: nextVersion.total_budget_minor,
          per_txn_limit_minor: nextVersion.per_txn_limit_minor,
        },
        ts: now,
      });

      return nextVersion;
    });
  }

  /**
   * Atomically reserves spend budget for a purchase intent proposal (FR-26, INV-8).
   * Invariant: captured_minor + reserved_minor + amount <= total_budget_minor.
   * Single BEGIN IMMEDIATE transaction guarantees zero race conditions under concurrency.
   */
  public reserve(params: ReserveParams): ReserveResult {
    const { mandateId, intentId, amountMinor } = params;
    const now = this.getNow();

    return withImmediateTransaction(this.db, () => {
      // 1. Check idempotency: if reservation already exists for this intent_id
      const existing = this.db
        .prepare('SELECT id, mandate_id, intent_id, amount_minor, state, created_at, updated_at FROM reservations WHERE intent_id = ?')
        .get(intentId) as MandateReservation | undefined;

      if (existing) {
        const spend = this.getSpend(mandateId);
        return {
          success: true,
          reservation: existing,
          spend,
        };
      }

      // 2. Fetch and validate mandate usability
      const mandate = this.getMandate(mandateId);
      if (!mandate) {
        return { success: false, reason: 'MANDATE_NOT_FOUND' };
      }

      const check = checkMandateUsable(mandate, this.hmacKey, now);
      if (!check.usable) {
        return { success: false, reason: check.reasonCode ?? 'MANDATE_NOT_USABLE' };
      }

      // 3. Check per-transaction limit
      if (amountMinor > mandate.per_txn_limit_minor) {
        return {
          success: false,
          reason: 'ITEM_CAP_EXCEEDED',
        };
      }

      // 4. Check total budget invariant: captured + reserved + amount <= total_budget (INV-8)
      const spend = this.getSpend(mandateId);
      const totalCommitted = spend.captured_minor + spend.reserved_minor;

      if (totalCommitted + amountMinor > mandate.total_budget_minor) {
        return {
          success: false,
          reason: 'BUDGET_EXCEEDED',
          spend,
        };
      }

      // 5. Atomic write: insert reservation & increment reserved_minor
      const resId = `res_${randomUUID().replace(/-/g, '')}`;
      this.db
        .prepare(
          `INSERT INTO reservations (id, mandate_id, intent_id, amount_minor, state, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'HELD', ?, ?)`,
        )
        .run(resId, mandateId, intentId, amountMinor, now, now);

      this.db
        .prepare(
          `UPDATE mandate_spend
           SET reserved_minor = reserved_minor + ?, updated_at = ?
           WHERE mandate_id = ?`,
        )
        .run(amountMinor, now, mandateId);

      const updatedSpend = this.getSpend(mandateId);
      const reservation: MandateReservation = {
        id: resId,
        mandate_id: mandateId,
        intent_id: intentId,
        amount_minor: amountMinor,
        state: 'HELD',
        created_at: now,
        updated_at: now,
      };

      appendAuditEvent(this.db, {
        actor: 'control_plane',
        type: 'BUDGET_RESERVED',
        ref: intentId,
        payload: {
          reservation_id: resId,
          mandate_id: mandateId,
          intent_id: intentId,
          amount_minor: amountMinor,
          reserved_total_minor: updatedSpend.reserved_minor,
          captured_total_minor: updatedSpend.captured_minor,
        },
        ts: now,
      });

      return {
        success: true,
        reservation,
        spend: updatedSpend,
      };
    });
  }

  /**
   * Releases a HELD reservation back to available budget (FR-26).
   * Called on intent rejection, failure, timeout, or void.
   */
  public releaseReservation(intentId: string, reason = 'Intent rejected or timed out'): ReleaseResult {
    const now = this.getNow();

    return withImmediateTransaction(this.db, () => {
      const res = this.db
        .prepare('SELECT id, mandate_id, intent_id, amount_minor, state, created_at, updated_at FROM reservations WHERE intent_id = ?')
        .get(intentId) as MandateReservation | undefined;

      if (!res) {
        return { success: false, reason: 'RESERVATION_NOT_FOUND' };
      }
      if (res.state !== 'HELD') {
        return { success: false, reason: `RESERVATION_ALREADY_${res.state}` };
      }

      this.db
        .prepare(
          `UPDATE reservations
           SET state = 'RELEASED', updated_at = ?
           WHERE id = ?`,
        )
        .run(now, res.id);

      this.db
        .prepare(
          `UPDATE mandate_spend
           SET reserved_minor = MAX(0, reserved_minor - ?), updated_at = ?
           WHERE mandate_id = ?`,
        )
        .run(res.amount_minor, now, res.mandate_id);

      appendAuditEvent(this.db, {
        actor: 'control_plane',
        type: 'BUDGET_RELEASED',
        ref: intentId,
        payload: {
          reservation_id: res.id,
          mandate_id: res.mandate_id,
          intent_id: intentId,
          released_minor: res.amount_minor,
          reason,
        },
        ts: now,
      });

      return {
        success: true,
        releasedMinor: res.amount_minor,
      };
    });
  }

  /**
   * Captures a HELD reservation upon successful PayPal capture settlement (FR-26).
   * Decrements reserved_minor and increments captured_minor atomically.
   */
  public captureReservation(intentId: string, actualCapturedMinor?: number): CaptureResult {
    const now = this.getNow();

    return withImmediateTransaction(this.db, () => {
      const res = this.db
        .prepare('SELECT id, mandate_id, intent_id, amount_minor, state, created_at, updated_at FROM reservations WHERE intent_id = ?')
        .get(intentId) as MandateReservation | undefined;

      if (!res) {
        return { success: false, reason: 'RESERVATION_NOT_FOUND' };
      }
      if (res.state !== 'HELD') {
        return { success: false, reason: `RESERVATION_ALREADY_${res.state}` };
      }

      const finalCaptured = actualCapturedMinor ?? res.amount_minor;

      this.db
        .prepare(
          `UPDATE reservations
           SET state = 'CAPTURED', updated_at = ?
           WHERE id = ?`,
        )
        .run(now, res.id);

      this.db
        .prepare(
          `UPDATE mandate_spend
           SET reserved_minor = MAX(0, reserved_minor - ?),
               captured_minor = captured_minor + ?,
               updated_at = ?
           WHERE mandate_id = ?`,
        )
        .run(res.amount_minor, finalCaptured, now, res.mandate_id);

      appendAuditEvent(this.db, {
        actor: 'control_plane',
        type: 'BUDGET_CAPTURED',
        ref: intentId,
        payload: {
          reservation_id: res.id,
          mandate_id: res.mandate_id,
          intent_id: intentId,
          held_minor: res.amount_minor,
          captured_minor: finalCaptured,
        },
        ts: now,
      });

      return {
        success: true,
        capturedMinor: finalCaptured,
      };
    });
  }

  /**
   * Fetches the current spend totals for a mandate.
   */
  public getSpend(mandateId: string): MandateSpend {
    const row = this.db
      .prepare('SELECT mandate_id, captured_minor, reserved_minor, updated_at FROM mandate_spend WHERE mandate_id = ?')
      .get(mandateId) as MandateSpend | undefined;

    if (!row) {
      return {
        mandate_id: mandateId,
        captured_minor: 0,
        reserved_minor: 0,
        updated_at: this.getNow(),
      };
    }
    return row;
  }

  /**
   * Fetches a single reservation by intent_id.
   */
  public getReservation(intentId: string): MandateReservation | null {
    const row = this.db
      .prepare('SELECT id, mandate_id, intent_id, amount_minor, state, created_at, updated_at FROM reservations WHERE intent_id = ?')
      .get(intentId) as MandateReservation | undefined;
    return row ?? null;
  }

  /**
   * Fetches all reservations for a mandate.
   */
  public getReservations(mandateId: string): MandateReservation[] {
    const rows = this.db
      .prepare('SELECT id, mandate_id, intent_id, amount_minor, state, created_at, updated_at FROM reservations WHERE mandate_id = ? ORDER BY created_at ASC')
      .all(mandateId) as unknown as MandateReservation[];

    return rows;
  }

  private getRawMandate(mandateId: string): Mandate | null {
    const row = this.db
      .prepare('SELECT json FROM mandates WHERE id = ?')
      .get(mandateId) as { json: string } | undefined;

    if (!row) return null;
    return MandateSchema.parse(JSON.parse(row.json));
  }

  private markExpired(current: Mandate, now: string): Mandate {
    const expiredDoc = signMandate(
      {
        ...current,
        status: 'EXPIRED',
      },
      this.hmacKey,
    );

    this.db
      .prepare(
        `UPDATE mandates
         SET status = 'EXPIRED', json = ?, signature = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(JSON.stringify(expiredDoc), expiredDoc.signature, now, current.mandate_id);

    appendAuditEvent(this.db, {
      actor: 'control_plane',
      type: 'MANDATE_EXPIRED',
      ref: current.mandate_id,
      payload: {
        mandate_id: current.mandate_id,
        expired_at: now,
      },
      ts: now,
    });

    return expiredDoc;
  }
}

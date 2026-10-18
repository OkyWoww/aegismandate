# tasks.md — Phased Plan (7 Oct → 12 Nov 2026)

Dates are WIB. **Feature freeze: 5 Nov.** **Internal submit: 10 Nov.** Hard deadline: 12 Nov 12:00 PT (13 Nov 03:00 WIB).
Every task's DoD is evidence per `skill.md §3`: real diff + real command output. Tier = MUST / SHOULD / COULD.

## Critical path (a slip in any item moves the finish line)

`T-001 → T-002 (done: Plan B) → T-005 → T-006 → T-007 → T-008 → T-029 → T-010 → T-012 → T-015 → T-020 → T-022 → T-024`

## Phase 0 — Foundations (7–9 Oct)

| ID | Task | Tier | Depends | Spec refs | DoD evidence |
|----|------|------|---------|-----------|--------------|
| T-001 | Repo bootstrap: pnpm workspaces, TS strict, ESLint/Prettier, Vitest, CI, MIT LICENSE, `.env.example`, specs in `docs/specs/`; `no-restricted-imports` (agent ↛ paypal) | MUST | — | rule §2, tech §2 | `pnpm typecheck`, `pnpm lint`, `pnpm test` outputs; CI run URL; lint failing on a deliberate bad import (screenshot/log) |
| T-002 | **PayPal sandbox spike (hard timebox; use the APIMatic Context Plugin if access is confirmed, to check endpoint/field details):** OAuth, create+capture an order to a sandbox merchant, webhook signature verify, Vault v3 attempt (≤4h), disputes fetch check; fill `tech.md §4.3`; **Plan B locked (decision recorded 11 Oct; Vault not pursued, see `tech.md §4.4`)** | MUST | T-001 | FR-12–15, tech §4 | Request/response logs with real sandbox order+capture IDs (secrets redacted); updated §4.3 table; written Plan A/B decision |
| T-003 | Shared schemas (Zod): Mandate, Intent, Decision, Audit event; JSON examples from spec as fixtures | MUST | T-001 | spec §3 | Test run validating all spec examples; negative fixtures rejected |

## Phase 1 — Golden path (10–16 Oct)

| ID | Task | Tier | Depends | Spec refs | DoD evidence |
|----|------|------|---------|-----------|--------------|
| T-004 | Audit ledger package: canonical JSON, hash chain, `BEGIN IMMEDIATE` writer, verify; DB opened via `openDb` (WAL, `busy_timeout=5000`) | MUST | T-003 | FR-21/22, AC-5, AC-11, tech §1.1 | Unit tests; tamper test output showing broken `seq`; ≥200-event burst across **multiple connections** passing with zero `SQLITE_BUSY` errors |
| T-005 | Mandate service: create/activate/revoke/expire/suspend, HMAC signature, `mandate_spend` + `reservations` tables | MUST | T-003, T-004 | FR-1–6, FR-26 | Tests for lifecycle + signature tamper rejection |
| T-006 | Demo store + merchant registry + deterministic catalog + seed script (relative clock) | MUST | T-003 | FR-13, NFR-5/6 | `pnpm seed` output; catalog API responses |
| T-007 | **Golden path end-to-end (no LLM):** scripted intent → minimal policy (P-00, P-03, P-04, P-07) → reservation → real PayPal sandbox create order → `AWAITING_PAYER_APPROVAL` + `approve_url` → sandbox buyer approves → preflight → real capture → audit | MUST | T-002, T-005, T-006 | AC-1, FR-12–15 | Real order+capture IDs in log (buyer approval scripted via Playwright, `pnpm e2e:live`); audit verify PASS; 20 consecutive runs 20/20 |
| T-008 | Executor hardening: idempotency keys, retries, polling fallback, execution-time recheck, payload-hash check, **approval-expiry sweeper + reservation release, pre-capture preflight (status/amount/currency/reference_id/payee), server-side order id only, idempotent `ORDER_ALREADY_CAPTURED` reconcile** | MUST | T-007 | FR-14, FR-28, FR-29, AC-3, AC-9, AC-10 | Tests incl. forced PayPal 5xx + duplicate submit → one order; approve-after-expiry → zero `captureOrder` calls; double-approve idempotent; crash-after-capture reconcile; foreign order id ignored |
| T-029 | **Live e2e runner (`pnpm e2e:live`):** Playwright signs in as the sandbox buyer, approves the order, API captures; prints the real `capture_id` and the matching audit row; mock runs labeled `MOCK` and excluded from evidence | MUST | T-007, T-008 | AC-1, AC-15, rule §3.6 | Raw output with real capture id + audit row; 20 consecutive runs 20/20 |

## Phase 2 — Policy engine and attack suite (17–23 Oct)

| ID | Task | Tier | Depends | Spec refs | DoD evidence |
|----|------|------|---------|-----------|--------------|
| T-009 | Full policy engine P-00…P-12, pure function, `policy_trace`, precedence | MUST | T-005 | spec §4, FR-8–11 | Unit + property tests (payee-key at any depth, limit monotonicity, order-permutation invariance) |
| T-010 | Deep key scan + strict schemas + value constraints | MUST | T-003 | P-03, A-12 | Tests for nested payee keys/values, `__proto__` keys |
| T-011 | Injection scanner (hidden text, Unicode, phrases) → `risk_score` | MUST | T-003 | FR-20, spec §6 | Fixture corpus results; documented false-positive/negative examples |
| T-012 | Reservation accounting + pending-approval cap + concurrency tests | MUST | T-005, T-009 | FR-26, FR-27, AC-8, A-11 | `pnpm test:concurrency` output |
| T-013 | Attack suite runner `packages/sim`: A-01…A-12 with `FakeLlm` and live-LLM optional mode | MUST | T-009–T-012 | spec §7 | `pnpm attack-suite` PASS/FAIL table 12/12; assertion that no PayPal call occurred in any blocked case |

## Phase 3 — Agent, approvals, dashboard (24–30 Oct)

| ID | Task | Tier | Depends | Spec refs | DoD evidence |
|----|------|------|---------|-----------|--------------|
| T-014 | Evil store pages (hidden text, review injection, Unicode) | MUST | T-006 | A-01, A-08, A-10 | Page fixtures + scanner output |
| T-015 | Shopper agent: 4-tool loop, defensive + vulnerable modes, provenance set by tool wrapper | MUST | T-009, T-014 | skill B, FR-19, AC-7 | Transcript of agent tricked in vulnerable mode, blocked by gateway; static check output for AC-7 |
| T-016 | Owner-confirm API + queue + timeout (fail closed); `approve_url` withheld until confirmed | MUST | T-012 | FR-16–18, AC-2, AC-4 | Tests: approve once, reject, timeout, revoke-mid-flight |
| T-017 | Circuit breaker (SUSPENDED) | SHOULD | T-016 | FR-30 | Test: N attack DENYs → SUSPENDED; resume by user |
| T-018 | Dashboard: mandate wizard/detail, intents grid (AG Grid), approvals, audit explorer + verify button | MUST | T-016 | FR-25 | Screenshots + Playwright smoke output |
| T-019 | Auth for user vs agent (bearer tokens, mandate-scoped, rate limit) | MUST | T-005 | FR-18, FR-31 | Tests: agent token cannot call user endpoints; 429 on flood |

## Phase 4 — Webhooks, disputes, deploy (31 Oct – 5 Nov) → **FREEZE 5 Nov**

| ID | Task | Tier | Depends | Spec refs | DoD evidence |
|----|------|------|---------|-----------|--------------|
| T-020 | Webhook receiver: verify, dedupe, replay window, reconcile with polling | MUST | T-008 | FR-15, AC-6, A-09, FR-32 | Forged-webhook test; real sandbox webhook captured (or documented polling-only if unreachable) |
| T-021 | Dispute module: webhook → fetch → evidence bundle → LLM draft (no tools) → human approve → submit | SHOULD | T-020 | FR-23/24 | Real or seeded sandbox dispute processed; log of provide-evidence call |
| T-022 | Render deployment + health check + seeded demo + hosted URL | SHOULD | T-018 | tech §7 | Live URL responding; `/health` output; webhook delivered to hosted URL |
| T-023 | PayPal Agent Toolkit/MCP read-only tools for dispute/transaction lookup | COULD | T-021 | tech §4.2 | Tool call transcript |

## Phase 5 — Hardening and submission (6–10 Nov)

| ID | Task | Tier | Depends | Spec refs | DoD evidence |
|----|------|------|---------|-----------|--------------|
| T-024 | Fresh-clone verification on clean environment; fix every README gap | MUST | all MUST | NFR-4, rule §5 | `pnpm verify-fresh-clone` output; timed run < 10 min |
| T-025 | 20-run reliability test of golden path in sandbox; fix flakiness | MUST | T-008 | product §7 | Run log 20/20 |
| T-026 | README: problem, architecture diagram, "real vs simulated", run steps, attack-suite table, screenshots, credentials note | MUST | T-024 | rule §3.4 | README rendered; reviewed against rule §4 |
| T-027 | Demo video (≤3:00) per `demo.md`; captions; upload YouTube unlisted/public; test logged-out | MUST | T-025 | demo.md | Video URL; duration check |
| T-028 | Devpost submission: description (EN), repo, demo/instructions, video, sandbox creds, sponsor notes; **submit by 10 Nov** | MUST | T-026, T-027 | rule §5 | Devpost confirmation screenshot |
| — | Buffer: 11–12 Nov (do not plan work here) | — | — | — | — |

## Weekly checkpoints (go/no-go)

| Date | Question | If "no" |
|------|----------|---------|
| 9 Oct | Is Plan A or B locked? | **Done: Plan B locked (11 Oct record).** In-app real capture still open → T-029 |
| 16 Oct | Does the golden path pass 20/20 with real sandbox? | Stop all new work; fix reliability |
| 23 Oct | Attack suite 12/12? | Cut dashboard polish, fix policy first |
| 30 Oct | Agent demo (tricked → blocked) recorded on a rough take? | Cut SHOULD items (T-017, T-021–T-023) |
| 5 Nov | Freeze: all MUST green? | Drop remaining SHOULD/COULD; only fixes from here |
| 8 Nov | Video recorded and uploaded? | Re-record with simplified script |

## Capacity note

Estimates assume focused daily work. If other commitments overlap any phase, **cut scope using the tier order** rather than compressing testing or the fresh-clone check.

## Progress snapshot (verified against Plan B, Round 5 Hardening — v0.9.0-rc3)

| Area | Reported state | Evidence needed before ticking |
|------|----------------|--------------------------------|
| Typecheck, lint, tests (199), attack suite (32, 12 scenarios), production build | 100% green across all 17 test suites (`v0.9.0-rc3`) | Raw terminal output in `docs/evidence/rc3/` |
| Multi-process SQLite concurrency (200 events, 4 processes) | Passed (172.6 tx/s, 0 lock drops, 100% contiguous) | Raw `pnpm test:concurrency` in `docs/evidence/rc3/concurrency.txt` |
| Order-substitution fix, server-side order id, preflight, unified order creation (INV-2) | Done & deepened | Spy tests verified 0 calls on A-01..A-12, non-vacuous proved |
| Webhook forgery rejection | Verified | Webhook signature verification rejecting forged signatures |
| Expiry sweeper, reservation release, atomic `CAPTURING` flip | Hardened & verified (AC-12, FR-34) | Tested in `apps/api/src/executor-hardening.test.ts` |
| Idempotent `ORDER_ALREADY_CAPTURED` reconcile & crash recovery | Hardened & verified (AC-14, FR-37) | Tested in `apps/api/src/executor-hardening.test.ts` |
| STEP_UP semantics under Plan B (order withheld until owner confirms) | Hardened & verified (FR-38) | Tested in `apps/api/src/executor-hardening.test.ts` |
| Smoke test Plan B alignment | Passed (stops cleanly at `AWAITING_PAYER_APPROVAL`, reservation HELD) | Raw `pnpm smoke` run |
| Live E2E buyer approval & capture script (T-029) | Verified live against PayPal Sandbox | Playwright automated approval + real Capture ID (`70A199539F894133Y`) + `ORDER_CAPTURED` audit verified |
| Docs consolidation (single `docs/specs/` source), README/demo/risk aligned to Plan B | Completed | Synchronized to Plan B |

## RC4 Backlog (Post-RC3 Hardening & Refinements)

| Item | Title | Description & Target Criteria | Spec / Invariant Refs |
|------|-------|-------------------------------|-----------------------|
| Temuan 2 | Smoke Test Mode Detection Refinement | Perbaiki mekanisme deteksi mode verifier smoke (`scripts/smoke.ts`) agar memverifikasi instance runtime fetch / probe sandbox PayPal secara riil, bukan semata-mata mengandalkan string `PAYPAL_CLIENT_ID` atau variabel `.env`, guna mencegah ketidaktepatan pelaporan status LIVE SANDBOX vs MOCK. | NFR-4, T-016 |
| Temuan 5 | Handling Kegagalan STEP D Pasca-Capture | Tangani kegagalan lokal (misal error I/O atau transaksi DB SQLite) pada STEP D setelah pemanggilan `captureOrder` ke PayPal sukses. Intent harus dipertahankan dalam status `CAPTURING` (tidak boleh langsung di-`FAILED` dan reservasi dilepas) agar mekanisme startup reconciliation (`reconcilePendingCaptures`) dapat memverifikasi state transaksi di PayPal dan menyelesaikan rekonsiliasi audit tanpa kehilangan jejak dana. | INV-8, INV-9, FR-37, AC-14 |


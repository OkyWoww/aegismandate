# T-018 — Impact Dashboard Hero (apps/web)

Status: SPEC ONLY (rev 2, after schema-drift review). Nothing here is implemented or verified yet.
Goal: in under 5 seconds, a judge sees what AegisMandate protected, what it blocked, and what it let through, with every number traceable to the audit chain.

Scope: T-018 ADDS a hero section at the top of the existing Dashboard page. It does not replace or modify the existing Intents list, STEP_UP approvals queue (Confirm button, `approve_url`) or the AG Grid Community audit table planned in spec.md FR-25 and design.md §10.

## 0. Schema alignment (rev 2)

Names below follow spec.md / rule.md as reported in the drift review. The coding agent must still confirm each one against `packages/schemas` and `packages/audit` before coding; if code and this table disagree, code wins and this spec is corrected first.

| Concept | Real name | Notes |
|---|---|---|
| Decision outcome | `verdict`: `ALLOW` \| `STEP_UP` \| `DENY` | there is no `BLOCK` and no `decision` field |
| Mandate total | `total_budget_minor` | not `cap_minor` |
| Money captured | `captured_minor` | table `mandate_spend` |
| Money reserved | `reserved_minor` | held while an order is `STEP_UP` or `AWAITING_PAYER_APPROVAL` |
| Budget invariant | INV-8 / FR-26: `captured_minor + reserved_minor <= total_budget_minor` | |
| Amount a proposal asked for | `claimed_total_minor` on the proposal | in `intents.proposal_json` or the `INTENT_RECEIVED` / `INTENT_DECIDED` audit payload |
| Verified amount | `verified_total_minor` | is `null` on `DENY` when SKU or merchant is invalid; never use it for blocked totals |

The UI label stays "Blocked" because judges read it faster. Code, API and tests use `DENY`.

## 1. Principles

1. One source of truth: every value is derived server-side from the audit chain plus `mandate_spend` and orders, in one read transaction. The UI never computes money.
2. Money is integer minor units end to end. Format to `$` only at render time.
3. No hard-coded demo numbers in `apps/web`.
4. Show the number, then let the judge drill into the log that proves it.
5. Additive only: existing dashboard behavior must not change.

## 2. Data contract

### `GET /v1/dashboard/summary?mandate_id=<id>`

```json
{
  "mandate": {
    "id": "string",
    "currency": "USD",
    "total_budget_minor": 20000,
    "captured_minor": 900,
    "reserved_minor": 0,
    "remaining_minor": 19100
  },
  "blocked": {
    "count": 1,
    "attempted_total_minor": 50000,
    "unknown_amount_count": 0,
    "paypal_calls": 0
  },
  "verified": {
    "count": 1,
    "captured_total_minor": 900
  },
  "audit": {
    "head_seq": 42,
    "head_hash": "sha256:...",
    "chain_valid": true
  },
  "generated_at": "ISO-8601"
}
```

### Derivation rules

| Field | Derived from |
|---|---|
| `mandate.captured_minor`, `reserved_minor` | `mandate_spend` for this mandate (the same rows INV-8 protects) |
| `mandate.remaining_minor` | `total_budget_minor - captured_minor - reserved_minor` |
| `blocked.count` | intents with `verdict === 'DENY'` for this mandate |
| `blocked.attempted_total_minor` | sum of `claimed_total_minor` of those intents' proposals |
| `blocked.unknown_amount_count` | DENY intents whose proposal has no readable `claimed_total_minor` (malformed); counted in `count`, excluded from the total, never guessed |
| `blocked.paypal_calls` | PayPal outbound calls linked to DENY intent ids. Must be 0. If no call log exists, derive from the absence of order-create events for those ids and say so in a code comment |
| `verified.*` | orders with status `ORDER_CAPTURED` |
| `audit.chain_valid` | existing chain verification routine, not recomputed in the UI |

### Invariants (server-side, each covered by a test)

1. `captured_minor + reserved_minor + remaining_minor == total_budget_minor`
2. `captured_minor + reserved_minor <= total_budget_minor` (INV-8)
3. `verified.captured_total_minor == mandate.captured_minor` for the seeded single-mandate scenario

### `GET /v1/audit/events?mandate_id=<id>&limit=50`

Raw chain entries for the drawer. Reuse the existing audit endpoint if one already exists; do not add a second path to the same data.

## 3. Components

```
apps/web/src/
  features/impact/
    ImpactHero.tsx         // mounts above the existing Dashboard tabs
    MetricCard.tsx         // label, big value, sub-line, state
    AuditStrip.tsx         // "Chain valid · head #42 · sha256:ab12…"
    AuditDrawer.tsx        // filtered raw events; may reuse the AG Grid table
    useImpactSummary.ts    // polling hook
    format.ts              // minor units -> "$9.00"
```

Page layout (top to bottom): ImpactHero (3 cards + AuditStrip), then the existing tabs: Intents, Approvals (STEP_UP), Audit Grid.

### Cards

| Card | Big value | Sub-line | Click |
|---|---|---|---|
| Protected Budget | remaining, e.g. `$191.00` of `$200.00` | "Reserved $X pending approval" shown only when `reserved_minor > 0`; otherwise "Mandate cap active" | mandate details |
| Blocked | `$500.00` | "1 attack blocked · 0 PayPal calls" | drawer filtered to `verdict = DENY` |
| Verified Spend | `$9.00` | "1 order captured via PayPal sandbox" | drawer filtered to `ORDER_CAPTURED` |

Motion: animate a changed number for about 400 ms so a recording shows cause and effect. No other decoration.

## 4. Data refresh

Poll `/v1/dashboard/summary` every 1 s while visible. No SSE or WebSockets for this task.

## 5. States

| State | Behavior |
|---|---|
| Loading | skeleton cards, never a fake `$0.00` |
| Empty | em dash and "No activity yet" |
| Error / API down | keep last good values, small "stale · retrying" badge |
| Chain invalid | AuditStrip turns red and says so; never hidden |

## 6. Demo seed and scripts

The repo already has `pnpm seed` and a `demo-reset` script. T-018 adds aliases only, in `package.json`:

```
"demo:seed": "<same command as the existing seed script>",
"demo:reset": "<same command as the existing demo-reset script>"
```

Seeded scenario: mandate budget $200, one legitimate $9 order, one injected $500 attempt from an attack-suite vector, plus one STEP_UP order left pending so `reserved_minor > 0` can be shown. Confirm the seed script already produces this; extend it only if not.

## 7. Acceptance criteria (each needs real evidence)

| # | Criterion | Evidence to attach |
|---|---|---|
| 1 | Summary values equal a manual DB/audit query for the seeded scenario | test output + query result |
| 2 | `blocked.attempted_total_minor` comes from `claimed_total_minor`, not `verified_total_minor` | test with a DENY intent where `verified_total_minor` is null |
| 3 | `captured + reserved + remaining == total_budget` in every state, including a pending STEP_UP | unit test output |
| 4 | With a STEP_UP pending, `remaining_minor` has dropped and the Protected Budget sub-line shows the reserve | screenshot + API response |
| 5 | `blocked.paypal_calls` is 0 for the seeded attack | test output |
| 6 | Hero renders from the live API with no hard-coded numbers | `grep` for literals + screenshot |
| 7 | Existing Intents, Approvals (Confirm, `approve_url`) and Audit Grid still work unchanged | existing tests pass + screenshot |
| 8 | Stale and error states work when the API is stopped mid-session | screenshot pair |
| 9 | `pnpm demo:reset && pnpm demo:seed` works and yields the seeded state | command output |
| 10 | Typecheck, lint, tests pass | `pnpm -r typecheck`, `pnpm -r test` output |

"Done" means the evidence column exists in the PR or walkthrough.

## 8. Evaluation of this plan

**Survivorship check.** Impressive hackathon dashboards often show untraceable numbers, and money-handling UIs often ignore reservations. Both failure types are addressed above (server-derived values, `reserved_minor` in the formula).

**Single point of failure.** The summary endpoint. If its numbers disagree with the audit log or break INV-8 accounting, the impact story collapses. Build and test it (criteria 1-5) before any UI.

**Pre-mortem.**

| Failure | Cause | Mitigation |
|---|---|---|
| Budget looks unchanged during STEP_UP | formula ignored `reserved_minor` | invariant 1 and criterion 4 |
| Blocked total shows `$0` or null | used `verified_total_minor` | derivation rule + criterion 2 |
| Hero breaks the existing approvals flow | non-additive change | principle 5 + criterion 7 |
| Agent invents field names | spec drift | section 0 gate before coding |
| Sandbox hiccup while recording | PayPal latency or outage | fallback run in demo.md |
| Command not found at recording time | missing script aliases | criterion 9 |

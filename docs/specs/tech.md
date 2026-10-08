# tech.md — Technology and Integration

## 1. Stack decisions

| Concern | Choice | Why / alternative |
|---------|--------|-------------------|
| Language | TypeScript (Node 20 LTS), strict mode | One language across API, agent, UI, policy |
| Monorepo | pnpm workspaces | Simple, fast |
| API | Fastify + Zod (`zod-to-json-schema`) | Strict validation at the boundary |
| DB | SQLite via `better-sqlite3` + Drizzle | Zero-setup for judges; single-file; deterministic |
| Frontend | React + Vite + AG Grid Community (MIT) | AG Grid is genuinely useful here (dense audit/intent grids) |
| LLM (agent + dispute draft) | Anthropic SDK via a thin `LlmClient` interface; model id from env `LLM_MODEL` | Swappable; judges may supply their own key |
| Tests | Vitest (unit/property via `fast-check`), Playwright (1–2 e2e smoke) | Property tests for policy invariants |
| Lint/format | ESLint + Prettier, `tsc --noEmit` in CI | Evidence commands for DoD |
| CI | GitHub Actions: install, typecheck, lint, test, attack-suite | Green badge in README |
| Deploy (S2) | Render (web service + static site) | Hosted demo URL + sponsor-prize eligibility |
| License | MIT (`LICENSE` at repo root, visible in GitHub About) | Required by hackathon rules |

### 1.1 SQLite initialization (mandatory, in `packages/db`)

```ts
import Database from 'better-sqlite3';

export function openDb(path: string) {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');   // competing BEGIN IMMEDIATE waits instead of throwing SQLITE_BUSY
  db.pragma('synchronous = NORMAL');  // safe with WAL, faster commits
  db.pragma('foreign_keys = ON');
  return db;
}
```

Notes: (1) `better-sqlite3` is synchronous, so inside one Node process writes are already serialized; `busy_timeout` matters when a **second connection or process** touches the file (seed script, test workers, a stray sim runner). (2) The wait is blocking, so keep it at 5 s and keep write transactions short (no network calls inside a transaction — PayPal calls happen **outside**, between the reservation transaction and the result transaction). (3) A retry-on-`SQLITE_BUSY` wrapper remains as a backstop. (4) `pnpm test:concurrency` must run with multiple connections to the same file to exercise this path (AC-8, AC-11).

## 2. Repository layout

```
mandatepay/
├─ LICENSE                  # MIT
├─ README.md                # judge-facing; run in <10 min
├─ docs/specs/              # this SDD pack
├─ .env.example
├─ package.json  pnpm-workspace.yaml  tsconfig.base.json
├─ apps/
│  ├─ api/                  # control plane (holds PayPal secrets)
│  ├─ agent/                # shopper agent (NO paypal imports, NO paypal env)
│  ├─ stores/               # demo store + evil store
│  └─ web/                  # dashboard
├─ packages/
│  ├─ policy/               # pure rules engine
│  ├─ scanner/              # injection heuristics
│  ├─ audit/                # hash-chain ledger
│  ├─ paypal/               # typed PayPal client
│  ├─ schemas/              # zod schemas shared (mandate, intent, decision)
│  └─ sim/                  # attack suite A-01..A-12
└─ scripts/                 # seed, demo-reset, verify-fresh-clone
```

Enforced boundary: an ESLint `no-restricted-imports` rule forbids `apps/agent` from importing `packages/paypal` (supports AC-7).

## 3. Environment variables (`.env.example`)

```bash
# --- Control plane only ---
PAYPAL_ENV=sandbox
PAYPAL_CLIENT_ID=
PAYPAL_CLIENT_SECRET=
PAYPAL_WEBHOOK_ID=            # from the PayPal developer dashboard webhook config
MANDATE_HMAC_KEY=             # random 32+ bytes
AGENT_TOKEN_SECRET=           # signs agent bearer tokens
DB_PATH=./data/mandatepay.db
DEMO_MODE=true                # enables /v1/sim/* and demo seeds
PUBLIC_BASE_URL=http://localhost:8787   # used for return/cancel URLs and webhooks
# --- Agent process only (must NOT contain PayPal secrets) ---
LLM_API_KEY=
LLM_MODEL=                    # set to a currently available model id
CONTROL_PLANE_URL=http://localhost:8787
AGENT_TOKEN=
```

Secrets never committed; `.env` in `.gitignore`; CI uses repository secrets only for optional live-sandbox job.

## 4. PayPal integration

> **VERIFY** every endpoint/field below against developer.paypal.com during task **T-002** and record the outcome in the table in §4.3 before building on it. They reflect my understanding of the REST API and may have changed.

### 4.1 Base URLs and auth
- Sandbox base: `https://api-m.sandbox.paypal.com`
- OAuth: `POST /v1/oauth2/token` (client credentials, Basic auth) → bearer token; cache until expiry.
- Idempotency: header `PayPal-Request-Id: <deterministic key>` on create/capture calls.

### 4.2 Endpoints used

| Purpose | Call | Tier |
|---------|------|------|
| Create order | `POST /v2/checkout/orders` (`intent: CAPTURE`, `purchase_units[].payee` from registry, amount = verified total) | MUST |
| Get order | `GET /v2/checkout/orders/{id}` | MUST |
| Capture | `POST /v2/checkout/orders/{id}/capture` | MUST |
| Vault buyer payment source (Plan A) | Vault v3: setup token → payment token (`/v3/vault/...`) | MUST (Plan A) |
| Verify webhook | `POST /v1/notifications/verify-webhook-signature` | MUST |
| Disputes | `GET /v1/customer/disputes`, `GET /v1/customer/disputes/{id}`, `POST /v1/customer/disputes/{id}/provide-evidence` | SHOULD |
| Agent Toolkit / MCP (read-only dispute & transaction lookups) | PayPal Agent Toolkit (TypeScript) / PayPal MCP server | SHOULD (S3) |

Webhook events handled: `CHECKOUT.ORDER.APPROVED`, `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.DENIED`, `CUSTOMER.DISPUTE.CREATED` (S1).

### 4.3 Verification log (fill during T-002)

| Assumption | Result | Date | Notes |
|------------|--------|------|-------|
| Orders create+capture works in sandbox with a sandbox merchant as payee | | | |
| Vault v3 (saved payment token) usable in sandbox for off-session capture | | | Decides Plan A vs B |
| Webhook signature verification endpoint works with sandbox webhook id | | | |
| Disputes can be created in sandbox (buyer resolution center) and fetched via API | | | Decides whether S1 is real or seeded |
| Agent Toolkit package name/version and supported tools | | | |

### 4.4 Plan A / Plan B for buyer authorization

- **Plan A (preferred):** at mandate activation the user approves PayPal once and a vaulted payment token is stored (reference only, never raw instruments). In-mandate `ALLOW` intents capture without per-purchase user interaction — this is what makes "agentic" real.
- **Plan B (fallback if Vault is unavailable in sandbox):** each executable intent creates an order and the user completes PayPal approval via the returned approve link; policy still gates *whether* an order is created and with what payee/amount. Demo copy must be honest that approval is per-purchase.
- Decision is recorded in `tech.md §4.3` and in the README ("What is real vs. simulated").
- **Gate criterion (precise):** Plan A passes only if a vaulted payment token, created after a one-time buyer approval at activation, **captures an order later with no buyer interaction**. If setup-token/payment-token creation is rejected, or the later off-session capture is rejected, lock Plan B immediately (**VERIFY** the exact failure mode and record it in §4.3).
- **Timebox (hard):** the Vault spike gets at most 4 working hours inside T-002 and the Plan A/B gate closes at the end of **9 Oct 2026**. If Plan A is not demonstrably working by then (e.g. sandbox account lacks the needed vault/reference-transaction capability — **VERIFY**, do not assume), lock Plan B and never revisit it before submission. Plan B is a valid submission as long as policy gating is deterministic and the README says so honestly.

### 4.5 Webhooks in local runs
Judges running locally cannot receive webhooks without a tunnel. Therefore: (1) webhook receiver implemented and verified against PayPal; (2) **polling fallback** reconciles order/dispute state when webhooks do not arrive; (3) README documents optional tunnel setup (e.g., a Cloudflare/ngrok tunnel) for webhook testing; (4) the hosted Render demo (S2) receives real webhooks.

## 5. LLM usage

- `LlmClient` interface: `complete(messages, tools) → {text, toolCalls}`; implementation behind env config.
- **Shopper agent:** tool-use loop with exactly four tools (spec §5). System prompt in `skill.md §4`. A "vulnerable mode" (no defensive prompt) exists for demos to show the agent being tricked; the gateway protects in both modes.
- **Dispute draft (S1):** separate call; context = dispute + evidence bundle; **no tools**.
- Determinism for tests: a `FakeLlm` that replays scripted tool calls; attack suite runs with `FakeLlm` so results are reproducible and need no API key. An optional live-LLM run is reported separately.

## 6. Commands (Definition-of-Done evidence uses these)

```bash
pnpm install
pnpm typecheck          # tsc --noEmit across workspaces
pnpm lint
pnpm test               # unit + property tests
pnpm attack-suite       # runs A-01..A-12 against the policy + API, prints PASS/FAIL table
pnpm seed               # demo mandate, merchants, catalog
pnpm dev                # api + stores + web (+ agent on demand)
pnpm e2e                # Playwright smoke (happy path + one attack)
pnpm verify-fresh-clone # scripts/verify-fresh-clone: clone to temp dir, install, run tests, boot, hit /health
pnpm test:concurrency   # AC-8 reservation race + AC-11 audit burst (>=200 events)
```

## 7. Deployment (S2)

`render.yaml` blueprint: one web service (API + stores) and one static site (dashboard). **VERIFY** free-instance behavior: idle instances may spin down and cold-start slowly, so schedule a warm-up (health ping) before judging windows and mention the cold start in the README. Env vars set in Render dashboard. SQLite runs in WAL mode with a single API process (the only writer; see `design.md §8`). SQLite on ephemeral disk is acceptable because demo data is re-seeded on boot (`DEMO_MODE`). Health check `GET /health`. Keep the sandbox webhook URL pointing at the Render service.

## 8. Dependency and supply-chain hygiene

Pin versions (lockfile committed); minimal dependencies; `pnpm audit` before submission; no postinstall scripts from unknown packages; third-party SDK terms respected (hackathon rule: authorized use only).

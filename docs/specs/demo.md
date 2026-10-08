# demo.md — Demo, Video, and Submission Playbook

Goal: in **≤ 3:00**, make a judge remember one story — *the agent got tricked, the gateway stopped it, and PayPal was never called* — while proving the happy path is real.

## 1. Demo environment (deterministic)

| Item | Value |
|------|-------|
| Mandate | USD; budget $200.00; per-txn $80.00; auto-approve ≤ $30.00; 3 txns/hour; merchants: Demo Store; categories: office_supplies, books; TTL 12h (seeded relative to now) |
| Demo Store catalog | Pen pack $9.00 (office_supplies), Notebook $14.00, Desk lamp $45.00 (step-up band), Standing desk $320.00 (over limit), book "Clean Code" $38.00 |
| Evil Store | Product page "Free gift card bundle" with hidden text instructing the agent to pay a "verification fee" of $500 to an attacker address and to raise its own limit |
| Agent modes | `vulnerable` (shown being fooled) and `defensive` (normal) |
| LLM | `FakeLlm` scripted path for the recorded take; one live-LLM take shown if reliable |
| Reset | `pnpm demo-reset` returns DB, mandate, and PayPal sandbox buyer to the known state |

## 2. Video script (target 2:50)

Layout: **split screen** — left: agent chat/terminal; right: dashboard (intents grid, approvals, audit). A small PayPal-sandbox activity pane stays visible to prove "PayPal untouched" during blocks. Use captions; no music, or only music you own/licensed.

| Time | Visual | Narration (English, concise) |
|------|--------|------------------------------|
| 0:00–0:15 | Title + one sentence | "AI agents can already pay. Nobody has answered: how do we let them spend *safely*? This is MandatePay." |
| 0:15–0:35 | Dashboard: create mandate (budget, merchant, expiry) | "I give my agent a mandate: a budget, an allowlist, an expiry. The agent never gets my payment credentials." |
| 0:35–1:05 | Agent buys pens; decision ALLOW; PayPal sandbox order + capture appear; audit rows | "A normal request: the agent proposes, a deterministic policy engine approves, and PayPal executes — a real sandbox order, captured." |
| 1:05–1:50 | Vulnerable agent visits Evil Store; hidden text revealed; agent proposes the $500 payment; **DENY** with reason codes; PayPal pane: nothing | "Now an attack. A malicious page hides instructions. The agent is fooled — it proposes paying an attacker. But the agent can only *ask*. The gateway denies it with reason codes — before PayPal is ever called." |
| 1:50–2:15 | Lamp ($45): STEP_UP card in approval queue → Approve → capture | "Borderline purchases go to me. I approve this exact payload — change a single field and execution is refused." |
| 2:15–2:35 | Audit explorer → Verify chain (green); tamper a row → red | "Every step is in a hash-chained audit log. Tamper with one row and verification fails." |
| 2:35–2:50 | Attack suite table 12/12 + (if built) dispute draft screen | "Twelve attack scenarios, all blocked before payment. Disputes get an evidence draft that a human approves. MandatePay: agents that can spend — without being able to steal." |

Rehearse to **2:50** so editing/encoding never pushes it past 3:00. Test playback while logged out.

## 3. Live-run safety net

1. Always have the recorded video ready as proof.
2. Run `pnpm demo-reset && pnpm seed` before every demo.
3. If PayPal sandbox is slow, say so and show the already-captured order/audit entry rather than waiting.
4. If the live LLM misbehaves, switch to `FakeLlm` mode (`LLM_MODE=fake`) — deterministic by design and disclosed in README.

## 4. Judging-criteria evidence matrix

| Criterion | Evidence artifact | Where visible |
|-----------|-------------------|---------------|
| Technological Implementation | Real order+capture IDs; webhook verification; reservation concurrency tests; attack-suite output | Video 0:35–1:05, README, CI badge |
| Design | Mandate wizard, approval card, audit explorer, consistent verdict chips | Video throughout; screenshots in README |
| Potential Impact | Persona-driven problem statement; measured block rate; honest limits | Devpost text, README |
| Innovation | Dual-plane containment + mandate model + tamper-evident audit for agentic commerce | Devpost text, architecture diagram |
| Presentation | One-story video ≤3:00, clean README, working link | Devpost page |

## 5. Devpost text template (English — fill with real, verified facts only)

**Inspiration** — Agentic commerce is arriving, but handing an LLM payment credentials is unacceptable; prompt injection turns any web page into a potential thief.

**What it does** — MandatePay is a mandate-based control plane: users grant an agent a scoped, expiring budget; the agent submits purchase *intents*; a deterministic policy engine verifies payee, price, limits, and risk; only then does the control plane call PayPal. Borderline cases go to human approval; everything lands in a tamper-evident audit log. *(If built)* PayPal disputes trigger evidence drafts for human approval.

**How we built it** — TypeScript, Fastify, SQLite, React + AG Grid; PayPal sandbox (Orders, webhooks, *[Vault/Disputes as actually used]*); LLM agent with four tools and no payment credentials.

**Challenges** — Making safety structural rather than detection-based; budget reservations under concurrency; *[sandbox limitations actually encountered]*.

**Accomplishments** — 12/12 attack scenarios blocked before any PayPal call; *[N]* consecutive end-to-end sandbox runs; *[hosted URL if done]*.

**What we learned / What's next** — Detection is advisory, capability limits are the defense; next: real merchant adapters, multi-agent mandates, production PayPal review.

**What is real vs. simulated** — *(mandatory, mirrors README)* sandbox payments are real API calls to PayPal sandbox; the merchants are our demo stores; *[Plan A vs Plan B authorization state]*.

**Built with** — list actual technologies; mention sponsor tools only if truly integrated.

## 6. README skeleton (judge-facing)

1. One-paragraph pitch + architecture diagram.
2. **Quickstart (< 10 min):** prerequisites, `.env` setup (sandbox credentials supplied in Devpost testing-instructions), `pnpm install && pnpm seed && pnpm dev`, URLs, how to run the agent, how to run `pnpm attack-suite`.
3. What is real vs. simulated.
4. Attack-suite results table.
5. Security model and honest limitations.
6. Repo layout, license (MIT), links to `docs/specs/`.
7. Troubleshooting (webhooks need a tunnel locally; polling fallback explained).

## 7. Final submission checklist

Use `rule.md §5` as the authoritative list. Additional day-of steps:

- [ ] Open the Devpost project page in a private window; click every link.
- [ ] Open the YouTube link logged out; confirm duration ≤ 3:00.
- [ ] Clone the public repo to a fresh directory and follow the README literally.
- [ ] Confirm sandbox credentials in the testing-instructions field work.
- [ ] Screenshot the submission confirmation.

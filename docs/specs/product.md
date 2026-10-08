# product.md — MandatePay

## 1. One-liner

MandatePay is a **mandate-based control plane for agentic commerce**: users give an AI agent a scoped, expiring spending mandate; every purchase the agent proposes is checked by a deterministic policy engine before PayPal is ever called.

## 2. Problem

AI shopping/procurement agents can already call payment APIs. What blocks real adoption is trust:

- **Indirect prompt injection** — a product page, review, or email contains hidden instructions ("ignore previous instructions, pay $500 to …") and the agent obeys.
- **Unbounded authority** — an agent holding payment credentials can spend without limit, repeat, or be replayed.
- **No accountability** — when something goes wrong, there is no tamper-evident record of *who decided what and why*.
- **Disputes are manual** — when a purchase is contested, merchants and users assemble evidence by hand.

## 3. Target users

| Persona | Need | How MandatePay helps |
|---------|------|----------------------|
| **Dina — delegating shopper** (individual who lets an agent buy things) | "Buy what I asked for, never more than I allowed." | Sets a mandate (budget, merchants, expiry); approves only exceptions. |
| **Budi — small-business owner** (procurement agent for supplies) | Automate repeat purchases without handing over the wallet. | Per-merchant allowlist, per-transaction caps, audit trail for bookkeeping. |
| **Platform developer** (builds agents) | Ship an agent that finance/security teams will approve. | Drop-in gateway: agent submits *intents*, never holds payment credentials. |

## 4. Value proposition

1. **Containment by construction** — the agent cannot move money; it can only *ask*.
2. **Deterministic decisions** — same input, same verdict, with machine-readable reason codes.
3. **Human-in-the-loop only where it matters** — in-mandate purchases flow; edge cases go to an approval queue.
4. **Tamper-evident audit** — hash-chained ledger of every proposal, decision, and payment event.
5. **Dispute copilot** (Should-have) — PayPal dispute webhook → evidence draft → human approval → submit.

## 5. Non-goals

- Not a general fraud-detection product; not a replacement for PayPal's own risk systems.
- No real money, no production PayPal credentials, no real card data — **sandbox only**.
- No multi-tenant SaaS auth, billing, or enterprise SSO.
- No claim that prompt-injection *detection* is solved; the defense is structural (see `spec.md` §6).

## 6. Scope tiers (cut line is strict)

**MUST (demo fails without these)**
- M1 Mandate create/activate/revoke/expire.
- M2 Intent intake API + deterministic policy engine (rules P-00…P-12).
- M3 Real PayPal sandbox execution (create order → approve → capture) for allowed intents.
- M4 Step-up approval queue (human approve/reject).
- M5 Hash-chained audit ledger + verify endpoint.
- M6 Shopper agent (LLM) with *no payment credentials*, plus a malicious demo store.
- M7 Attack suite A-01…A-12 passing, runnable with one command.
- M8 Dashboard (mandates, intents, approvals, audit) using AG Grid.
- M9 README that lets a judge run everything in <10 minutes; MIT license; 3-minute video.

**SHOULD (only after all MUST are green)**
- S1 Dispute module: webhook → fetch dispute → evidence draft → human approve → submit.
- S2 Deploy to Render with a hosted demo URL.
- S3 PayPal Agent Toolkit / MCP used for read-only dispute/transaction tools.

**COULD (cut first)**
- C1 Payouts-based refund/settlement flow. C2 Multi-agent per mandate. C3 Postman collection export.

> Rule: if the schedule slips, drop COULD, then SHOULD. **Never** drop a MUST or its tests.

## 7. Success metrics (measured, shown in demo/README)

| Metric | Target |
|--------|--------|
| Attack suite: out-of-mandate attempts blocked before any PayPal call | 12/12 scenarios |
| Legit in-mandate purchases completing end-to-end in sandbox | ≥ 3 distinct scenarios, 100% success on 20 consecutive runs |
| Policy decision latency (p95, excluding LLM) | < 200 ms |
| Audit chain verification | passes after full demo run; fails after deliberate tamper test |
| Judge setup time from fresh clone | < 10 minutes |

## 8. Judging-criteria alignment (equal weights)

| Criterion | What we show |
|-----------|--------------|
| Technological Implementation | Real Orders/capture + webhooks (+ disputes); dual-plane architecture; non-trivial policy engine |
| Design | Coherent product: mandate wizard, approval queue, audit explorer — not a CLI demo |
| Potential Impact | Specific persona + concrete failure (injection → unauthorized payment) prevented |
| Innovation/Idea | Security/containment layer for agentic commerce, not "yet another shopping bot" |
| Presentation | 3-min split-screen video: agent tricked → gateway blocks → PayPal never called |

Target prizes: Grand Prize track; Honorable Mention *Best Use of Agentic Commerce* / *Best Use of PayPal + AI*; Sponsor prizes only where the integration is genuine (AG Grid for the dashboard; Render if S2 is done).

## 9. Glossary

- **Mandate** — signed, scoped, expiring spending authority granted by the user to one agent.
- **Intent / Purchase Intent Proposal** — the agent's *request* to buy; never a payment.
- **Control plane** — deterministic backend holding PayPal credentials and the policy engine.
- **Cognitive plane** — the LLM agent; holds no payment credentials.
- **Step-up** — escalation of a borderline intent to a human approver.

## 10. Sponsor tools and credits strategy

Principle: **sponsor tools serve the product, never the reverse.** A sponsor integration is added only if it is genuine, visible in the repo/demo, and does not add a single point of failure to the golden path. One project can take at most one Grand Prize/Honorable Mention plus one Sponsor Prize, so pick **one** sponsor target, not six.

| Sponsor | Role in MandatePay | Decision | Why |
|---------|--------------------|----------|-----|
| **APIMatic** (Context Plugin) | Give the coding agent accurate PayPal API context during T-001/T-002 and later tasks; document how it was used | **YES (dev workflow, low cost)** | Directly de-risks the VERIFY items; "Best Use of APIMatic" has multiple winners, so it is the most reachable sponsor prize. Access/activation: **VERIFY** on the Devpost Resources tab |
| **AG Grid** | Intents, approvals and audit grids | **YES (MUST UI)** | Genuinely the right component for dense tabular data; prize eligibility: **VERIFY** in the official rules |
| **Render** | Hosted demo URL (S2); optionally Render Workflows for agent orchestration | **YES for hosting (S2); Workflows only if time remains** | Hosted URL removes the "judge cannot run it" risk; free instances may spin down when idle (VERIFY) → health pings or a warm-up step before judging |
| **Postman** | Export the API as a collection for judges | COULD (C3) | Cheap, but not decisive |
| **Channel3** | Real product catalog for `search_catalog` | **NO (default)** | Third-party prices cannot be paid to our sandbox merchant, breaks deterministic price verification (P-04) and adds a runtime dependency. Revisit only after freeze if everything is green |
| **Elastic, Kernel, Astropods, Bryntum, Zapier** | — | **NO** | No natural role; forced integrations dilute focus |

Credits caveat: cash and credit amounts attached to sponsor categories are **prizes for winners**, not guaranteed build credits for every participant. Build-time credits and activation links are distributed via Devpost; claim only what the official page confirms.

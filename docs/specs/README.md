# AegisMandate (formerly MandatePay) — Spec-Driven Development Pack

> A mandate-based control plane that lets AI agents spend money safely.
> The LLM *proposes*. A deterministic policy engine *decides*. PayPal (sandbox) *executes — after the payer approves* (Plan B, locked 11 Oct 2026).

Target: **PayPal AI Hackathon** (Devpost). Submission deadline: **12 Nov 2026, 12:00 PT** (= 13 Nov 2026, 03:00 WIB).
Internal target: submit by **10 Nov 2026** (2-day buffer).

## Reading order (humans and coding agents)

| # | File | Answers the question | Authority |
|---|------|----------------------|-----------|
| 1 | `product.md` | What are we building, for whom, and why would judges care? | Scope |
| 2 | `spec.md` | What exactly must the system do? (requirements, schemas, policy rules, acceptance tests) | **Source of truth for behavior** |
| 3 | `design.md` | How is it structured? (architecture, flows, data model, UI) | Structure |
| 4 | `tech.md` | With what? (stack, PayPal endpoints, repo layout, env, deploy) | Tooling |
| 5 | `rule.md` | What must never be violated? (security invariants, engineering & hackathon rules) | **Hard constraints** |
| 6 | `skill.md` | How should the AI coding agent work on this repo? (workflow, evidence-based Definition of Done, runtime agent prompt) | Process |
| 7 | `tasks.md` | In what order, by when? (phased plan, task IDs, DoD per task) | Plan |
| 8 | `risk.md` | What can kill the project? (anti-survivorship, single point of failure, pre-mortem, risk register, external-review log) | Mitigations |
| 9 | `demo.md` | How do we win the judges? (video script, submission checklist, criteria evidence matrix) | Delivery |

**Conflict resolution order:** `rule.md` > `spec.md` > `design.md` > `tech.md` > `tasks.md`.
If two files disagree, fix the lower-priority file, never silently pick one.

## Spec-Driven Development loop

1. Pick a task ID from `tasks.md`.
2. Read the referenced requirement IDs in `spec.md` (FR-*, P-*, AC-*, A-*).
3. Write/adjust the failing test that encodes the acceptance criterion.
4. Implement the smallest change that passes.
5. Produce **evidence** (see `skill.md` §3) — diff, command output, test output.
6. Update the status table below and commit.

## Status board (update as you go)

| Area | Status | Evidence link / commit |
|------|--------|------------------------|
| PayPal sandbox spike (T-002) | done — Plan B locked (11 Oct) | tech.md §4.3–4.4 |
| Mandate + policy engine + reservations (Phase 1–2) | implemented per repo (self-reported, `v0.9.0-rc2`) | tasks.md progress snapshot |
| Attack suite A-01..A-12 (Phase 2) | implemented per repo (self-reported) | tasks.md progress snapshot; add forged-webhook and nested-value cases |
| Agent runtime + owner confirmation (Phase 3) | partly reported; STEP_UP-under-Plan-B open | tasks.md |
| Live e2e with real capture (T-029) | **open — top priority** | |
| Dashboard (Phase 3) | not started | |
| Dispute module (Phase 4, Should) | not started | |
| README + video + Devpost text (Phase 5) | not started | |

## Bootstrap prompt for an AI coding agent

```text
You are working on AegisMandate. Before writing any code, read, in order:
README.md, rule.md, skill.md, product.md, spec.md, design.md, tech.md, tasks.md.
Work on exactly one task ID from tasks.md at a time. Obey rule.md absolutely.
Never claim a task is done without the evidence required by skill.md section 3.
If a PayPal API detail is marked VERIFY, check developer.paypal.com first and
record the result in tech.md before implementing.
```

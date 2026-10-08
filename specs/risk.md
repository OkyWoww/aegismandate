# risk.md — Evaluation and Risk Register

This file is written **before** feature work so that failure modes shape the design, not the other way around.

## 1. Anti-survivorship bias — what usually goes wrong in similar projects

Hackathon winners are visible; the many that fail the same way are not. Common failure patterns for "AI agent + payments" entries:

| Failure pattern seen in similar projects | Why it happens | MandatePay response |
|------------------------------------------|----------------|---------------------|
| Payment API used as a decorative button (fails "PayPal is core") | Integration done last, shallow | Real Orders + capture + webhooks are the **golden path (T-007)** built first |
| Demo works only on the author's laptop | Hidden env state, secrets, seed data | `verify-fresh-clone`, deterministic seeds, sandbox creds via Devpost field |
| "Security" claims with no proof | Detection demoed on one cherry-picked prompt | Reproducible 12-scenario attack suite, structural defenses, honest limits in README |
| Over-broad scope, nothing finished | Feature creep across 5 weeks | Strict MUST/SHOULD/COULD cut line; freeze on 5 Nov |
| LLM nondeterminism breaks the live demo | Real-LLM runs differ every time | `FakeLlm` for tests and for a scripted deterministic demo path; live LLM shown but never required for pass/fail |
| Mocked payments presented as real | Sandbox friction → shortcuts | "What is real vs. simulated" section; Plan B stated honestly |
| Video too long / unclear | Trying to show everything | Timed script, one story: *tricked → blocked → PayPal never called* |
| Idea is a re-skin of a crowded concept | Everyone builds a shopping bot | Differentiation is the containment layer + audit, not the shopping |

Also considered: **the opposite bias** — a thorough spec does not guarantee a win. Judges score five equally weighted criteria; excellence in security alone will not compensate for weak design, presentation, or a non-working demo.

## 2. Single point of failure (Abraham Wald logic) — reinforce first

Ask "where would the plane have to be hit to not come home?" The answer for this project:

| # | Weak point | Why fatal | Reinforcement (do first) |
|---|-----------|-----------|--------------------------|
| SPOF-1 | **A real, repeatable end-to-end PayPal sandbox payment** | Without it: fails Stage 1 ("PayPal core") and technical score | T-002 spike + T-007 golden path before any other feature; 20/20 reliability gate |
| SPOF-2 | **Vault/off-session authorization unavailable in sandbox** | Breaks the "agentic" autonomy claim | Plan B pre-approved; 4h timebox; honest framing |
| SPOF-3 | **Policy engine correctness** (a bypass makes the whole thesis false) | The product *is* the engine | Pure function; property tests; execution-time recheck; reservation accounting; attack suite |
| SPOF-4 | **Judge cannot run it** | Unrunnable = unscored | Fresh-clone verification; hosted URL (S2); < 10-minute README |
| SPOF-5 | **Single builder, single machine** | Illness/hardware failure in the last week | Push to remote daily; CI; scripts reproduce environment; freeze 5 Nov; 2-day buffer |
| SPOF-6 | **Webhooks unreachable in local runs** | State never reconciles; demo hangs | Polling fallback is mandatory, not optional |

## 3. Inversion / pre-mortem — "It is 13 Nov and we lost badly. Why?"

| Cause of total failure | Likelihood | Impact | Mitigation built in from the start | Early-warning signal |
|------------------------|-----------|--------|-----------------------------------|----------------------|
| Missed the deadline or mis-converted time zone | Low | Fatal | Internal submit 10 Nov; deadline in README/tasks as PT + WIB | Not submitted by 9 Nov |
| Disqualified on a rules technicality (no license, video >3 min, copyrighted music, missing demo access) | Medium | Fatal | `rule.md §4–5` checklist; re-read official rules in Phase 5 | Checklist item unchecked on 8 Nov |
| Demo fails during judging | Medium | Severe | Fresh-clone test; 20/20 runs; hosted fallback; recorded video as evidence | Flaky run in T-025 |
| Core claim disproved (someone bypasses the policy) | Low–Med | Severe | Structural design; A-01…A-12; property tests; no claim of complete detection | Any attack-suite failure |
| Budget over-commit / race condition found | Medium | Severe | Reservation accounting + `BEGIN IMMEDIATE` + concurrency tests (AC-8) | `test:concurrency` failure |
| Scope blow-up leaves a half-built dashboard and no polish | High | Severe | Tier cut line; weekly go/no-go gates | Phase gate missed by >1 day |
| Presentation fails to convey value in 3 minutes | Medium | Severe | Script in `demo.md`; one rehearsal per week from 30 Oct | Dry-run exceeds 3:00 |
| Idea judged "just a wrapper" | Medium | Moderate | Visible depth: reservations, hash-chained audit, dispute loop, attack metrics | Feedback from dry-run viewers |
| LLM provider outage/rate limit during demo or judging | Low–Med | Moderate | `FakeLlm` deterministic path; recorded video | API errors in dev |
| Plan B demo feels less "agentic" | Medium | Moderate | Narrate honestly; emphasize gating, audit, and containment (the actual novelty) | n/a |
| Chasing multiple sponsor prizes dilutes the core product | Medium | Moderate | One sponsor target only (`product.md §10`); sponsor work must not touch the golden path | Sponsor task scheduled before a MUST is green |
| Burnout / overlapping commitments in the same weeks | Medium | Severe | Tier cut order; capacity note; no work planned in buffer days | Two consecutive missed daily goals |

## 4. Residual-risk register (accepted, disclosed)

| Risk | Status | Disclosure |
|------|--------|-----------|
| Heuristic scanner has false negatives | Accepted | README states scanner is advisory; defense is structural |
| Sandbox ≠ production (fraud systems, limits, vaulting behavior) | Accepted | "Real vs. simulated" section |
| SQLite single-writer limits horizontal scale | Accepted | Out of scope for hackathon; noted as future work |
| Demo store is ours, not a real merchant ecosystem | Accepted | Stated plainly; adapter interface shows how real merchants plug in |

## 5. Assumptions to verify (blocking the plan if wrong)

| Assumption | Verified in | Owner | Fallback |
|------------|-------------|-------|----------|
| Orders create/capture works with sandbox merchant payee | T-002 | builder | None — must work |
| Vault v3 off-session capture in sandbox | T-002 (≤4h) | builder | Plan B |
| Webhook verification with sandbox webhook id | T-002 | builder | Polling-only, documented |
| Sandbox dispute creation/fetch | T-002 / T-021 | builder | Seed dispute through the sandbox resolution center; else demo module on recorded real payload and label it |
| PayPal Agent Toolkit availability/package details | T-023 | builder | Skip (COULD) |
| Current hackathon rules unchanged | Phase 5 re-read | builder | Adjust to latest rules |

## 6. Review log (external review incorporated)

| Review finding | Assessment | Action |
|----------------|-----------|--------|
| Clock/TTL fragility in tests and seeds | Valid | NFR-6: injected relative clock; seed relative to now |
| Pending STEP_UP not counted in budget | **Valid, important** | FR-26 reservations; P-08 uses `captured+reserved`; FR-27 queue cap; A-11; AC-8 |
| Nested payee smuggling | Partly valid: strict schemas already reject unknown keys, but values in free-text fields are the real gap | P-03 deep scan + value constraints; A-12 |
| Audit chain fork under concurrency | Valid (multi-connection / multi-process) | `BEGIN IMMEDIATE`, UNIQUE(prev_hash), API-only writer; AC-11 |
| Vault may need extra sandbox capabilities; timebox spike | Plausible, unverified | Timebox + decision gate 9 Oct; treated as VERIFY, not as fact |
| "Ready for implementation" | Premature | Not ready until T-002 results and Phase 0 gate are in; spec now marks open VERIFY items |

Additional hardening added independently: execution-time recheck (TOCTOU), approval payload-hash binding, agent-token scoping and rate limit, circuit breaker, webhook replay window, sandbox lock.

# rule.md — Hard Constraints (highest authority)

If any other file conflicts with this one, **this file wins**. A rule may be changed only by a deliberate, logged edit here — never silently to make a test pass.

## 1. Security invariants (INV)

| ID | Invariant | Verified by |
|----|-----------|-------------|
| INV-1 | The agent process has **no** PayPal credentials, SDK, or network path to PayPal. | AC-7, lint rule, CI env check |
| INV-2 | Payee is resolved **only** from the Merchant Registry configured by the user. | P-03, A-02, A-12 |
| INV-3 | Amount charged = server-verified price × qty, never an agent claim. | P-04, A-03 |
| INV-4 | Mandate limits change **only** via authenticated user UI; no agent-reachable path exists. | A-10, route review |
| INV-5 | The policy engine is a pure function: no I/O, no LLM, no wall clock. | design §6, property tests |
| INV-6 | Fail closed: errors, unknown states, and timeouts end in DENY / no order. | NFR-2, tests |
| INV-7 | No PayPal order is created without a stored ALLOW or an approved STEP_UP **and** a passing execution-time recheck. | FR-12, FR-29, AC-10 |
| INV-8 | `captured + reserved ≤ total_budget` at all times, including under concurrency. | FR-26, AC-8 |
| INV-9 | Every state change and PayPal interaction is in the hash-chained audit log, written in the same transaction. | FR-21, AC-5, AC-11 |
| INV-10 | Webhooks are trusted only after PayPal signature verification; invalid → 401, no state change. | AC-6, A-09 |
| INV-11 | The injection scanner is advisory; no attack class may depend on it alone. | spec §6 |
| INV-12 | The control plane refuses to start unless `PAYPAL_ENV=sandbox`. | NFR-7 |

## 2. Engineering rules

1. TypeScript `strict`; no `any` without a justifying comment; external input enters only through Zod schemas.
2. Money is integer minor units. No floating point for amounts, ever.
3. No `Date.now()` / `new Date()` inside `packages/policy`; the clock is injected. Tests use relative mocked clocks (NFR-6).
4. Every security-relevant branch has a test that **fails if the branch is removed**.
5. No `console.log` of secrets, tokens, PANs, or full PayPal responses; use the redacting logger.
6. No `eslint-disable`, `@ts-ignore`, or skipped tests on security paths without a linked spec clarification.
7. One task ID per commit series; conventional commits; spec IDs listed in the body.
8. Dependencies pinned, lockfile committed, `pnpm audit` clean (or documented exceptions) before submission.
9. Idempotency keys on all PayPal write calls; retries reuse the same key.
10. Anything uncertain about PayPal behavior is marked **VERIFY** and resolved in `tech.md §4.3` before being built on.

## 3. Process rules

1. **Evidence-based "done":** no task is called done without real diff, command output, and test output (see `skill.md §3`). A MUST task is never "done" on mocks alone when it says real sandbox.
2. **Scope discipline:** COULD → SHOULD → MUST cut order (`product.md §6`). After **5 Nov 2026 feature freeze**, only bug fixes, docs, and submission work.
3. **No silent weakening:** relaxing any INV or rule requires an entry in `spec.md §9` explaining why.
4. **Honesty in claims:** README, video, and Devpost text may not claim detection is complete, claim real-money capability, or imply features that are mocked. A "What is real vs. simulated" section is mandatory.
5. **Timeboxed spikes:** PayPal Vault spike ≤ 4 working hours; decision gate 9 Oct 2026.

## 4. Hackathon compliance rules (from the official rules — re-read before submitting)

1. **PayPal is core:** the project integrates PayPal developer tooling (sandbox) together with AI. Verify the current rules page once more during Phase 5 in case terms changed.
2. **New or significantly updated work:** all code is created during the hackathon period; if any pre-existing code is reused, document precisely what was added/changed.
3. **Public repository** (GitHub/GitLab/Bitbucket) with a clear **open-source license** (MIT) visible in the repo.
4. **Working demo access:** hosted URL **or** complete, tested README run instructions plus sandbox/mock credentials for judges. A static mockup is not acceptable.
5. **Text description in English** covering features, problem, and how it works.
6. **Demo video ≤ 3 minutes**, public or unlisted on YouTube, showing the working flow, **no copyrighted music or unlicensed material**.
7. **Sponsor-tool claims** (AG Grid, Render, etc.) only where the integration is real and visible in the repo/demo.
8. **Eligibility:** age of majority; not in a sanctioned region; prize payments need identity and US tax form (e.g. W-8BEN) — prepare early.
9. **No secrets in the repo.** Judges receive sandbox credentials via the Devpost testing-instructions field, not the repo.
10. Respect third-party terms (PayPal, LLM provider, any libraries). Use the sandbox only; no real funds or real personal/financial data.

## 5. Definition of "ready to submit" (all must be true)

- [ ] `pnpm verify-fresh-clone` passes on a clean machine/container; output archived.
- [ ] `pnpm typecheck && pnpm lint && pnpm test && pnpm attack-suite && pnpm test:concurrency` all green; outputs archived.
- [ ] Attack suite shows 12/12 blocked before any PayPal call.
- [ ] ≥ 3 legit scenarios complete end-to-end in the PayPal sandbox, 20 consecutive runs without failure.
- [ ] README "run in < 10 minutes" verified by following it literally.
- [ ] LICENSE (MIT) present; no secrets in git history (`git log -p | grep` scan or a secret scanner).
- [ ] Video ≤ 3:00, English narration or captions, no copyrighted music, uploaded and playable while logged out.
- [ ] Devpost form complete: description, repo URL, demo URL/instructions, video URL, sandbox credentials, sponsor-tool notes.
- [ ] Submitted by **10 Nov 2026** (hard limit: 12 Nov 12:00 PT = 13 Nov 03:00 WIB).

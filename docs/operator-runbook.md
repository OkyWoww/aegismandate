# Operator Runbook (Demo Recording)

Operator guide, separate from the video script in [`demo-script.md`](demo-script.md).
Every on-screen claim below is a hypothesis until you have clicked through it once yourself.

## Honesty rules (do not break these on camera)

- **ALLOW does not mean "paid automatically".** It means the order is created and an `approve_url` is issued. The payer still approves on PayPal, then the server captures. Say: *"Under the limit, the order is created immediately. The payer still approves the payee and amount on PayPal."*
- **Simulation Console = scripted replay.** It posts pre-written proposals. It is not a live LLM reading a page. Say "replay of an agent that was fooled".
- **Simulation and seeded data may be mock.** Mock IDs look like `ORDER-SANDBOX-*` / `CAPTURE-SANDBOX-*`. The dashboard shows a `MOCK SEED` badge on the impact cards. For a "real sandbox payment" scene use `pnpm e2e:live:stepup` (headed) or a recorded live run.
- **The ledger is tamper-evident, not tamper-proof.** Anyone with database write access can recompute the chain. Do not say "impossible to forge" or "blockchain".

## Before recording

```powershell
pnpm demo:reset
pnpm demo:seed
pnpm dev
```

- Step-up cards expire a few minutes after seeding. Reset and seed again right before the step-up scene.
- Use a throwaway `OWNER_TOKEN` for the recording and rotate it afterwards. The key field is a password input and is kept in `sessionStorage`. Never show the real `.env`.
- Open `http://localhost:3000`.

## Scenes

1. **Owner key.** In Step-Up Approvals Queue click `No Owner Key`, paste the demo token, click Done. The button turns into `Owner Key Set`.
2. **Normal purchase.** Console, `SCENARIO-1`, Submit Intent Proposal. Expect verdict `ALLOW`. Narrate the honesty rule above. For a real payment, cut to the live e2e recording.
3. **Attack.** `SCENARIO-3`. Expect `DENY` with reason codes shown in the policy trace. Read the codes on screen; do not assume which ones appear.
4. **Step-up.** `SCENARIO-2`. Expect `STEP_UP` and a card in the queue. Click `Approve & Authorize PayPal`. Expect status `Awaiting Buyer Approval on PayPal Sandbox` and an `Approve on PayPal Sandbox` link. Open that link and approve as the sandbox buyer (or show the live e2e run). Then click `Check Capture Status`.
5. **Audit, green.** Click `Verify Ledger Integrity`. Expect `Cryptographic Chain Valid (PASS)` and the `VERIFIED` badge.
6. **Audit, red.** In a terminal run `pnpm demo:tamper` (changes one digit in one audit row), click Verify again. Expect `Hash Chain Tampering Detected (FAIL)` and `TAMPERED`. Afterwards `pnpm demo:tamper --restore`, or reset and seed.

## Pre-record checklist

- [ ] `pnpm demo:reset; pnpm demo:seed; pnpm dev` runs clean
- [ ] Approve returns 200 in the browser (no 401, no `Intent not found`)
- [ ] Impact cards show `MOCK SEED` or not, and your narration matches
- [ ] Tamper turns the badge red and restore turns it green
- [ ] Owner token on screen is the throwaway one
- [ ] Narration contains no "paid automatically", "impossible to forge", or "blockchain"

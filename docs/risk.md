# AegisMandate: Residual Risk & Threat Containment Analysis

> **Document Version:** 1.0.0  
> **Target Architecture:** Plan B (Human-in-the-Loop / Server-Gated Approval Link)  
> **Specification Reference:** `specs/spec.md §4, §6`, `specs/tech.md §4.3`, `specs/design.md §3`

---

## 1. Executive Summary

Autonomous AI shopping agents operate under inherently untrusted execution environments: untrusted web inputs, indirect prompt injections, adversarial catalog descriptions, and stochastic LLM reasoning. Granting an AI agent direct access to payment credentials or unrestricted wallet tokens creates an existential financial hazard.

**AegisMandate** eliminates this hazard by establishing a deterministic **Control Plane** that treats the AI agent as completely untrusted. The user-signed **Mandate** functions as a **cryptographic bounding box (blast radius containment plane)**.

This document formally details the **Plan B architecture**, the mathematical bounds on financial loss, and the residual risk assessment.

---

## 2. Plan B Architecture: Server-Gated Approval Flow

### 2.1 The Architectural Decision Gate
During the initial sandbox spike (`specs/tech.md §4.3`, Task `T-002`), default PayPal developer sandbox business accounts were verified to lack custom merchant underwriting for Vault v3 off-session Reference Transactions (`PERMISSION_DENIED` / `UNPROCESSABLE_ENTITY`).

Per specification gate criteria, **Plan B was formally locked**:
- In **Plan A**, an agent captures payments completely off-session via vaulted tokens.
- In **Plan B**, the Control Plane strictly evaluates whether an order is created and with what parameters. Each authorized intent creates a PayPal order, and the buyer authorizes settlement via the secure PayPal checkout portal (`rel: approve`).

### 2.2 Why Plan B Provides Superior Containment
1. **Zero Credential Exposure (INV-1):** The Cognitive Plane (agent) holds zero PayPal API keys, OAuth secrets, or payment credentials.
2. **Server-Side Payee Sourcing (INV-2):** The payee account in all PayPal order creations is strictly resolved from the trusted Merchant Registry in SQLite, completely ignoring any payee hints or recipient strings from the agent proposal.
3. **Cryptographic Payload Binding (FR-28, AC-9):** When an intent requires human step-up review, the payload hash `SHA256(canonical(mandate_id, items, total, payee))` is recorded. Any subsequent modification to the order fails the hash binding check.
4. **Pre-Approval Gate Enforcement:** PayPal Orders v2 strictly enforces that an order cannot be captured without buyer authorization (`ORDER_NOT_APPROVED`, HTTP 422).

---

## 3. Mathematical Bounding of Financial Loss

Under AegisMandate, **unbounded financial loss is mathematically impossible**, even if the underlying LLM is 100% hijacked by an adversary:

| Constraint Parameter | Mathematical Invariant | Enforcing Rule | Failure Consequence |
|---|---|---|---|
| **Per-Transaction Limit** | $\text{total}_{\text{intent}} \le \text{per\_txn\_limit\_minor}$ | Rule `P-07` | Intent denied (`OVER_TXN_LIMIT`). Max loss per order strictly bounded. |
| **Cumulative Mandate Budget** | $\sum \text{captured} + \sum \text{reserved} + \text{current} \le \text{total\_budget\_minor}$ | Rule `P-07` / `P-08` | Intent denied (`BUDGET_EXCEEDED`). Max loss across mandate lifetime strictly capped. |
| **Merchant Allowlist** | $\text{merchant\_id} \in \text{allowed\_merchants}$ | Rule `P-03` | Intent denied (`MERCHANT_NOT_ALLOWED`). Funds cannot flow to unauthorized entities. |
| **Authoritative Pricing** | $\text{claimed\_price} == \text{catalog\_price}$ | Rule `P-04` | Intent denied (`PRICE_MISMATCH` / `UNKNOWN_SKU`). Agent cannot forge invoice costs. |
| **Queue Saturation Cap** | $\text{count}(\text{pending}) < \text{max\_pending\_approvals}$ | Rule `P-07` (FR-27) | Intent denied (`APPROVAL_QUEUE_FULL`). Prevents human approver fatigue attacks. |

$$\text{Maximum Possible Financial Loss} \le \min(\text{per\_txn\_limit}, \text{remaining\_budget})$$

---

## 4. Residual Risk Matrix & Countermeasures

| Threat Vector | Attack Mechanism | Residual Risk Level | Mitigating Countermeasure & Verification |
|---|---|:---:|---|
| **Indirect Prompt Injection** | Web review injects instructions to buy attacker gift cards | **LOW** (Bounded) | Advisory scanner detects signals (`P-10`). Structural rules (`P-03`, `P-04`, `P-07`) independently block unauthorized merchants, fake SKUs, and limit breaches even if scanner score is 0 (`INV-11`). |
| **Payee Smuggling** | Attacker embeds IBAN or PayPal email in `sku`, `ref`, or `rationale` | **ZERO** | `deepKeyScan` performs recursive regex scan across all payload keys and string values (`P-03`). Payee is strictly loaded from internal registry (`INV-2`). |
| **Price Tampering** | Agent claims item costs $10.00 while merchant charges $500.00 | **ZERO** | Control Plane resolves authoritative price directly from trusted catalog table (`P-04`). Mismatches return `PRICE_MISMATCH`. |
| **Approval Fatigue / Queue Saturation** | Attacker floods system with 1,000 $1 step-up proposals | **ZERO** | FR-27 caps pending step-up queue at `max_pending_approvals` (default: 3). Subsequent proposals immediately rejected (`APPROVAL_QUEUE_FULL`). |
| **TOCTOU Race Condition** | Mandate revoked or expired while PayPal call is in-flight | **ZERO** | Execution-time recheck (`FR-29`, `AC-10`) re-validates mandate status and catalog prices inside atomic `BEGIN IMMEDIATE` transaction prior to capture. |
| **Webhook Signature Forgery** | Attacker posts forged webhook claiming payment completed | **ZERO** | Fastify endpoint calls `/v1/notifications/verify-webhook-signature` using PayPal public key certificates (`AC-6`, `INV-10`). Forged signatures return HTTP 400 `INVALID_WEBHOOK_SIGNATURE`. |
| **Concurrency Collisions** | Simultaneous multi-process requests attempting budget double-spend | **ZERO** | SQLite WAL mode + `BEGIN IMMEDIATE` + exponential backoff retry guarantees contiguous sequence (`1..N`) and prevents double-spending (`INV-8`, `AC-11`). |

---

## 5. Summary Conclusion

AegisMandate's **Plan B** converts an untrusted, stochastic agent into a deterministic economic actor. While the cognitive agent proposes purchase intents, the trusted control plane enforces an unbreachable cryptographic perimeter.

**Every dollar spent is bounded, every payee is verified, every state change is hash-chained, and out-of-band actions require explicit human authorization.**

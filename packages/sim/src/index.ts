export interface AttackTestCase {
  id: string; // A-01 to A-12
  name: string;
  description: string;
  vector: string;
  expectedOutcome: 'REJECT' | 'ALERT' | 'BLOCKED';
}

export const ATTACK_SCENARIOS: AttackTestCase[] = [
  { id: 'A-01', name: 'Budget Exceeded', description: 'Agent attempts purchase exceeding total mandate limit', vector: 'Cart total > maxTotalBudget', expectedOutcome: 'REJECT' },
  { id: 'A-02', name: 'Single-Item Cap Exceeded', description: 'Single item price exceeds per-item limit', vector: 'Item unitPrice > maxPerItem', expectedOutcome: 'REJECT' },
  { id: 'A-03', name: 'Unapproved Merchant', description: 'Attempting purchase at non-whitelisted store', vector: 'Merchant domain not in whitelist', expectedOutcome: 'REJECT' },
  { id: 'A-04', name: 'Expired Mandate', description: 'Intent submitted past validity timestamp', vector: 'now > expiresAt', expectedOutcome: 'REJECT' },
  { id: 'A-05', name: 'Category Violation', description: 'Attempting to buy gift cards or crypto', vector: 'category in forbiddenCategories', expectedOutcome: 'REJECT' },
  { id: 'A-06', name: 'Tampered Mandate HMAC', description: 'Altering mandate budget without re-signing', vector: 'HMAC signature mismatch', expectedOutcome: 'REJECT' },
  { id: 'A-07', name: 'Currency Mismatch', description: 'Purchasing in EUR when USD mandate issued', vector: 'intent.currency !== mandate.currency', expectedOutcome: 'REJECT' },
  { id: 'A-08', name: 'Indirect Prompt Injection', description: 'Adversarial store injected text in metadata', vector: 'Advisory regex matching injection patterns', expectedOutcome: 'BLOCKED' },
  { id: 'A-09', name: 'Replay Intent Attack', description: 'Reusing identical intent nonce', vector: 'Duplicate nonce submitted to Control Plane', expectedOutcome: 'REJECT' },
  { id: 'A-10', name: 'Price Drift / Bait & Switch', description: 'Merchant invoice price differs from intent', vector: 'checkoutPrice != intentPrice', expectedOutcome: 'REJECT' },
  { id: 'A-11', name: 'Ledger Tamper Detection', description: 'Altering historical SQLite audit entry', vector: 'Broken sha256 hash chaining', expectedOutcome: 'ALERT' },
  { id: 'A-12', name: 'Boundary Import Breach', description: 'Untrusted apps/agent importing paypal client', vector: 'ESLint boundary violation', expectedOutcome: 'BLOCKED' },
];

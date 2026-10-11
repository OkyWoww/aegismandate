import { evaluatePolicy } from '@mandatepay/policy';
import { verifyLedgerIntegrity } from '@mandatepay/audit';
import { scanAdvisoryText } from '@mandatepay/scanner';
import { PayPalClient } from '@mandatepay/paypal';
import type { Mandate, PurchaseIntent } from '@mandatepay/schemas';

export interface ControlPlaneService {
  evaluateIntent: (mandate: Mandate, intent: PurchaseIntent, currentSpend: number) => ReturnType<typeof evaluatePolicy>;
  scanPayload: (text: string) => ReturnType<typeof scanAdvisoryText>;
  verifyLedger: (events: Parameters<typeof verifyLedgerIntegrity>[0]) => ReturnType<typeof verifyLedgerIntegrity>;
  paypalClient: PayPalClient;
}

export function createControlPlane(payPalConfig: ConstructorParameters<typeof PayPalClient>[0]): ControlPlaneService {
  return {
    evaluateIntent: (mandate, intent, currentSpend) => evaluatePolicy({ mandate, intent, cumulativeSpendToDate: currentSpend }),
    scanPayload: (text) => scanAdvisoryText(text),
    verifyLedger: (events) => verifyLedgerIntegrity(events),
    paypalClient: new PayPalClient(payPalConfig),
  };
}

export * from './mandate-service.js';
export * from './executor.js';


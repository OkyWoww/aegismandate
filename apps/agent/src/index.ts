import { scanAdvisoryText } from '@mandatepay/scanner';
import type { PurchaseIntent, LineItem, CurrencyCode } from '@mandatepay/schemas';

export interface AgentConfig {
  controlPlaneUrl: string;
  agentToken: string;
}

export class ShopperAgent {
  private readonly config: AgentConfig;

  constructor(config: AgentConfig) {
    this.config = config;
  }

  /**
   * Pre-screens web scrape contents with advisory scanner before forming intent
   */
  screenProductDescription(text: string) {
    return scanAdvisoryText(text);
  }

  /**
   * Creates an untrusted purchase intent to propose to the trusted Control Plane.
   * Notice: The agent cannot authorize or capture payments directly!
   */
  createPurchaseIntent(params: {
    id: string;
    mandateId: string;
    merchantDomain: string;
    items: LineItem[];
    currency: CurrencyCode;
    nonce: string;
  }): PurchaseIntent {
    const totalAmount = params.items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
    return {
      id: params.id,
      mandateId: params.mandateId,
      merchantDomain: params.merchantDomain,
      items: params.items,
      totalAmount,
      currency: params.currency,
      nonce: params.nonce,
      timestamp: new Date().toISOString(),
    };
  }
}

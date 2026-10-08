import type { PurchaseIntent, LineItem } from '@mandatepay/schemas';

export interface PayPalConfig {
  clientId: string;
  clientSecret: string;
  environment: 'sandbox' | 'live';
  webhookId?: string;
}

export interface PayPalOrderResponse {
  id: string;
  status: 'CREATED' | 'SAVED' | 'APPROVED' | 'VOIDED' | 'COMPLETED' | 'PAYER_ACTION_REQUIRED';
  intent: 'CAPTURE' | 'AUTHORIZE';
  purchaseUnits: Array<{
    referenceId?: string;
    amount: {
      currencyCode: string;
      value: string;
    };
  }>;
}

export interface PayPalCaptureResponse {
  id: string;
  status: 'COMPLETED' | 'DECLINED' | 'FAILED' | 'PENDING';
  amount: {
    currencyCode: string;
    value: string;
  };
  sellerProtection?: {
    status: string;
  };
}

export class PayPalClient {
  private readonly config: PayPalConfig;
  private accessToken: string | null = null;
  private tokenExpiresAt: number = 0;

  constructor(config: PayPalConfig) {
    this.config = config;
  }

  get baseUrl(): string {
    return this.config.environment === 'live'
      ? 'https://api-m.paypal.com'
      : 'https://api-m.sandbox.paypal.com';
  }

  async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiresAt) {
      return this.accessToken;
    }

    // In mock/demo mode or sandbox
    const authHeader = Buffer.from(
      `${this.config.clientId}:${this.config.clientSecret}`
    ).toString('base64');

    const res = await fetch(`${this.baseUrl}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${authHeader}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });

    if (!res.ok) {
      throw new Error(`PayPal OAuth failure: ${res.statusText}`);
    }

    const data = (await res.json()) as { access_token: string; expires_in: number };
    this.accessToken = data.access_token;
    this.tokenExpiresAt = Date.now() + (data.expires_in - 60) * 1000;
    return this.accessToken;
  }

  async createOrder(intent: PurchaseIntent): Promise<PayPalOrderResponse> {
    const token = await this.getAccessToken();
    const res = await fetch(`${this.baseUrl}/v2/checkout/orders`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [
          {
            reference_id: intent.id,
            amount: {
              currency_code: intent.currency,
              value: intent.totalAmount.toFixed(2),
            },
            items: intent.items.map((it: LineItem) => ({
              name: it.name,
              unit_amount: {
                currency_code: intent.currency,
                value: it.unitPrice.toFixed(2),
              },
              quantity: it.quantity.toString(),
            })),
          },
        ],
      }),
    });

    if (!res.ok) {
      throw new Error(`PayPal createOrder failure: ${res.statusText}`);
    }

    return (await res.json()) as PayPalOrderResponse;
  }

  async captureOrder(orderId: string): Promise<PayPalCaptureResponse> {
    const token = await this.getAccessToken();
    const res = await fetch(`${this.baseUrl}/v2/checkout/orders/${orderId}/capture`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });

    if (!res.ok) {
      throw new Error(`PayPal captureOrder failure: ${res.statusText}`);
    }

    return (await res.json()) as PayPalCaptureResponse;
  }
}

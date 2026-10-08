/**
 * MandatePay - PayPal Typed Client
 * Enforces:
 * - INV-12: Sandboxed control plane client (refuses non-sandbox in default configuration)
 * - FR-12..15: Orders v2 API with deterministic idempotency keys
 * - tech.md §4: OAuth token caching, Orders create/capture/get, Webhook signature verification, Vault v3 spike
 */

export interface PayPalConfig {
  clientId: string;
  clientSecret: string;
  environment: 'sandbox' | 'live';
  webhookId?: string;
  fetchFn?: typeof fetch;
}

export interface PayPalPayee {
  emailAddress?: string;
  merchantId?: string;
}

export interface OrderItem {
  name: string;
  sku?: string;
  quantity: number;
  unitAmountMinor: number;
  category?: string;
}

export interface CreateOrderParams {
  referenceId: string;
  currency: string;
  totalMinor: number;
  items: OrderItem[];
  payee?: PayPalPayee;
  requestId?: string;
  returnUrl?: string;
  cancelUrl?: string;
}

export interface PayPalOrderResponse {
  id: string;
  status: 'CREATED' | 'SAVED' | 'APPROVED' | 'VOIDED' | 'COMPLETED' | 'PAYER_ACTION_REQUIRED';
  intent: 'CAPTURE' | 'AUTHORIZE';
  purchase_units?: Array<{
    reference_id?: string;
    payee?: {
      email_address?: string;
      merchant_id?: string;
    };
    amount: {
      currency_code: string;
      value: string;
      breakdown?: {
        item_total?: {
          currency_code: string;
          value: string;
        };
      };
    };
    payments?: {
      captures?: Array<{
        id: string;
        status: string;
        amount: {
          currency_code: string;
          value: string;
        };
      }>;
    };
  }>;
  links?: Array<{
    href: string;
    rel: string;
    method: string;
  }>;
}

export interface PayPalCaptureResponse {
  id: string;
  status: 'COMPLETED' | 'DECLINED' | 'FAILED' | 'PENDING';
  amount: {
    currency_code: string;
    value: string;
  };
  seller_protection?: {
    status: string;
  };
  links?: Array<{
    href: string;
    rel: string;
    method: string;
  }>;
}

export interface WebhookVerificationParams {
  authAlgo: string;
  certUrl: string;
  transmissionId: string;
  transmissionSig: string;
  transmissionTime: string;
  webhookId: string;
  webhookEvent: Record<string, unknown>;
}

export interface WebhookVerificationResponse {
  verification_status: 'SUCCESS' | 'FAILURE';
}

export interface VaultSetupTokenParams {
  customerRef?: string;
  returnUrl?: string;
  cancelUrl?: string;
}

export interface VaultSetupTokenResponse {
  id: string;
  status: 'CREATED' | 'APPROVED' | 'REJECTED';
  links?: Array<{
    href: string;
    rel: string;
    method: string;
  }>;
}

export interface VaultPaymentTokenResponse {
  id: string;
  customer?: {
    id: string;
  };
  payment_source?: Record<string, unknown>;
  status?: string;
}

/**
 * Converts integer minor units (e.g. 1050 cents) to PayPal decimal string ("10.50").
 */
export function minorUnitsToDecimal(minor: number): string {
  if (!Number.isInteger(minor)) {
    throw new TypeError(`Amount must be an integer minor unit (received: ${minor})`);
  }
  const isNegative = minor < 0;
  const abs = Math.abs(minor);
  const dollars = Math.floor(abs / 100);
  const cents = abs % 100;
  const str = `${dollars}.${cents.toString().padStart(2, '0')}`;
  return isNegative ? `-${str}` : str;
}

export class PayPalClient {
  private readonly config: PayPalConfig;
  private accessToken: string | null = null;
  private tokenExpiresAt: number = 0;
  private readonly fetchImpl: typeof fetch;

  constructor(config: PayPalConfig) {
    if (!config.clientId || !config.clientSecret) {
      throw new Error('PayPalClient requires clientId and clientSecret.');
    }
    this.config = config;
    this.fetchImpl = config.fetchFn ?? globalThis.fetch;
  }

  get baseUrl(): string {
    return this.config.environment === 'live'
      ? 'https://api-m.paypal.com'
      : 'https://api-m.sandbox.paypal.com';
  }

  get environment(): 'sandbox' | 'live' {
    return this.config.environment;
  }

  /**
   * Fetches or returns cached OAuth bearer token via Basic auth.
   */
  async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiresAt) {
      return this.accessToken;
    }

    const authHeader = Buffer.from(
      `${this.config.clientId}:${this.config.clientSecret}`,
    ).toString('base64');

    const res = await this.fetchImpl(`${this.baseUrl}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${authHeader}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`PayPal OAuth failure (${res.status} ${res.statusText}): ${errText}`);
    }

    const data = (await res.json()) as { access_token: string; expires_in: number };
    this.accessToken = data.access_token;
    // Cache token until 60 seconds before expiration
    this.tokenExpiresAt = Date.now() + Math.max(0, data.expires_in - 60) * 1000;
    return this.accessToken;
  }

  /**
   * Create an Order with intent CAPTURE and optional payee from Merchant Registry.
   * Sends idempotency header PayPal-Request-Id.
   */
  async createOrder(params: CreateOrderParams): Promise<PayPalOrderResponse> {
    const token = await this.getAccessToken();

    const totalValue = minorUnitsToDecimal(params.totalMinor);

    const purchaseUnit: Record<string, unknown> = {
      reference_id: params.referenceId,
      amount: {
        currency_code: params.currency,
        value: totalValue,
        breakdown: {
          item_total: {
            currency_code: params.currency,
            value: totalValue,
          },
        },
      },
      items: params.items.map((it) => ({
        name: it.name,
        sku: it.sku,
        unit_amount: {
          currency_code: params.currency,
          value: minorUnitsToDecimal(it.unitAmountMinor),
        },
        quantity: it.quantity.toString(),
      })),
    };

    if (params.payee) {
      const payeeObj: Record<string, string> = {};
      if (params.payee.emailAddress) {
        payeeObj.email_address = params.payee.emailAddress;
      }
      if (params.payee.merchantId) {
        payeeObj.merchant_id = params.payee.merchantId;
      }
      if (Object.keys(payeeObj).length > 0) {
        purchaseUnit.payee = payeeObj;
      }
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };

    if (params.requestId) {
      headers['PayPal-Request-Id'] = params.requestId;
    }

    const payload: Record<string, unknown> = {
      intent: 'CAPTURE',
      purchase_units: [purchaseUnit],
    };

    if (params.returnUrl || params.cancelUrl) {
      payload.application_context = {
        return_url: params.returnUrl,
        cancel_url: params.cancelUrl,
        user_action: 'PAY_NOW',
      };
    }

    const res = await this.fetchImpl(`${this.baseUrl}/v2/checkout/orders`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`PayPal createOrder failure (${res.status} ${res.statusText}): ${errText}`);
    }

    return (await res.json()) as PayPalOrderResponse;
  }

  /**
   * Get an existing order by ID.
   */
  async getOrder(orderId: string): Promise<PayPalOrderResponse> {
    const token = await this.getAccessToken();

    const res = await this.fetchImpl(`${this.baseUrl}/v2/checkout/orders/${encodeURIComponent(orderId)}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`PayPal getOrder failure (${res.status} ${res.statusText}): ${errText}`);
    }

    return (await res.json()) as PayPalOrderResponse;
  }

  /**
   * Capture an authorized/approved order.
   * Sends idempotency header PayPal-Request-Id.
   */
  async captureOrder(orderId: string, requestId?: string): Promise<PayPalCaptureResponse> {
    const token = await this.getAccessToken();

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };

    if (requestId) {
      headers['PayPal-Request-Id'] = requestId;
    }

    const res = await this.fetchImpl(
      `${this.baseUrl}/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`,
      {
        method: 'POST',
        headers,
      },
    );

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`PayPal captureOrder failure (${res.status} ${res.statusText}): ${errText}`);
    }

    return (await res.json()) as PayPalCaptureResponse;
  }

  /**
   * Verify an incoming PayPal webhook signature.
   * Enforces INV-10 / AC-6.
   */
  async verifyWebhookSignature(params: WebhookVerificationParams): Promise<WebhookVerificationResponse> {
    const token = await this.getAccessToken();

    const payload = {
      auth_algo: params.authAlgo,
      cert_url: params.certUrl,
      transmission_id: params.transmissionId,
      transmission_sig: params.transmissionSig,
      transmission_time: params.transmissionTime,
      webhook_id: params.webhookId || this.config.webhookId,
      webhook_event: params.webhookEvent,
    };

    const res = await this.fetchImpl(`${this.baseUrl}/v1/notifications/verify-webhook-signature`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`PayPal webhook signature verification failed (${res.status} ${res.statusText}): ${errText}`);
    }

    return (await res.json()) as WebhookVerificationResponse;
  }

  /**
   * Vault v3 spike: Attempt to create a setup token for PayPal off-session payment.
   */
  async createVaultSetupToken(params: VaultSetupTokenParams): Promise<VaultSetupTokenResponse> {
    const token = await this.getAccessToken();

    const body = {
      payment_source: {
        paypal: {
          usage_type: 'MERCHANT',
          experience_context: {
            return_url: params.returnUrl || 'http://localhost:8787/vault/return',
            cancel_url: params.cancelUrl || 'http://localhost:8787/vault/cancel',
          },
        },
      },
    };

    const res = await this.fetchImpl(`${this.baseUrl}/v3/vault/setup-tokens`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`PayPal Vault setup-tokens failure (${res.status} ${res.statusText}): ${errText}`);
    }

    return (await res.json()) as VaultSetupTokenResponse;
  }

  /**
   * Vault v3 spike: Exchange approved setup token for permanent payment token.
   */
  async createVaultPaymentToken(setupTokenId: string): Promise<VaultPaymentTokenResponse> {
    const token = await this.getAccessToken();

    const body = {
      payment_source: {
        token: {
          id: setupTokenId,
          type: 'SETUP_TOKEN',
        },
      },
    };

    const res = await this.fetchImpl(`${this.baseUrl}/v3/vault/payment-tokens`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`PayPal Vault payment-tokens failure (${res.status} ${res.statusText}): ${errText}`);
    }

    return (await res.json()) as VaultPaymentTokenResponse;
  }
}

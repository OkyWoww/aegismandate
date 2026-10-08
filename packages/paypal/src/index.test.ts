import { describe, it, expect, vi } from 'vitest';
import { PayPalClient, minorUnitsToDecimal } from './index.js';

describe('PayPalClient (packages/paypal)', () => {
  it('minorUnitsToDecimal correctly formats integer minor units', () => {
    expect(minorUnitsToDecimal(1050)).toBe('10.50');
    expect(minorUnitsToDecimal(99)).toBe('0.99');
    expect(minorUnitsToDecimal(5)).toBe('0.05');
    expect(minorUnitsToDecimal(0)).toBe('0.00');
    expect(minorUnitsToDecimal(100000)).toBe('1000.00');
    expect(() => minorUnitsToDecimal(12.34)).toThrow(TypeError);
  });

  it('obtains OAuth access token and caches until expiration', async () => {
    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes('/v1/oauth2/token')) {
        callCount++;
        expect(init?.method).toBe('POST');
        const authHeader = (init?.headers as Record<string, string>)?.Authorization;
        expect(authHeader).toBe(`Basic ${Buffer.from('client_id_test:client_sec_test').toString('base64')}`);
        return new Response(JSON.stringify({ access_token: 'test_token_123', expires_in: 3600 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('Not Found', { status: 404 });
    });

    const client = new PayPalClient({
      clientId: 'client_id_test',
      clientSecret: 'client_sec_test',
      environment: 'sandbox',
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const token1 = await client.getAccessToken();
    expect(token1).toBe('test_token_123');
    expect(callCount).toBe(1);

    // Second call should return cached token without fetching again
    const token2 = await client.getAccessToken();
    expect(token2).toBe('test_token_123');
    expect(callCount).toBe(1);
  });

  it('creates an order with intent CAPTURE, payee, items breakdown, and idempotency key', async () => {
    const mockFetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes('/v1/oauth2/token')) {
        return new Response(JSON.stringify({ access_token: 'tok_abc', expires_in: 3600 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('/v2/checkout/orders') && init?.method === 'POST') {
        const headers = init?.headers as Record<string, string>;
        expect(headers.Authorization).toBe('Bearer tok_abc');
        expect(headers['PayPal-Request-Id']).toBe('req_idem_456');

        const body = JSON.parse(init?.body as string);
        expect(body.intent).toBe('CAPTURE');
        expect(body.purchase_units[0].reference_id).toBe('int_01');
        expect(body.purchase_units[0].amount.value).toBe('25.00');
        expect(body.purchase_units[0].amount.breakdown.item_total.value).toBe('25.00');
        expect(body.purchase_units[0].payee.email_address).toBe('merchant@demo.store');
        expect(body.purchase_units[0].items[0].name).toBe('Fountain Pen');
        expect(body.purchase_units[0].items[0].unit_amount.value).toBe('12.50');
        expect(body.purchase_units[0].items[0].quantity).toBe('2');

        return new Response(
          JSON.stringify({
            id: 'ORDER-SANDBOX-789',
            status: 'CREATED',
            intent: 'CAPTURE',
            purchase_units: body.purchase_units,
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('Not Found', { status: 404 });
    });

    const client = new PayPalClient({
      clientId: 'id',
      clientSecret: 'sec',
      environment: 'sandbox',
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const res = await client.createOrder({
      referenceId: 'int_01',
      currency: 'USD',
      totalMinor: 2500,
      requestId: 'req_idem_456',
      payee: { emailAddress: 'merchant@demo.store' },
      items: [
        {
          name: 'Fountain Pen',
          sku: 'SKU-PEN',
          unitAmountMinor: 1250,
          quantity: 2,
        },
      ],
    });

    expect(res.id).toBe('ORDER-SANDBOX-789');
    expect(res.status).toBe('CREATED');
  });

  it('captures an order with PayPal-Request-Id idempotency key', async () => {
    const mockFetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes('/v1/oauth2/token')) {
        return new Response(JSON.stringify({ access_token: 'tok_abc', expires_in: 3600 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('/v2/checkout/orders/ORDER-123/capture')) {
        const headers = init?.headers as Record<string, string>;
        expect(headers['PayPal-Request-Id']).toBe('capture_idem_99');
        return new Response(
          JSON.stringify({
            id: 'CAPTURE-456',
            status: 'COMPLETED',
            amount: { currency_code: 'USD', value: '25.00' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('Not Found', { status: 404 });
    });

    const client = new PayPalClient({
      clientId: 'id',
      clientSecret: 'sec',
      environment: 'sandbox',
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const res = await client.captureOrder('ORDER-123', 'capture_idem_99');
    expect(res.id).toBe('CAPTURE-456');
    expect(res.status).toBe('COMPLETED');
  });

  it('verifies webhook signature against /v1/notifications/verify-webhook-signature', async () => {
    const mockFetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes('/v1/oauth2/token')) {
        return new Response(JSON.stringify({ access_token: 'tok_abc', expires_in: 3600 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('/v1/notifications/verify-webhook-signature')) {
        const body = JSON.parse(init?.body as string);
        expect(body.webhook_id).toBe('WH-TEST-001');
        expect(body.transmission_id).toBe('tx-99');
        return new Response(
          JSON.stringify({ verification_status: 'SUCCESS' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('Not Found', { status: 404 });
    });

    const client = new PayPalClient({
      clientId: 'id',
      clientSecret: 'sec',
      webhookId: 'WH-TEST-001',
      environment: 'sandbox',
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const res = await client.verifyWebhookSignature({
      authAlgo: 'SHA256withRSA',
      certUrl: 'https://api.sandbox.paypal.com/v1/notifications/certs/cert.pem',
      transmissionId: 'tx-99',
      transmissionSig: 'sig_base64',
      transmissionTime: '2026-10-08T12:00:00Z',
      webhookId: 'WH-TEST-001',
      webhookEvent: { event_type: 'PAYMENT.CAPTURE.COMPLETED' },
    });

    expect(res.verification_status).toBe('SUCCESS');
  });

  it('Vault v3: handles setup-tokens and payment-tokens requests', async () => {
    const mockFetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes('/v1/oauth2/token')) {
        return new Response(JSON.stringify({ access_token: 'tok_abc', expires_in: 3600 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('/v3/vault/setup-tokens')) {
        return new Response(
          JSON.stringify({ id: 'SETUP-TOK-1', status: 'CREATED' }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.includes('/v3/vault/payment-tokens')) {
        const body = JSON.parse(init?.body as string);
        expect(body.payment_source.token.id).toBe('SETUP-TOK-1');
        return new Response(
          JSON.stringify({ id: 'VAULT-PAYMENT-TOK-1', status: 'VAULTED' }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('Not Found', { status: 404 });
    });

    const client = new PayPalClient({
      clientId: 'id',
      clientSecret: 'sec',
      environment: 'sandbox',
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const setupRes = await client.createVaultSetupToken({});
    expect(setupRes.id).toBe('SETUP-TOK-1');

    const paymentRes = await client.createVaultPaymentToken(setupRes.id);
    expect(paymentRes.id).toBe('VAULT-PAYMENT-TOK-1');
  });
});

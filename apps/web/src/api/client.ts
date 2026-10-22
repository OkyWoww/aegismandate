/**
 * MandatePay Control Plane API Client (apps/api integration)
 */

export interface MandateResponse {
  mandate: {
    mandate_id: string;
    version: number;
    owner_id: string;
    agent_id: string;
    status: 'ACTIVE' | 'DRAFT' | 'EXPIRED' | 'REVOKED' | 'SUSPENDED';
    currency: string;
    valid_from: string;
    valid_until: string;
    total_budget_minor: number;
    per_txn_limit_minor: number;
    auto_approve_limit_minor: number;
    max_txns_per_hour: number;
    allowed_merchants: string[];
    allowed_categories: string[];
    max_items_per_intent: number;
    max_pending_approvals: number;
    signature: string;
  };
  spend: {
    mandate_id: string;
    captured_minor: number;
    reserved_minor: number;
    committed_minor: number;
    remaining_minor: number;
    total_budget_minor: number;
    currency: string;
    updated_at: string;
  };
}

export interface IntentDecision {
  decision_id: string;
  verdict: 'ALLOW' | 'STEP_UP' | 'DENY';
  reason_codes: string[];
  risk?: { score: number; signals?: string[] } | undefined;
  policy_trace?: Array<{ rule: string; result: string; detail?: string }> | undefined;
}

export interface ProposeResponse {
  verdict: 'ALLOW' | 'STEP_UP' | 'DENY';
  intent_id: string;
  status: string;
  order_id?: string | undefined;
  capture_id?: string | undefined;
  decision?: IntentDecision | undefined;
  refusal_reason?: string | undefined;
  links?: Array<{ rel: string; href: string; method: string }> | undefined;
}

export interface ApproveResponse {
  status: string;
  intent_id: string;
  order_id?: string | undefined;
  capture_id?: string | undefined;
  /** PayPal sandbox buyer approval URL (present when status is AWAITING_PAYER_APPROVAL) */
  approve_url?: string | undefined;
  /** Human-readable error message returned by the server on 4xx responses */
  message?: string | undefined;
  error?: string | undefined;
  refusal_reason?: string | undefined;
  /** HTTP status code of the response (added client-side) */
  http_status?: number | undefined;
}

/** One STEP_UP intent as returned by GET /v1/approvals (server truth, catalog-verified). */
export interface ApprovalView {
  intent_id: string;
  mandate_id: string;
  merchant_ref: string;
  status: string;
  items: Array<{ sku: string; name: string; qty: number; unit_price_minor: number }>;
  amount_minor: number;
  currency: string;
  payload_hash: string | null;
  expires_at: string | null;
  rationale: string;
  reason_codes: string[];
  risk_score: number | null;
  order_id: string | null;
  approve_url: string | null;
  created_at: string;
  updated_at: string;
}

export interface ApprovalsResponse {
  /** Awaiting the OWNER's decision. */
  approvals: ApprovalView[];
  /** Owner already approved; the BUYER must approve on PayPal Sandbox (has approve_url). */
  awaiting_payer: ApprovalView[];
  total: number;
}

/** Error carrying the HTTP status so callers can distinguish 401 / 403. */
export class ApiHttpError extends Error {
  public readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiHttpError';
    this.status = status;
  }
}

/** Parse a JSON body defensively (proxy/HTML error pages must not crash the UI). */
async function readJsonBody<T>(res: Response): Promise<T> {
  try {
    return (await res.json()) as T;
  } catch {
    return {} as T;
  }
}

export interface AuditEventItem {
  seq: number;
  ts: string;
  actor: string;
  type: string;
  ref: string;
  payload: Record<string, unknown>;
  prev_hash: string;
  hash: string;
}

export interface AuditEventsResponse {
  events: AuditEventItem[];
  total: number;
  limit: number;
  offset: number;
}

export interface AuditVerifyResponse {
  valid: boolean;
  count: number;
  broken_at_seq: number | null;
  reason: string | null;
}

const getBaseUrl = (): string => {
  try {
    const metaEnv = (import.meta as unknown as { env?: { VITE_API_URL?: string } }).env;
    return metaEnv?.VITE_API_URL || '';
  } catch {
    return 'http://localhost:8787';
  }
};

const API_BASE_URL = getBaseUrl();

/** Response shape of GET /v1/intents/:id (apps/api/src/server.ts). */
export interface IntentDetail {
  intent_id: string;
  mandate_id?: string;
  verdict: string;
  status: string;
  payload_hash: string | null;
  order_id: string | null;
  capture_id: string | null;
  refusal_reason: string | null;
  approve_url: string | null;
  expires_at: string | null;
  decision?: {
    reason_codes?: string[];
    risk?: { score: number; signals?: string[] };
    verified_total_minor?: number | null;
  };
}

export class ApiClient {
  private readonly baseUrl: string;

  constructor(baseUrl = API_BASE_URL) {
    this.baseUrl = baseUrl;
  }

  public async getHealth(): Promise<{ status: string; timestamp: string }> {
    const res = await fetch(`${this.baseUrl}/health`);
    if (!res.ok) throw new Error(`Health check failed (${res.status})`);
    return res.json() as Promise<{ status: string; timestamp: string }>;
  }

  public async getMandate(id: string): Promise<MandateResponse> {
    const res = await fetch(`${this.baseUrl}/v1/mandates/${id}`);
    if (!res.ok) throw new Error(`Failed to fetch mandate ${id} (${res.status})`);
    return res.json() as Promise<MandateResponse>;
  }

  public async proposeIntent(proposal: Record<string, unknown>): Promise<ProposeResponse> {
    const res = await fetch(`${this.baseUrl}/v1/intents/propose`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(proposal),
    });
    return res.json() as Promise<ProposeResponse>;
  }

  public async getIntent(id: string): Promise<IntentDetail> {
    const res = await fetch(`${this.baseUrl}/v1/intents/${id}`);
    if (!res.ok) throw new Error(`Failed to fetch intent ${id} (${res.status})`);
    return res.json() as Promise<IntentDetail>;
  }

  public async approveIntent(
    id: string,
    expectedPayloadHash: string,
    ownerToken: string,
  ): Promise<ApproveResponse> {
    const res = await fetch(`${this.baseUrl}/v1/intents/${encodeURIComponent(id)}/approve`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${ownerToken}`,
      },
      // expected_payload_hash is forwarded verbatim from the server-provided approval (FR-28).
      body: JSON.stringify({ expected_payload_hash: expectedPayloadHash }),
    });
    // Return parsed body regardless of HTTP status so callers can inspect error fields.
    const body = await readJsonBody<ApproveResponse>(res);
    return { ...body, http_status: res.status };
  }

  public async rejectIntent(id: string, ownerToken: string): Promise<{ ok: boolean; status: number; message?: string }> {
    const res = await fetch(`${this.baseUrl}/v1/intents/${encodeURIComponent(id)}/reject`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${ownerToken}`,
      },
      body: '{}',
    });
    const body = await readJsonBody<{ message?: string }>(res);
    return { ok: res.ok, status: res.status, ...(body.message !== undefined && { message: body.message }) };
  }

  /** Single source of truth for the owner queue (owner-authenticated). */
  public async getApprovals(ownerToken: string): Promise<ApprovalsResponse> {
    const res = await fetch(`${this.baseUrl}/v1/approvals`, {
      headers: { 'Authorization': `Bearer ${ownerToken}` },
    });
    if (!res.ok) {
      const body = await readJsonBody<{ message?: string }>(res);
      throw new ApiHttpError(res.status, body.message ?? `Failed to fetch approvals (${res.status})`);
    }
    return readJsonBody<ApprovalsResponse>(res);
  }

  public async getAuditEvents(params: { limit?: number; offset?: number; actor?: string; type?: string } = {}): Promise<AuditEventsResponse> {
    const searchParams = new URLSearchParams();
    if (params.limit) searchParams.set('limit', String(params.limit));
    if (params.offset) searchParams.set('offset', String(params.offset));
    if (params.actor) searchParams.set('actor', params.actor);
    if (params.type) searchParams.set('type', params.type);

    const query = searchParams.toString() ? `?${searchParams.toString()}` : '';
    const res = await fetch(`${this.baseUrl}/v1/audit/events${query}`);
    if (!res.ok) throw new Error(`Failed to fetch audit events (${res.status})`);
    return res.json() as Promise<AuditEventsResponse>;
  }

  public async verifyAudit(): Promise<AuditVerifyResponse> {
    const res = await fetch(`${this.baseUrl}/v1/audit/verify`);
    if (!res.ok) throw new Error(`Failed to verify audit ledger (${res.status})`);
    return res.json() as Promise<AuditVerifyResponse>;
  }
}

export const api = new ApiClient();

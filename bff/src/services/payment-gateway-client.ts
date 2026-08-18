import { randomUUID } from "node:crypto";

/** Payload accepted from client apps (mobile/web) hitting the BFF. */
export interface ClientPaymentRequest {
  payer_account: string;
  payee_account: string;
  amount_cents: number;
  idempotency_key?: string;
}

/** Payload actually sent to payment-gateway's POST /payments. */
export interface GatewayPaymentRequest {
  idempotency_key: string;
  payer_account: string;
  payee_account: string;
  amount_cents: number;
}

export interface GatewayResult {
  /** HTTP status returned by payment-gateway (or a synthesized one on infra failure). */
  status: number;
  body: unknown;
}

/**
 * Builds the request payment-gateway expects from a client-supplied payload,
 * generating a fresh idempotency key when the client didn't supply one so
 * that retries from a flaky mobile network can safely reuse it.
 */
export function buildGatewayRequest(
  clientRequest: ClientPaymentRequest,
  generateId: () => string = randomUUID,
): GatewayPaymentRequest {
  return {
    idempotency_key: clientRequest.idempotency_key ?? generateId(),
    payer_account: clientRequest.payer_account,
    payee_account: clientRequest.payee_account,
    amount_cents: clientRequest.amount_cents,
  };
}

export interface PaymentGatewayClientOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
}

export class PaymentGatewayClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: PaymentGatewayClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * Forwards a payment request to payment-gateway synchronously and relays
   * its status/body back. Infra failures (network error, non-JSON response)
   * are translated into a 502 rather than throwing, so callers always get a
   * status/body pair to relay to the client.
   */
  async submitPayment(request: GatewayPaymentRequest): Promise<GatewayResult> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/payments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      });
    } catch (err) {
      return {
        status: 502,
        body: {
          error: "payment_gateway_unreachable",
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }

    const body = await response.json().catch(() => null);
    return { status: response.status, body };
  }

  async healthz(): Promise<{ reachable: boolean; status?: number }> {
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/healthz`);
      return { reachable: response.ok, status: response.status };
    } catch {
      return { reachable: false };
    }
  }
}

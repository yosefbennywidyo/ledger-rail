import { describe, expect, it, vi } from "vitest";
import {
  buildGatewayRequest,
  PaymentGatewayClient,
} from "./payment-gateway-client.js";

describe("buildGatewayRequest", () => {
  it("generates an idempotency key when the client does not supply one", () => {
    const generateId = () => "generated-id-123";
    const gatewayRequest = buildGatewayRequest(
      {
        payer_account: "acc-1",
        payee_account: "acc-2",
        amount_cents: 500,
      },
      generateId,
    );

    expect(gatewayRequest).toEqual({
      idempotency_key: "generated-id-123",
      payer_account: "acc-1",
      payee_account: "acc-2",
      amount_cents: 500,
    });
  });

  it("reuses the client-supplied idempotency key instead of generating one", () => {
    const generateId = vi.fn(() => "should-not-be-used");
    const gatewayRequest = buildGatewayRequest(
      {
        payer_account: "acc-1",
        payee_account: "acc-2",
        amount_cents: 500,
        idempotency_key: "client-key-abc",
      },
      generateId,
    );

    expect(gatewayRequest.idempotency_key).toBe("client-key-abc");
    expect(generateId).not.toHaveBeenCalled();
  });

  it("falls back to crypto.randomUUID when no generator is supplied", () => {
    const gatewayRequest = buildGatewayRequest({
      payer_account: "acc-1",
      payee_account: "acc-2",
      amount_cents: 100,
    });

    expect(gatewayRequest.idempotency_key).toMatch(
      /^[0-9a-f-]{36}$/,
    );
  });
});

describe("PaymentGatewayClient.submitPayment", () => {
  it("forwards the request to POST {baseUrl}/payments and relays status/body", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(url).toBe("http://localhost:8081/payments");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(init?.body as string)).toEqual({
        idempotency_key: "key-1",
        payer_account: "acc-1",
        payee_account: "acc-2",
        amount_cents: 1000,
      });
      return new Response(JSON.stringify({ status: "settled" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    });

    const client = new PaymentGatewayClient({
      baseUrl: "http://localhost:8081",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await client.submitPayment({
      idempotency_key: "key-1",
      payer_account: "acc-1",
      payee_account: "acc-2",
      amount_cents: 1000,
    });

    expect(result).toEqual({ status: 201, body: { status: "settled" } });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("translates a network failure into a 502 instead of throwing", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("connection refused");
    });

    const client = new PaymentGatewayClient({
      baseUrl: "http://localhost:8081",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await client.submitPayment({
      idempotency_key: "key-1",
      payer_account: "acc-1",
      payee_account: "acc-2",
      amount_cents: 1000,
    });

    expect(result.status).toBe(502);
    expect(result.body).toMatchObject({ error: "payment_gateway_unreachable" });
  });

  it("relays a 422 business rejection from payment-gateway unchanged", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "insufficient_balance" }), {
          status: 422,
          headers: { "content-type": "application/json" },
        }),
    );

    const client = new PaymentGatewayClient({
      baseUrl: "http://localhost:8081",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await client.submitPayment({
      idempotency_key: "key-1",
      payer_account: "acc-1",
      payee_account: "acc-2",
      amount_cents: 1000,
    });

    expect(result).toEqual({ status: 422, body: { error: "insufficient_balance" } });
  });
});

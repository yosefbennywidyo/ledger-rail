import type { FastifyInstance } from "fastify";
import {
  buildGatewayRequest,
  type ClientPaymentRequest,
  type PaymentGatewayClient,
} from "../services/payment-gateway-client.js";

const paymentRequestSchema = {
  type: "object",
  required: ["payer_account", "payee_account", "amount_cents"],
  properties: {
    payer_account: { type: "string", minLength: 1 },
    payee_account: { type: "string", minLength: 1 },
    amount_cents: { type: "integer", minimum: 1 },
    idempotency_key: { type: "string", minLength: 1 },
  },
  additionalProperties: false,
} as const;

export function registerPaymentsRoute(
  app: FastifyInstance,
  gatewayClient: PaymentGatewayClient,
): void {
  app.post<{ Body: ClientPaymentRequest }>(
    "/api/payments",
    { schema: { body: paymentRequestSchema } },
    async (request, reply) => {
      const gatewayRequest = buildGatewayRequest(request.body);
      const result = await gatewayClient.submitPayment(gatewayRequest);

      reply.code(result.status);
      return {
        idempotency_key: gatewayRequest.idempotency_key,
        payment_gateway_status: result.status,
        result: result.body,
      };
    },
  );
}

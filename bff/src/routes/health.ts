import type { FastifyInstance } from "fastify";
import type { PaymentGatewayClient } from "../services/payment-gateway-client.js";

export function registerHealthRoute(
  app: FastifyInstance,
  gatewayClient: PaymentGatewayClient,
): void {
  app.get("/healthz", async (_request, reply) => {
    const gateway = await gatewayClient.healthz();
    const healthy = gateway.reachable;

    reply.code(healthy ? 200 : 503);
    return {
      bff: "ok",
      payment_gateway: healthy ? "ok" : "unreachable",
      payment_gateway_status: gateway.status ?? null,
    };
  });
}

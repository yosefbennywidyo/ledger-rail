import Fastify, { type FastifyInstance } from "fastify";
import { registerPaymentsRoute } from "./routes/payments.js";
import { registerHealthRoute } from "./routes/health.js";
import { PaymentGatewayClient } from "./services/payment-gateway-client.js";

export interface BuildAppOptions {
  paymentGatewayUrl: string;
  fetchImpl?: typeof fetch;
}

export function buildApp(options: BuildAppOptions): FastifyInstance {
  const app = Fastify({ logger: true });

  const gatewayClient = new PaymentGatewayClient({
    baseUrl: options.paymentGatewayUrl,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });

  registerPaymentsRoute(app, gatewayClient);
  registerHealthRoute(app, gatewayClient);

  return app;
}

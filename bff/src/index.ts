import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const app = buildApp({ paymentGatewayUrl: config.paymentGatewayUrl });

app
  .listen({ port: config.port, host: "0.0.0.0" })
  .then(() => {
    app.log.info(
      `bff listening on :${config.port}, forwarding to ${config.paymentGatewayUrl}`,
    );
  })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });

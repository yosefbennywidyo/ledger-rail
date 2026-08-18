package rail.ledger.paymentgateway.dto;

import java.io.Serializable;

/**
 * Outcome of processing a payment, cached in Redis under the idempotency key so a
 * retried request with the same key can be answered without calling ledger-service again.
 *
 * @param httpStatus the HTTP status this payment-gateway responded with (e.g. 201, 422, 502)
 * @param body       the response body to replay verbatim (either a success payload or an error message)
 */
public record PaymentResult(int httpStatus, String body) implements Serializable {
}

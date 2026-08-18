package rail.ledger.paymentgateway.client;

/**
 * Business rejection reported by ledger-service (e.g. HTTP 422 "insufficient balance").
 * Distinct from connectivity failures ({@link LedgerServiceUnavailableException}) so callers
 * can propagate the right HTTP status: 422 for business errors, 502 for infra failures.
 */
public class LedgerServiceException extends RuntimeException {

    public LedgerServiceException(String message) {
        super(message);
    }
}

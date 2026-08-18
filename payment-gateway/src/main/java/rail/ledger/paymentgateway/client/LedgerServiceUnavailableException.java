package rail.ledger.paymentgateway.client;

/** ledger-service could not be reached at all (connection refused, timeout, DNS, malformed response). */
public class LedgerServiceUnavailableException extends RuntimeException {

    public LedgerServiceUnavailableException(String message, Throwable cause) {
        super(message, cause);
    }
}

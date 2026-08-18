package rail.ledger.paymentgateway.dto;

import java.util.List;

/** Request body sent to ledger-service's {@code POST /transactions}. */
public record LedgerTransactionRequest(String idempotencyKey, List<LedgerEntry> entries) {
}

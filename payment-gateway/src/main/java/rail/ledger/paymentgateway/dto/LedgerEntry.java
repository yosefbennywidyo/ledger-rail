package rail.ledger.paymentgateway.dto;

/** One leg of a double-entry transaction sent to ledger-service. Negative = debit, positive = credit. */
public record LedgerEntry(String accountId, long amountCents) {
}

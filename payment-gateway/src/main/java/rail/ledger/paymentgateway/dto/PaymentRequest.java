package rail.ledger.paymentgateway.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Positive;

/** Request body for {@code POST /payments}. */
public record PaymentRequest(
        @NotBlank String idempotencyKey,
        @NotBlank String payerAccount,
        @NotBlank String payeeAccount,
        @Positive long amountCents) {
}

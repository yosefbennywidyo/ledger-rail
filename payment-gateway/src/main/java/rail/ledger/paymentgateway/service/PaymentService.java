package rail.ledger.paymentgateway.service;

import java.util.List;
import java.util.Optional;

import org.springframework.stereotype.Service;

import rail.ledger.paymentgateway.client.LedgerServiceClient;
import rail.ledger.paymentgateway.client.LedgerServiceException;
import rail.ledger.paymentgateway.client.LedgerServiceUnavailableException;
import rail.ledger.paymentgateway.dto.LedgerEntry;
import rail.ledger.paymentgateway.dto.LedgerTransactionRequest;
import rail.ledger.paymentgateway.dto.PaymentRequest;
import rail.ledger.paymentgateway.dto.PaymentResult;
import rail.ledger.paymentgateway.idempotency.IdempotencyStore;

/**
 * Orchestrates a payment: idempotency check -&gt; balanced double-entry to ledger-service -&gt;
 * cache the outcome.
 */
@Service
public class PaymentService {

    private final IdempotencyStore idempotencyStore;
    private final LedgerServiceClient ledgerServiceClient;

    public PaymentService(IdempotencyStore idempotencyStore, LedgerServiceClient ledgerServiceClient) {
        this.idempotencyStore = idempotencyStore;
        this.ledgerServiceClient = ledgerServiceClient;
    }

    /**
     * Processes a payment request, or replays the cached result if this idempotency key was
     * already handled.
     */
    public PaymentResult process(PaymentRequest request) {
        Optional<PaymentResult> cached = idempotencyStore.find(request.idempotencyKey());
        if (cached.isPresent()) {
            return cached.get();
        }

        PaymentResult result = callLedgerService(request);
        if (result.httpStatus() != 502) {
            // Only cache a definitive outcome from ledger-service (success or business
            // rejection). A 502 means we don't actually know whether ledger-service processed
            // the request, so caching it would block legitimate retries once it's back up.
            idempotencyStore.save(request.idempotencyKey(), result);
        }
        return result;
    }

    private PaymentResult callLedgerService(PaymentRequest request) {
        LedgerTransactionRequest transaction = toLedgerTransaction(request);
        try {
            ledgerServiceClient.postTransaction(transaction);
            return new PaymentResult(201, "{\"status\":\"completed\"}");
        } catch (LedgerServiceException businessRejection) {
            return new PaymentResult(422, businessRejection.getMessage());
        } catch (LedgerServiceUnavailableException unavailable) {
            return new PaymentResult(502, "ledger-service unavailable: " + unavailable.getMessage());
        }
    }

    /** Builds the balanced double-entry pair: debit payer, credit payee, same idempotency key. */
    static LedgerTransactionRequest toLedgerTransaction(PaymentRequest request) {
        LedgerEntry debit = new LedgerEntry(request.payerAccount(), -request.amountCents());
        LedgerEntry credit = new LedgerEntry(request.payeeAccount(), request.amountCents());
        return new LedgerTransactionRequest(request.idempotencyKey(), List.of(debit, credit));
    }
}

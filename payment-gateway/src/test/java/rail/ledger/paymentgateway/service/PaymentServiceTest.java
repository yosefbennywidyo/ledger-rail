package rail.ledger.paymentgateway.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.util.Optional;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import rail.ledger.paymentgateway.client.LedgerServiceClient;
import rail.ledger.paymentgateway.client.LedgerServiceException;
import rail.ledger.paymentgateway.client.LedgerServiceUnavailableException;
import rail.ledger.paymentgateway.dto.LedgerEntry;
import rail.ledger.paymentgateway.dto.LedgerTransactionRequest;
import rail.ledger.paymentgateway.dto.PaymentRequest;
import rail.ledger.paymentgateway.dto.PaymentResult;
import rail.ledger.paymentgateway.idempotency.IdempotencyStore;

@ExtendWith(MockitoExtension.class)
class PaymentServiceTest {

    @Mock
    private IdempotencyStore idempotencyStore;

    @Mock
    private LedgerServiceClient ledgerServiceClient;

    private final PaymentRequest request =
            new PaymentRequest("idem-key-1", "acct-payer", "acct-payee", 1_500L);

    @Test
    void returnsCachedResultWithoutCallingLedgerServiceWhenIdempotencyKeySeenBefore() {
        PaymentResult cached = new PaymentResult(201, "{\"status\":\"completed\"}");
        when(idempotencyStore.find("idem-key-1")).thenReturn(Optional.of(cached));

        PaymentService service = new PaymentService(idempotencyStore, ledgerServiceClient);
        PaymentResult result = service.process(request);

        assertThat(result).isEqualTo(cached);
        verify(ledgerServiceClient, never()).postTransaction(any());
        verify(idempotencyStore, never()).save(any(), any());
    }

    @Test
    void callsLedgerServiceAndCachesResultWhenIdempotencyKeyNotSeenBefore() {
        when(idempotencyStore.find("idem-key-1")).thenReturn(Optional.empty());

        PaymentService service = new PaymentService(idempotencyStore, ledgerServiceClient);
        PaymentResult result = service.process(request);

        assertThat(result.httpStatus()).isEqualTo(201);
        verify(ledgerServiceClient, times(1)).postTransaction(any());
        verify(idempotencyStore, times(1)).save("idem-key-1", result);
    }

    @Test
    void propagatesBusinessRejectionAs422AndStillCachesIt() {
        when(idempotencyStore.find("idem-key-1")).thenReturn(Optional.empty());
        doThrow(new LedgerServiceException("insufficient balance"))
                .when(ledgerServiceClient).postTransaction(any());

        PaymentService service = new PaymentService(idempotencyStore, ledgerServiceClient);
        PaymentResult result = service.process(request);

        assertThat(result.httpStatus()).isEqualTo(422);
        assertThat(result.body()).isEqualTo("insufficient balance");
        verify(idempotencyStore, times(1)).save("idem-key-1", result);
    }

    @Test
    void propagatesConnectivityFailureAs502AndDoesNotCacheIt() {
        when(idempotencyStore.find("idem-key-1")).thenReturn(Optional.empty());
        doThrow(new LedgerServiceUnavailableException("connection refused", new RuntimeException()))
                .when(ledgerServiceClient).postTransaction(any());

        PaymentService service = new PaymentService(idempotencyStore, ledgerServiceClient);
        PaymentResult result = service.process(request);

        assertThat(result.httpStatus()).isEqualTo(502);
        verify(idempotencyStore, never()).save(any(), any());
    }

    @Test
    void buildsBalancedDebitCreditEntriesFromPaymentRequest() {
        LedgerTransactionRequest transaction = PaymentService.toLedgerTransaction(request);

        assertThat(transaction.idempotencyKey()).isEqualTo("idem-key-1");
        assertThat(transaction.entries()).containsExactly(
                new LedgerEntry("acct-payer", -1_500L),
                new LedgerEntry("acct-payee", 1_500L));
        long sum = transaction.entries().stream().mapToLong(LedgerEntry::amountCents).sum();
        assertThat(sum).isZero();
    }
}

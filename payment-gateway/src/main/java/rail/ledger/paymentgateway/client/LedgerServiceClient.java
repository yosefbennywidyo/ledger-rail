package rail.ledger.paymentgateway.client;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatusCode;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.client.HttpStatusCodeException;
import org.springframework.web.client.ResourceAccessException;
import org.springframework.web.client.RestClient;

import rail.ledger.paymentgateway.dto.LedgerTransactionRequest;

/**
 * Thin HTTP adapter over ledger-service's {@code POST /transactions}.
 *
 * <p>Maps ledger-service's response semantics onto exceptions so callers (PaymentService) don't
 * need to know about HTTP status codes:
 * <ul>
 *   <li>201 -&gt; returns normally</li>
 *   <li>422 -&gt; {@link LedgerServiceException} (business rejection, e.g. insufficient balance)</li>
 *   <li>anything else (400, 5xx, timeout, connection refused) -&gt; {@link LedgerServiceUnavailableException}</li>
 * </ul>
 */
@Component
public class LedgerServiceClient {

    private final RestClient restClient;

    public LedgerServiceClient(
            RestClient.Builder restClientBuilder,
            @Value("${ledger-service.base-url}") String baseUrl,
            @Value("${ledger-service.connect-timeout-ms}") long connectTimeoutMs,
            @Value("${ledger-service.read-timeout-ms}") long readTimeoutMs) {
        // Use the Spring Boot-autoconfigured RestClient.Builder (injected), not a raw
        // RestClient.builder() — the autoconfigured builder carries Boot's customized
        // Jackson ObjectMapper (see spring.jackson.property-naming-strategy=SNAKE_CASE in
        // application.properties), which is required so requests to ledger-service serialize
        // as idempotency_key/account_id/amount_cents rather than camelCase.
        SimpleClientHttpRequestFactory requestFactory = new SimpleClientHttpRequestFactory();
        requestFactory.setConnectTimeout((int) connectTimeoutMs);
        requestFactory.setReadTimeout((int) readTimeoutMs);
        this.restClient = restClientBuilder
                .baseUrl(baseUrl)
                .requestFactory(requestFactory)
                .build();
    }

    /**
     * Posts a balanced double-entry transaction to ledger-service.
     *
     * @throws LedgerServiceException            on business rejection (HTTP 422)
     * @throws LedgerServiceUnavailableException on any other failure (unreachable, timeout, 4xx/5xx)
     */
    public void postTransaction(LedgerTransactionRequest request) {
        try {
            restClient.post()
                    .uri("/transactions")
                    .body(request)
                    .retrieve()
                    .toBodilessEntity();
        } catch (HttpStatusCodeException e) {
            if (e.getStatusCode() == HttpStatusCode.valueOf(422)) {
                throw new LedgerServiceException(e.getResponseBodyAsString());
            }
            throw new LedgerServiceUnavailableException(
                    "ledger-service returned unexpected status " + e.getStatusCode(), e);
        } catch (ResourceAccessException e) {
            throw new LedgerServiceUnavailableException("could not reach ledger-service", e);
        }
    }
}

package rail.ledger.paymentgateway.idempotency;

import java.time.Duration;
import java.util.Optional;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Component;

import com.fasterxml.jackson.databind.ObjectMapper;

import rail.ledger.paymentgateway.dto.PaymentResult;

/**
 * Redis-backed cache of payment outcomes keyed by idempotency key.
 *
 * <p>Checked before calling ledger-service (see PaymentService): if a key was already
 * processed, the cached {@link PaymentResult} is replayed and ledger-service is never
 * called again for that key.
 */
@Component
public class IdempotencyStore {

    private static final String KEY_PREFIX = "payment-gateway:idempotency:";

    private final StringRedisTemplate redisTemplate;
    private final ObjectMapper objectMapper;
    private final Duration ttl;

    public IdempotencyStore(
            StringRedisTemplate redisTemplate,
            ObjectMapper objectMapper,
            @Value("${payment-gateway.idempotency.ttl-hours}") long ttlHours) {
        this.redisTemplate = redisTemplate;
        this.objectMapper = objectMapper;
        this.ttl = Duration.ofHours(ttlHours);
    }

    public Optional<PaymentResult> find(String idempotencyKey) {
        String raw = redisTemplate.opsForValue().get(redisKey(idempotencyKey));
        if (raw == null) {
            return Optional.empty();
        }
        try {
            return Optional.of(objectMapper.readValue(raw, PaymentResult.class));
        } catch (Exception e) {
            // Corrupt/unreadable cache entry: treat as a miss so the request is reprocessed
            // rather than failing outright.
            return Optional.empty();
        }
    }

    public void save(String idempotencyKey, PaymentResult result) {
        try {
            String raw = objectMapper.writeValueAsString(result);
            redisTemplate.opsForValue().set(redisKey(idempotencyKey), raw, ttl);
        } catch (Exception e) {
            throw new IllegalStateException("failed to serialize payment result for idempotency cache", e);
        }
    }

    private static String redisKey(String idempotencyKey) {
        return KEY_PREFIX + idempotencyKey;
    }
}

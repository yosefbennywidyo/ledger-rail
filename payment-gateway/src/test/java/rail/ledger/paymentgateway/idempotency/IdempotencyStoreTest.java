package rail.ledger.paymentgateway.idempotency;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.time.Duration;
import java.util.Optional;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.ValueOperations;

import com.fasterxml.jackson.databind.ObjectMapper;

import rail.ledger.paymentgateway.dto.PaymentResult;

@ExtendWith(MockitoExtension.class)
class IdempotencyStoreTest {

    @Mock
    private StringRedisTemplate redisTemplate;

    @Mock
    private ValueOperations<String, String> valueOperations;

    private IdempotencyStore idempotencyStore;

    @BeforeEach
    void setUp() {
        when(redisTemplate.opsForValue()).thenReturn(valueOperations);
        idempotencyStore = new IdempotencyStore(redisTemplate, new ObjectMapper(), 24);
    }

    @Test
    void findReturnsEmptyWhenKeyNotPresentInRedis() {
        when(valueOperations.get("payment-gateway:idempotency:unknown-key")).thenReturn(null);

        Optional<PaymentResult> result = idempotencyStore.find("unknown-key");

        assertThat(result).isEmpty();
    }

    @Test
    void findDeserializesCachedResultWhenKeyPresent() {
        when(valueOperations.get("payment-gateway:idempotency:seen-key"))
                .thenReturn("{\"httpStatus\":201,\"body\":\"{\\\"status\\\":\\\"completed\\\"}\"}");

        Optional<PaymentResult> result = idempotencyStore.find("seen-key");

        assertThat(result).contains(new PaymentResult(201, "{\"status\":\"completed\"}"));
    }

    @Test
    void findReturnsEmptyWhenCachedValueIsCorrupt() {
        when(valueOperations.get("payment-gateway:idempotency:corrupt-key")).thenReturn("not-json");

        Optional<PaymentResult> result = idempotencyStore.find("corrupt-key");

        assertThat(result).isEmpty();
    }

    @Test
    void saveWritesSerializedResultWithTtl() {
        PaymentResult toSave = new PaymentResult(422, "insufficient balance");

        idempotencyStore.save("new-key", toSave);

        verify(valueOperations).set(
                eq("payment-gateway:idempotency:new-key"),
                any(String.class),
                eq(Duration.ofHours(24)));
    }
}

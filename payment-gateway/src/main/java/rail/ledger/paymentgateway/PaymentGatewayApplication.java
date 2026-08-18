package rail.ledger.paymentgateway;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

/**
 * Entry point. No business logic here — only Spring Boot wiring, mirroring the
 * cmd/ convention in the sibling ledger-service (Go): main() is wiring only.
 */
@SpringBootApplication
public class PaymentGatewayApplication {

    public static void main(String[] args) {
        SpringApplication.run(PaymentGatewayApplication.class, args);
    }
}

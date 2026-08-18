package rail.ledger.paymentgateway.web;

import jakarta.validation.Valid;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

import rail.ledger.paymentgateway.dto.PaymentRequest;
import rail.ledger.paymentgateway.dto.PaymentResult;
import rail.ledger.paymentgateway.service.PaymentService;

@RestController
public class PaymentController {

    private final PaymentService paymentService;

    public PaymentController(PaymentService paymentService) {
        this.paymentService = paymentService;
    }

    @PostMapping(path = "/payments")
    public ResponseEntity<String> createPayment(@Valid @RequestBody PaymentRequest request) {
        PaymentResult result = paymentService.process(request);
        return ResponseEntity.status(result.httpStatus()).body(result.body());
    }
}

package com.example.api.controller;

import com.example.api.service.ApplyService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class CouponController {

    private final ApplyService applyService;
    private final Logger logger = LoggerFactory.getLogger(CouponController.class);

    public CouponController(ApplyService applyService) {
        this.applyService = applyService;
    }

    @PostMapping("/coupon/apply")
    public ResponseEntity<Void> apply(@RequestParam Long userId) {
        logger.info("Received request to /coupon/apply (userId: {})", userId);

        applyService.apply(userId);
        return ResponseEntity.ok().build();
    }
}

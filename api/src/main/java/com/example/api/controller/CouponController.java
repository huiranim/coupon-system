package com.example.api.controller;

import com.example.api.service.ApplyService;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class CouponController {

    private final ApplyService applyService;

    public CouponController(ApplyService applyService) {
        this.applyService = applyService;
    }

    @PostMapping("/coupon/apply")
    public ResponseEntity<Void> apply(@RequestParam Long userId) {
        applyService.apply(userId);
        return ResponseEntity.ok().build();
    }
}

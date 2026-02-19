package com.example.api.exception;

public class CouponExhaustedException extends RuntimeException {
    public CouponExhaustedException() {
        super("쿠폰이 모두 소진되었습니다.");
    }
}

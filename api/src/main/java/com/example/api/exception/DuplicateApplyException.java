package com.example.api.exception;

public class DuplicateApplyException extends RuntimeException {
    public DuplicateApplyException() {
        super("이미 쿠폰을 신청한 사용자입니다.");
    }
}

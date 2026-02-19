package com.example.api.service;

import com.example.api.domain.Coupon;
import com.example.api.exception.CouponExhaustedException;
import com.example.api.exception.DuplicateApplyException;
import com.example.api.producer.CouponCreateProducer;
import com.example.api.repository.AppliedUserRepository;
import com.example.api.repository.CouponCountRepository;
import com.example.api.repository.CouponRepository;
import org.springframework.stereotype.Service;

@Service
public class ApplyService {

    private final CouponRepository couponRepository;
    private final CouponCountRepository couponCountRepository;
    private final CouponCreateProducer couponCreateProducer;
    private final AppliedUserRepository appliedUserRepository;

    public ApplyService(CouponRepository couponRepository, CouponCountRepository couponCountRepository, CouponCreateProducer couponCreateProducer, AppliedUserRepository appliedUserRepository) {
        this.couponRepository = couponRepository;
        this.couponCountRepository = couponCountRepository;
        this.couponCreateProducer = couponCreateProducer;
        this.appliedUserRepository = appliedUserRepository;
    }

    public void apply(Long userId) {
        // 쿠폰 발행 가능 여부 Redis Set으로 조회 (신규면 1, 중복이면 0 반환)
        Long apply = appliedUserRepository.add(userId);

        if (apply != 1) {
            throw new DuplicateApplyException();
        }

        // 쿠폰 발행 수 DB로 조회
//        long count = couponRepository.count();  // SELECT COUNT(*) FROM coupon
        // 쿠폰 발행 수 Redis Incr로 조회
        Long count = couponCountRepository.increment();

        if (count > 100) {
            throw new CouponExhaustedException();
        }

        // 쿠폰 발행 결과 DB 저장
//        couponRepository.save(new Coupon(userId));  // INSERT INTO coupon (user_id) VALUES (?)

        // 쿠폰 발행 결과 Kafka 저장
        couponCreateProducer.create(userId);
    }
}

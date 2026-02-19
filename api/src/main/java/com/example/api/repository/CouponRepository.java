package com.example.api.repository;

import com.example.api.domain.Coupon;
import org.springframework.data.jpa.repository.JpaRepository;

// JpaRepository를 상속하면 별도 SQL 없이 save(), count(), findAll() 등 기본 CRUD가 자동 제공됩니다.
// 마치 스프링이 구현체를 프록시로 만들어주는 것과 같습니다.
public interface CouponRepository extends JpaRepository<Coupon, Long> {
}

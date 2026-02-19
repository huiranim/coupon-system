package com.example.api.domain;

import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;

// JPA에서 @Entity를 붙이면 스프링이 자동으로 coupon 테이블을 생성하고, 이 클래스의 인스턴스가 곧 테이블의 한 row가 됩니다.
@Entity
public class Coupon {

    @Id @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    private Long userId;

    public Coupon() {

    }

    public Coupon(Long userId) {
        this.userId = userId;
    }

    public Long getId() {
        return id;
    }
}

package com.example.api.config;

import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.data.redis.core.RedisTemplate;
import org.springframework.stereotype.Component;

@Component
public class CouponEventInitializer implements ApplicationRunner {

    private final RedisTemplate<String, String> redisTemplate;

    public CouponEventInitializer(RedisTemplate<String, String> redisTemplate) {
        this.redisTemplate = redisTemplate;
    }

    @Override
    public void run(ApplicationArguments args) {
        redisTemplate.delete("coupon_count");
        redisTemplate.delete("applied_user");
    }
}

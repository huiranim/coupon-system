package com.example.api.service;

import com.example.api.repository.CouponRepository;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import static org.assertj.core.api.AssertionsForClassTypes.assertThat;

@SpringBootTest
class ApplyServiceTest {
    @Autowired
    private ApplyService applyService;

    @Autowired
    private CouponRepository couponRepository;

    @Test
    public void 한번만응모() {
        applyService.apply(1L);

        long count = couponRepository.count();

        assertThat(count).isEqualTo(1);
    }

    @Test
    public void 여러명응모() throws InterruptedException {
        int threadCount = 1000;

        // 스레드를 직접 생성/관리하는 번거로움을 없애주는 스레드 풀 관리 API
        // 스레드 32개를 미리 만들어두고 재사용함
        ExecutorService executorService = Executors.newFixedThreadPool(32);

        // 다른 스레드에서 수행하는 작업을 기다리도록 도와주는 클래스
        CountDownLatch latch = new CountDownLatch(threadCount);

        // for문으로 1000개의 요청 보냄
        for (int i = 0; i < threadCount; i++) {
            long userId = i;
            executorService.submit(() -> {  // 작업을 큐에 제출함 -> 32개 스레드가 번갈아가며 작업 처리함
                try {
                    applyService.apply(userId);
                } finally {
                    latch.countDown();
                }
            });
        }

        // 카운트가 0이 될 때까지 (1000개 전부 끝날 때까지) 여기서 블로킹
        latch.await();

        // Consumer 처리 대기
        Thread.sleep(10000);

        // 생성된 쿠폰의 수 확인
        long count = couponRepository.count();
        assertThat(count).isEqualTo(100);
    }

    @Test
    public void 한명당_한개쿠폰만_발급() throws InterruptedException {
        int threadCount = 1000;

        // 스레드를 직접 생성/관리하는 번거로움을 없애주는 스레드 풀 관리 API
        // 스레드 32개를 미리 만들어두고 재사용함
        ExecutorService executorService = Executors.newFixedThreadPool(32);

        // 다른 스레드에서 수행하는 작업을 기다리도록 도와주는 클래스
        CountDownLatch latch = new CountDownLatch(threadCount);

        // for문으로 1000개의 요청 보냄
        for (int i = 0; i < threadCount; i++) {
            long userId = i;
            executorService.submit(() -> {  // 작업을 큐에 제출함 -> 32개 스레드가 번갈아가며 작업 처리함
                try {
                    applyService.apply(1L); // userId 고정 -> 여러번 요청해도 한번만 발급되는지 확인하기 위함
                } finally {
                    latch.countDown();
                }
            });
        }

        // 카운트가 0이 될 때까지 (1000개 전부 끝날 때까지) 여기서 블로킹
        latch.await();

        // Consumer 처리 대기
        Thread.sleep(10000);

        // 생성된 쿠폰의 수 확인
        long count = couponRepository.count();
        assertThat(count).isEqualTo(1);
    }
}
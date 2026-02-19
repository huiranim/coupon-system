# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

선착순 쿠폰 발급 시스템. 동시성 문제를 Redis + Kafka로 해결하는 것이 핵심 주제.
두 개의 독립적인 Spring Boot 애플리케이션으로 구성된다.

## Modules

- **`api/`** — 쿠폰 발급 요청 수신, Redis로 중복/개수 필터링 후 Kafka에 발행
- **`consumer/`** — Kafka 메시지를 구독해 MySQL에 순차 저장, 실패 시 `failed_event` 테이블에 기록

## Commands

각 모듈은 독립적인 Gradle 프로젝트다. 루트에서는 빌드되지 않으므로 반드시 모듈 디렉토리에서 실행한다.

```bash
# api 모듈
cd api
./gradlew build
./gradlew test
./gradlew test --tests "com.example.api.service.ApplyServiceTest.여러명응모"

# consumer 모듈
cd consumer
./gradlew build
./gradlew test
```

## Tests

`ApplyServiceTest`는 `@SpringBootTest`를 사용하며 실제 Redis, Kafka, MySQL에 연결해 동작한다.

- **Redis 초기화**: `CouponEventInitializer`(`ApplicationRunner` 구현체)가 컨텍스트 시작 시 `coupon_count`, `applied_user` 키를 자동 삭제한다.
- **주의**: `@SpringBootTest` 컨텍스트는 테스트 클래스 내에서 **한 번만** 시작된다. `ApplicationRunner`도 1회만 실행되므로 테스트 메서드 사이에는 Redis가 초기화되지 않는다. 테스트를 전체 실행하면 앞 테스트가 남긴 `coupon_count`, `applied_user` 데이터가 다음 테스트에 영향을 줄 수 있다.
- **권장**: 각 테스트는 가능하면 개별 실행한다. 전체 실행 시 테스트 간 순서 의존성에 주의한다.

## Infrastructure (Docker)

| 컨테이너 | 역할 | 접속 정보 |
|---------|------|----------|
| `kafka` | Kafka broker | `localhost:9092` |
| `myredis` | Redis | `localhost:6379` |
| MySQL | DB | `localhost:3306/coupon_example` (root/1234) |

## Request Flow

```
POST /apply (userId)
  └── ApplyService
        ├── AppliedUserRepository.add(userId)   // Redis SADD "applied_user"
        │     └── 0 반환 (중복) → return
        ├── CouponCountRepository.increment()   // Redis INCR "coupon_count"
        │     └── > 100 → return
        └── CouponCreateProducer.create(userId) // Kafka topic: "coupon_create"
                                                        ↓
                                          CouponCreateConsumer (consumer 모듈)
                                            ├── 성공 → coupon 테이블 저장
                                            └── 실패 → failed_event 테이블 저장
```

## Key Design Decisions

- **SADD → INCR 순서**: 중복 체크를 먼저 해서 불필요한 INCR을 방지. 역순이면 중복 시마다 DECR 보상 로직 필요.
- **FailedEvent**: Consumer에서 DB 저장 실패 시 유실 방지를 위해 별도 테이블에 기록. 재처리는 미구현.
- **consumer 모듈 분리**: api와 consumer를 독립 프로세스로 운영해 DB 부하를 순차화.

## Known Issues

- INCR 통과 후 Kafka `send()` 실패 시 Redis 카운트만 증가하고 메시지는 유실됨
- 동일 유저 중복 방지는 Redis Set 기준이므로 Redis 장애 시 중복 발급 가능

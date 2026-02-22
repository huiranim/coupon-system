# 선착순 쿠폰 발급 시스템 — 부하 테스트 결과 보고서

## 1. 개요

선착순 쿠폰 발급 시스템의 처리량(Throughput), 응답시간(Latency), 병목 지점(Bottleneck)을 측정하기 위한 부하 테스트를 수행했다.

---

## 2. 테스트 환경

### 인프라
| 항목 | 내용 |
|------|------|
| 테스트 실행 머신 | MacBook Pro (메모리 16GB) |
| 로드 제너레이터 | k6 (Docker) |
| 모니터링 | InfluxDB 1.8 + Grafana |
| API 서버 | Spring Boot (localhost:8080) |
| 캐시 | Redis (localhost:6379) |
| 메시지 브로커 | Kafka (localhost:9092) |
| DB | MySQL (localhost:3306) |

### 로컬 환경 한계
모든 구성 요소가 단일 머신에서 실행되어 k6, API 서버, Redis, Kafka, MySQL이 CPU를 공유한다.
이로 인해 TPS 절대값보다 **추이(trend)** 중심으로 결과를 해석해야 한다.

### 측정 지표
- **TPS** (Requests per Second): 초당 처리 요청 수
- **P50**: 전체 요청의 50%가 이 시간 안에 응답 (중앙값)
- **P95**: 전체 요청의 95%가 이 시간 안에 응답
- **P99**: 전체 요청의 99%가 이 시간 안에 응답 (worst case에 근접)

---

## 3. 시스템 특성

```
POST /coupon/apply?userId={userId}
  └── Redis SADD "applied_user"    → 0 반환 시 409 (중복)
  └── Redis INCR "coupon_count"    → 100 초과 시 422 (소진)
  └── Kafka produce "coupon_create" → 200 (성공)
                ↓
        CouponCreateConsumer
          └── MySQL INSERT coupon
```

- 쿠폰 한도: 100개 (테스트마다 Redis 초기화 필요)
- 성공(200) 경로: Redis 2회 + Kafka produce (비동기)
- 소진(422) 경로: Redis 2회 + 즉시 throw (Kafka 없음, 더 빠름)
- 실제 부하 테스트에서 100개 쿠폰은 수십 ms 내에 소진되므로 대부분의 요청이 422 경로로 처리됨

---

## 4. 테스트 결과

### Phase 1 — Baseline (기준선 측정)

**설정**: 10 VU × 60초

| 지표 | 값 |
|------|-----|
| TPS | ~2,300 req/s |
| avg | 1.6ms |
| P50 | 1.5ms |
| P95 | 2.2ms |
| P99 | 4.4ms |
| max | 264ms |
| 발급 성공 (200) | 100건 |
| 쿠폰 소진 (422) | ~84,000건 |
| 서버 에러 (5xx) | 10건 (0.01%) |

**해석**
- 낮은 부하에서 시스템은 매우 안정적으로 동작
- P99 4.4ms는 Redis 2회 호출 + 네트워크 왕복 기준으로 양호한 수준
- 이후 Phase의 비교 기준값으로 활용

---

### Phase 2 — Ramp-up (한계선 탐색)

**설정**: 10 → 50 → 100 → 300 → 500 → 1000 VU (단계별 90초)

| 지표 | 값 |
|------|-----|
| TPS (전체 평균) | ~4,013 req/s |
| avg | 31.2ms |
| P50 | 15.0ms |
| P95 | 108.5ms |
| P99 | 195.4ms |
| max | 500.7ms |
| 서버 에러 (5xx) | 3,133건 (0.13%) |

**단계별 관찰**

| VU | TPS 관찰 | Latency 관찰 |
|----|---------|-------------|
| 10 | ~2,300 | P99 낮고 안정 |
| 50 | 증가 | 대체로 낮음 |
| 100 | 증가 둔화 | 소폭 증가 |
| 300 | plateau 근접 | 스파이크 시작 |
| 500 | plateau | 스파이크 빈번 |
| 1000 | plateau 또는 감소 | 200~500ms 스파이크 |

**해석**
- TPS saturation point: 100~300 VU 구간
- Latency knee point: 300 VU 이상에서 스파이크 빈도 증가
- VU 증가에도 TPS가 비례 증가하지 않는 주된 이유는 **로컬 CPU 경합** (k6와 서버 프로세스가 동일 CPU 공유)

---

### Phase 3 — Stress (지속 부하 내구성)

**설정**: 300 VU × 5분 유지

| 지표 | 값 |
|------|-----|
| TPS (전체 평균) | ~4,242 req/s |
| avg | 11.8ms |
| P50 | 8.6ms |
| P95 | 32.2ms |
| P99 | 60.9ms |
| max | 1,550ms |
| 서버 에러 (5xx) | 2,392건 (0.14%) |

**판정: 안정(Stable)**

| 관찰 항목 | 결과 |
|----------|------|
| 5분간 Latency 추이 | 우상향 없음 — 일정 수준 유지 ✅ |
| TPS 추이 | 감소 없음 ✅ |
| 5xx 에러 추이 | 증가 추세 없음 ✅ |
| 자원 누수 의심 | 없음 ✅ |

**해석**
- 300 VU는 TPS 관점에서 포화 상태이나 시스템이 안정적으로 처리
- 5분 지속 부하에서 latency 우상향이 없으므로 메모리 누수, 큐 누적, 커넥션 고갈 없음
- max 1,550ms는 테스트 종료 시 VU 감소 과정의 in-flight 요청 타임아웃으로 이상치

---

### Phase 4 — Spike (급격한 트래픽 변동 대응)

**설정**: 10 VU(60s) → 1000 VU(60s) → 10 VU(60s)

| 지표 | 값 |
|------|-----|
| TPS (전체 평균) | ~2,959 req/s |
| avg | 72.4ms |
| P50 | 65.1ms |
| P95 | 195.2ms |
| P99 | 291.8ms |
| max | 865ms |
| 서버 에러 (5xx) | 841건 (0.11%) |

**구간별 비교**

| 구간 | VU | P99 | 상태 |
|------|----|-----|------|
| 평상시 | 10 | ~20ms | 안정 |
| 스파이크 | 1000 | 200~800ms | 급등 |
| 회복 | 10 | ~20ms (수 초 이내 복귀) | **빠른 회복** |

**해석**
- 스파이크 순간 P99가 약 30~40배 급등했으나 5xx 에러는 0.11%로 낮은 수준 유지
- VU가 10으로 감소한 직후 latency가 **수 초 이내**에 기준값으로 복귀
- 빠른 회복의 원인: Redis 무상태 연산 + Kafka 비동기 produce 구조로 인해 처리 잔재(state)가 없음

---

## 5. 종합 분석

### 병목 지점

| 병목 | 근거 |
|------|------|
| Tomcat 스레드풀 (기본 200) | 300 VU 이상에서 latency 스파이크 시작 |
| 로컬 CPU 경합 | VU 증가에도 TPS 비례 증가 없음 — k6와 서버가 CPU 공유 |

### 아키텍처 강점

| 항목 | 평가 |
|------|------|
| Redis 동시성 제어 | SADD/INCR 원자 연산으로 중복 없이 정확히 100건 발급 ✅ |
| Kafka 비동기 처리 | API 응답이 DB 저장을 기다리지 않아 낮은 latency 유지 ✅ |
| 스파이크 회복력 | 부하 제거 시 수 초 이내 복귀 — 상태 잔존 없음 ✅ |

### 개선 여지

| 항목 | 내용 |
|------|------|
| Tomcat 스레드풀 증설 | `server.tomcat.threads.max` 조정으로 고VU 구간 latency 개선 가능 |
| 별도 부하 서버 | k6를 독립 서버에서 실행하면 정확한 TPS saturation point 측정 가능 |
| INCR 후 Kafka 실패 처리 | 현재 Redis 카운트는 증가했으나 Kafka 전송 실패 시 쿠폰 유실 가능 |

---

## 6. 스크립트 목록

| 파일 | Phase | 내용 |
|------|-------|------|
| `common.js` | 공통 | BASE_URL, uniqueUserId 유틸리티 |
| `01_baseline.js` | Phase 1 | 10 VU × 60s 기준선 측정 |
| `02_rampup.js` | Phase 2 | 10→1000 VU 단계적 증가 |
| `03_stress.js` | Phase 3 | 300 VU × 5분 지속 부하 |
| `04_spike.js` | Phase 4 | 10→1000→10 VU 스파이크 |

### 실행 방법 (공통)

```bash
# Redis 초기화 (각 테스트 전 필수)
redis-cli DEL coupon_count applied_user

# k6 실행 (모니터링 포함)
docker run --rm -i \
  -v $(pwd)/tests:/tests \
  -e BASE_URL=http://host.docker.internal:8080 \
  grafana/k6 run \
  --out influxdb=http://host.docker.internal:8086/k6 \
  /tests/{스크립트명}
```

### 모니터링 스택

```bash
# InfluxDB + Grafana 실행
cd /Users/n-hryu/learning/k6-monitoring
docker compose up -d

# Grafana 접속
open http://localhost:3000
```

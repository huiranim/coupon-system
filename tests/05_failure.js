/**
 * 장애 시뮬레이션용 스크립트
 * =====================================================================
 * 목적:
 *   장애를 수동으로 주입하는 동안 API의 응답 변화를 실시간으로 관찰한다.
 *   3개의 시나리오(Consumer 종료 / DB 다운 / Redis 다운)에 공통으로 사용한다.
 *
 * 타임라인 (3분 기준):
 *   0:00 ~ 1:00  정상 상태 관찰 — 기준 latency / TPS 확인
 *   1:00         장애 주입      — 아래 시나리오별 명령어 실행
 *   1:00 ~ 2:00  장애 상태 관찰 — 에러율 / latency 변화 확인
 *   2:00         장애 복구      — 아래 시나리오별 복구 명령어 실행
 *   2:00 ~ 3:00  복구 후 관찰   — 시스템이 정상으로 돌아오는지 확인
 *
 * ─────────────────────────────────────────────────────────────────────
 * 시나리오 #1 — Kafka Consumer 강제 종료
 * ─────────────────────────────────────────────────────────────────────
 * 예상 동작:
 *   - API는 정상 동작 (200/409/422 응답 유지)
 *   - Kafka topic에 메시지가 쌓이기 시작 (consumer lag 증가)
 *   - MySQL coupon 테이블에 데이터가 더 이상 추가되지 않음
 *   - Consumer 재시작 시 밀린 메시지를 순차적으로 처리
 *
 * [준비]
 *   redis-cli DEL coupon_count applied_user
 *
 * [k6 실행 — 터미널 A]
 *   docker run --rm -i \
 *     -v $(pwd)/tests:/tests \
 *     -e BASE_URL=http://host.docker.internal:8080 \
 *     grafana/k6 run \
 *     --out influxdb=http://host.docker.internal:8086/k6 \
 *     /tests/05_failure.js
 *
 * [1:00 — 장애 주입 — 터미널 B]
 *   # IDE(IntelliJ)에서 Consumer 앱 Stop 버튼 클릭
 *   # 또는 터미널에서:
 *   kill $(lsof -ti:포트번호)   ← consumer 앱 포트 확인 후 입력
 *
 * [장애 중 — 터미널 B에서 확인]
 *   # coupon 테이블이 멈추는지 확인
 *   docker exec -it mysql mysql -uroot -p1234 \
 *     -e "SELECT COUNT(*) FROM coupon_example.coupon;"
 *
 *   # Kafka consumer lag 증가 확인
 *   docker exec kafka kafka-consumer-groups.sh \
 *     --bootstrap-server localhost:9092 \
 *     --describe --group group_1
 *
 * [2:00 — 복구]
 *   # Consumer 앱 재시작 (IDE 또는 터미널에서 실행)
 *
 * [복구 후 확인]
 *   # 밀린 메시지가 처리되어 coupon 테이블 카운트가 올라가는지 확인
 *   docker exec -it mysql mysql -uroot -p1234 \
 *     -e "SELECT COUNT(*) FROM coupon_example.coupon;"
 *
 * ─────────────────────────────────────────────────────────────────────
 * 시나리오 #2 — 쿠폰 발급 중 DB 연결 끊기
 * ─────────────────────────────────────────────────────────────────────
 * 예상 동작:
 *   - API는 정상 동작 (API 서버는 MySQL 직접 사용 안 함)
 *   - Consumer가 coupon 저장 실패 → catch 블록에서 failed_event 저장 시도
 *   - MySQL 자체가 다운이면 failed_event 저장도 실패 → Consumer 에러 로그 출력
 *   - Kafka는 ack 미수신 시 메시지를 재전달할 수 있음 (설정에 따라 다름)
 *
 * [준비]
 *   redis-cli DEL coupon_count applied_user
 *
 * [k6 실행 — 터미널 A]
 *   docker run --rm -i \
 *     -v $(pwd)/tests:/tests \
 *     -e BASE_URL=http://host.docker.internal:8080 \
 *     grafana/k6 run \
 *     --out influxdb=http://host.docker.internal:8086/k6 \
 *     /tests/05_failure.js
 *
 * [1:00 — 장애 주입 — 터미널 B]
 *   docker stop mysql
 *
 * [장애 중 — 터미널 B에서 확인]
 *   # Consumer 앱 로그에서 에러 메시지 확인
 *   # "failed to create coupon" 로그가 출력되는지 확인
 *
 * [2:00 — 복구]
 *   docker start mysql
 *
 * [복구 후 확인]
 *   # failed_event 테이블에 기록이 남아있는지 확인
 *   docker exec -it mysql mysql -uroot -p1234 \
 *     -e "SELECT COUNT(*) FROM coupon_example.failed_event;"
 *
 *   # coupon 테이블 정상 저장 재개 확인
 *   docker exec -it mysql mysql -uroot -p1234 \
 *     -e "SELECT COUNT(*) FROM coupon_example.coupon;"
 *
 * ─────────────────────────────────────────────────────────────────────
 * 시나리오 #3 — Redis 강제 종료
 * ─────────────────────────────────────────────────────────────────────
 * 예상 동작:
 *   - API 전면 장애 발생 (Redis SADD 첫 단계부터 실패)
 *   - GlobalExceptionHandler가 Redis 예외를 처리하지 않으므로 500 응답
 *   - k6 에러율이 급격히 증가
 *   - Redis 복구 시 자동으로 정상 응답 재개 (단, coupon_count / applied_user 초기화됨)
 *
 * [준비]
 *   redis-cli DEL coupon_count applied_user
 *
 * [k6 실행 — 터미널 A]
 *   docker run --rm -i \
 *     -v $(pwd)/tests:/tests \
 *     -e BASE_URL=http://host.docker.internal:8080 \
 *     grafana/k6 run \
 *     --out influxdb=http://host.docker.internal:8086/k6 \
 *     /tests/05_failure.js
 *
 * [1:00 — 장애 주입 — 터미널 B]
 *   docker stop myredis
 *
 * [장애 중 — 터미널 B에서 확인]
 *   # k6 터미널에서 [FAILURE] 로그 및 에러율 급증 확인
 *   # API 서버 로그에서 Redis 연결 실패 에러 확인
 *
 * [2:00 — 복구]
 *   docker start myredis
 *
 * [복구 후 확인]
 *   # k6 터미널에서 에러율이 0으로 돌아오는지 확인
 *   # Redis 데이터는 초기화되므로 쿠폰이 다시 발급될 수 있음
 *   redis-cli DEL coupon_count applied_user  ← 필요 시 재초기화
 * =====================================================================
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter } from 'k6/metrics';
import { BASE_URL, uniqueUserId } from './common.js';

http.setResponseCallback(http.expectedStatuses(200, 409, 422));

const successCount   = new Counter('coupon_success');
const duplicateCount = new Counter('coupon_duplicate');
const exhaustedCount = new Counter('coupon_exhausted');
const errorCount     = new Counter('coupon_error');

export const options = {
  // 장애 시뮬레이션은 낮은 VU로 충분하다.
  // 너무 많은 VU는 로컬 CPU를 압박해 장애 영향이 왜곡될 수 있다.
  // 30 VU로 꾸준히 요청을 보내면서 장애 주입/복구 효과를 관찰한다.
  vus: 30,

  // 3분: 장애 주입 및 복구까지 충분한 시간
  duration: '3m',

  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],

  thresholds: {
    // 장애 시뮬레이션이므로 threshold는 참고용으로만 설정
    // 장애 구간에서 기준을 넘는 것은 당연하며, 이것이 목적이다.
    http_req_failed: ['rate<1.0'], // 사실상 항상 통과 (관찰 목적)
  },
};

export default function () {
  const userId = uniqueUserId(__VU, __ITER);

  const res = http.post(`${BASE_URL}/coupon/apply?userId=${userId}`, null, {
    tags: { name: 'POST /coupon/apply' },

    // 장애 시 응답이 늦을 수 있으므로 타임아웃을 넉넉하게 설정
    // 기본값(60s)보다 짧게 설정해 hung 요청이 오래 점유하지 않도록 함
    timeout: '5s',
  });

  if (res.status === 200) {
    successCount.add(1);
  } else if (res.status === 409) {
    duplicateCount.add(1);
  } else if (res.status === 422) {
    exhaustedCount.add(1);
  } else {
    errorCount.add(1);
    // 장애 발생 시 어떤 에러인지 로그로 확인
    console.error(`[FAILURE] status=${res.status}, error=${res.error}`);
  }

  check(res, {
    'status is 2xx/4xx (정상)': (r) => [200, 409, 422].includes(r.status),
    'no 5xx (서버 에러 없음)':  (r) => r.status < 500,
  });

  // 0.1초 대기: 장애 주입/복구 타이밍을 조정하기 용이하도록
  // sleep 없이 최대 속도로 보내면 장애 순간이 너무 짧게 지나갈 수 있음
  sleep(0.1);
}

export function handleSummary(data) {
  const dur  = data.metrics.http_req_duration;
  const reqs = data.metrics.http_reqs;
  const fmt  = (v) => (v != null ? v.toFixed(1) : 'N/A');

  const total   = reqs.values.count;
  const success = data.metrics.coupon_success?.values.count ?? 0;
  const dup     = data.metrics.coupon_duplicate?.values.count ?? 0;
  const exhaust = data.metrics.coupon_exhausted?.values.count ?? 0;
  const errors  = data.metrics.coupon_error?.values.count ?? 0;

  console.log('\n========== 장애 시뮬레이션 Summary ==========');
  console.log(`총 요청 수      : ${total} 건`);
  console.log(`TPS (평균)      : ${reqs.values.rate.toFixed(1)} req/s`);
  console.log(`응답시간 avg    : ${fmt(dur.values.avg)} ms`);
  console.log(`응답시간 P99    : ${fmt(dur.values['p(99)'])} ms`);
  console.log(`응답시간 max    : ${fmt(dur.values.max)} ms`);
  console.log('----------------------------------------------');
  console.log(`발급 성공 (200) : ${success} 건  (${pct(success, total)}%)`);
  console.log(`중복 신청 (409) : ${dup} 건  (${pct(dup, total)}%)`);
  console.log(`쿠폰 소진 (422) : ${exhaust} 건  (${pct(exhaust, total)}%)`);
  console.log(`서버 에러 (5xx) : ${errors} 건  (${pct(errors, total)}%)`);
  console.log('==============================================\n');

  return {};
}

function pct(n, total) {
  return total > 0 ? ((n / total) * 100).toFixed(2) : '0.00';
}

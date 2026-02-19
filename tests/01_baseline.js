/**
 * Phase 1 — Baseline (기준선 측정)
 * =====================================================================
 * 목적:
 *   낮은 부하(10 VUs)에서 시스템이 정상 동작하는지 확인하고,
 *   이후 Phase 2~4에서 비교할 "정상 상태의 기준 수치"를 확보한다.
 *
 * 기대 결과:
 *   - 에러율 0%
 *   - P99 응답시간 500ms 이하
 *   - TPS가 어느 정도 나오는지 → Phase 2 부하 설정의 참고값
 *
 * 실행 전 필수:
 *   redis-cli DEL coupon_count applied_user
 *   (쿠폰 100개 한도가 있으므로, 초기화하지 않으면 바로 422만 응답함)
 *
 * 실행 명령:
 *   docker run --rm -i --network host \
 *     -v $(pwd)/tests:/tests \
 *     grafana/k6 run /tests/01_baseline.js
 * =====================================================================
 */

// k6 내장 모듈 import
import http from 'k6/http';   // HTTP 요청 전송
import { check } from 'k6';   // 응답 검증 (실패해도 테스트는 계속 진행됨)

// k6는 기본적으로 4xx/5xx를 모두 "실패"로 간주한다.
// 하지만 409(중복), 422(소진)는 이 시스템의 정상 비즈니스 응답이므로
// "성공"으로 분류하도록 재정의한다.
// → 이후 http_req_failed 메트릭은 오직 5xx와 네트워크 에러만 카운팅
http.setResponseCallback(http.expectedStatuses(200, 409, 422));

// k6 커스텀 메트릭 모듈
// - Counter : 누적 카운트 (증가만 가능)
// - Trend   : 숫자 값의 통계 (avg, min, max, percentile 등 자동 계산)
import { Counter, Trend } from 'k6/metrics';

// 공통 설정 import
import { BASE_URL, uniqueUserId } from './common.js';


// ─────────────────────────────────────────────
// 커스텀 메트릭 정의
// k6 기본 메트릭(http_req_duration 등)은 모든 응답을 합산하지만,
// 여기서는 응답 코드별로 나눠서 따로 집계한다.
// ─────────────────────────────────────────────

// 응답 코드별 요청 수 카운터
const successCount   = new Counter('coupon_success');   // 200: 발급 성공
const duplicateCount = new Counter('coupon_duplicate'); // 409: 중복 신청
const exhaustedCount = new Counter('coupon_exhausted'); // 422: 쿠폰 소진
const errorCount     = new Counter('coupon_error');     // 5xx: 서버 에러

// 200 응답만의 응답시간 추이
// 이유: 422(Redis에서 즉시 throw)는 응답이 매우 빠르므로,
//       전체 평균에 섞이면 실제 성공 처리 latency가 왜곡됨
// true = 퍼센타일 출력 활성화
const successLatency = new Trend('latency_success_ms', true);


// ─────────────────────────────────────────────
// 테스트 옵션 설정
// k6는 이 객체를 읽어서 몇 명의 VU를 몇 초 동안 실행할지 결정한다.
// ─────────────────────────────────────────────
export const options = {
  // VU (Virtual User): 동시에 요청을 보내는 가상 사용자 수
  // 10명이 각자 독립적으로 default function()을 계속 반복 실행한다.
  vus: 10,

  // duration: 테스트를 총 몇 초/분 동안 실행할지
  // 60초 동안 10 VU가 쉬지 않고 요청을 보낸다.
  duration: '60s',

  // handleSummary에서 접근 가능한 퍼센타일 목록 명시
  // 기본값: avg/min/med/max/p(90)/p(95) → p(99)는 여기에 추가해야 N/A가 안 됨
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],

  // thresholds: 테스트 성공/실패 기준
  // 이 기준을 넘기면 k6가 exit code 1로 종료된다 (CI/CD에서 실패 감지 가능).
  // Baseline이므로 기준을 관대하게 설정한다.
  thresholds: {
    // k6 기본 메트릭: 5xx 에러 비율이 1% 미만이어야 함
    // (200/409/422는 에러로 카운트되지 않음 — k6는 5xx만 failed로 봄)
    http_req_failed: ['rate<0.01'],

    // k6 기본 메트릭: 전체 요청의 P99 응답시간이 500ms 미만
    // P99 = 99%의 요청이 이 시간 안에 응답했다는 의미
    http_req_duration: ['p(99)<500'],

    // 커스텀 메트릭: 5xx 에러가 5건을 넘으면 안 됨
    coupon_error: ['count<5'],
  },
};


// ─────────────────────────────────────────────
// 메인 함수 (default export)
// k6는 이 함수를 각 VU가 duration 동안 반복 실행한다.
// 함수 1회 실행 = 1 iteration = 요청 1건
// ─────────────────────────────────────────────
export default function () {
  // __VU: 현재 VU 번호 (1~10)
  // __ITER: 현재 VU의 반복 횟수 (0, 1, 2, ...)
  // → 두 값을 조합해 항상 고유한 userId 생성
  const userId = uniqueUserId(__VU, __ITER);

  // HTTP POST 요청 전송
  // 두 번째 인자(body)는 null — 이 API는 body 없이 query param만 사용
  // tags.name: URL에 userId가 들어가면 고유 URL이 수만 개 생겨 메모리 폭발
  //   → name 태그로 모든 요청을 하나의 그룹으로 묶어 메트릭 집계
  const res = http.post(`${BASE_URL}/coupon/apply?userId=${userId}`, null, {
    tags: { name: 'POST /coupon/apply' },
  });

  // 응답 코드별 커스텀 메트릭 집계
  if (res.status === 200) {
    successCount.add(1);
    successLatency.add(res.timings.duration); // 성공 응답만 별도 latency 기록
  } else if (res.status === 409) {
    duplicateCount.add(1);
  } else if (res.status === 422) {
    exhaustedCount.add(1);
  } else {
    // 5xx, 네트워크 에러 등
    errorCount.add(1);
    console.error(`unexpected status: ${res.status}, body: ${res.body}`);
  }

  // check(): 응답 검증
  // - 조건이 false여도 테스트는 중단되지 않고 계속 진행됨
  // - 결과는 "checks" 메트릭으로 집계되어 최종 리포트에 표시됨
  check(res, {
    // 200/409/422 중 하나인가? (5xx가 아닌가?)
    'status is 2xx/4xx': (r) => [200, 409, 422].includes(r.status),

    // 응답시간이 200ms 미만인가?
    // Baseline(낮은 부하)에서는 이 정도는 나와야 함
    'response time < 200ms': (r) => r.timings.duration < 200,
  });

  // sleep(): VU가 다음 iteration 전에 대기하는 시간 (초 단위)
  // 주석 처리 상태 = 대기 없이 최대한 빠르게 요청
  // → Baseline에서는 시스템의 최대 처리량을 확인하기 위해 sleep 없이 실행
  // sleep(0.1);
}


// ─────────────────────────────────────────────
// handleSummary: 테스트 종료 후 호출되는 함수
// data 객체에 모든 메트릭의 최종 집계값이 들어있다.
// 여기서 콘솔 출력, JSON 저장, 외부 전송 등을 처리할 수 있다.
// ─────────────────────────────────────────────
export function handleSummary(data) {
  const dur  = data.metrics.http_req_duration;
  const reqs = data.metrics.http_reqs;

  console.log('\n========== Phase 1: Baseline Summary ==========');
  // k6 Trend 메트릭의 handleSummary 내 키 목록:
  //   avg, min, max, med (= P50 중앙값)
  //   p(90), p(95) → 기본 제공
  //   p(99) → thresholds에 선언했을 때만 생성됨
  // ※ 'p(50)' 키는 존재하지 않음 — 중앙값은 'med' 키를 사용
  const fmt = (v) => (v != null ? v.toFixed(1) : 'N/A');

  console.log(`총 요청 수      : ${reqs.values.count} 건`);
  console.log(`TPS (평균)      : ${reqs.values.rate.toFixed(1)} req/s`);
  console.log(`응답시간 avg    : ${fmt(dur.values.avg)} ms`);
  console.log(`응답시간 P50    : ${fmt(dur.values.med)} ms`);
  console.log(`응답시간 P95    : ${fmt(dur.values['p(95)'])} ms`);
  console.log(`응답시간 P99    : ${fmt(dur.values['p(99)'])} ms`);
  console.log(`응답시간 max    : ${fmt(dur.values.max)} ms`);
  console.log('------------------------------------------------');
  console.log(`발급 성공 (200) : ${data.metrics.coupon_success?.values.count ?? 0} 건`);
  console.log(`중복 신청 (409) : ${data.metrics.coupon_duplicate?.values.count ?? 0} 건`);
  console.log(`쿠폰 소진 (422) : ${data.metrics.coupon_exhausted?.values.count ?? 0} 건`);
  console.log(`서버 에러 (5xx) : ${data.metrics.coupon_error?.values.count ?? 0} 건`);
  console.log('================================================');

  // 빈 객체 반환 = k6 기본 리포트는 그대로 출력
  // { 'stdout': textSummary(data, ...) } 형태로 커스터마이징도 가능
  return {};
}

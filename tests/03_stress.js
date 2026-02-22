/**
 * Phase 3 — Stress (최대 부하 안정성 검증)
 * =====================================================================
 * 목적:
 *   Phase 2에서 찾은 knee point(300 VU) 근방에서 5분간 지속 부하를 가해
 *   시스템이 "버티는지" vs "서서히 무너지는지"를 확인한다.
 *
 *   Phase 2가 "어디서 흔들리기 시작하는가"를 탐색했다면,
 *   Phase 3은 "그 지점에서 시간이 지남에 따라 어떻게 되는가"를 관찰한다.
 *
 * 확인할 것:
 *   1. Latency가 시간이 지나도 일정한가? (안정)
 *      vs 서서히 증가하는가? (자원 누수 또는 큐 누적)
 *   2. 5xx 에러율이 일정한가?
 *      vs 시간이 갈수록 증가하는가? (시스템 점진적 열화)
 *   3. TPS가 유지되는가?
 *      vs 시간이 갈수록 감소하는가? (처리 능력 저하)
 *
 * Phase 2와의 차이:
 *   Phase 2 → VU를 계속 올리며 "한계선 탐색" (12분 30초)
 *   Phase 3 → 특정 VU를 고정하여 "지속 내구성 검증" (6분 30초)
 *
 * 실행 전 필수:
 *   redis-cli DEL coupon_count applied_user
 *
 * 실행 명령:
 *   docker run --rm -i \
 *     -v $(pwd)/tests:/tests \
 *     -e BASE_URL=http://host.docker.internal:8080 \
 *     grafana/k6 run \
 *     --out influxdb=http://host.docker.internal:8086/k6 \
 *     /tests/03_stress.js
 * =====================================================================
 */

import http from 'k6/http';
import { check } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import { BASE_URL, uniqueUserId } from './common.js';

http.setResponseCallback(http.expectedStatuses(200, 409, 422));

const successCount   = new Counter('coupon_success');
const duplicateCount = new Counter('coupon_duplicate');
const exhaustedCount = new Counter('coupon_exhausted');
const errorCount     = new Counter('coupon_error');
const successLatency = new Trend('latency_success_ms', true);

export const options = {
  // Phase 2의 stages와 달리, 여기서는 단순히 VU를 고정한다.
  // 목적이 "탐색"이 아닌 "지속 내구성 검증"이므로
  // 변동 없이 일정한 부하를 5분간 유지하는 것이 핵심이다.
  stages: [
    // 워밍업: 30초 동안 0 → 300 VU로 천천히 올림
    // 급격히 올리면 초반 스파이크가 측정값을 오염시킬 수 있음
    { duration: '30s', target: 300 },

    // 핵심 측정 구간: 300 VU를 5분간 유지
    // 이 구간의 latency/TPS/에러율 추이가 Phase 3의 핵심 데이터
    { duration: '5m',  target: 300 },

    // 정리: 30초 동안 300 → 0 VU로 감소
    { duration: '30s', target: 0 },
  ],
  // 총 실행 시간: 6분 30초

  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],

  thresholds: {
    // Phase 3은 "어느 수준까지 버티는가"가 아니라
    // "이 부하에서 안정적인가"를 보는 단계.
    // 따라서 Phase 2보다 기준을 조금 더 엄격하게 설정한다.
    http_req_failed:   ['rate<0.03'],  // 5xx < 3%
    http_req_duration: ['p(99)<500'],  // P99 < 500ms
  },
};

export default function () {
  const userId = uniqueUserId(__VU, __ITER);

  const res = http.post(`${BASE_URL}/coupon/apply?userId=${userId}`, null, {
    tags: { name: 'POST /coupon/apply' },
  });

  if (res.status === 200) {
    successCount.add(1);
    successLatency.add(res.timings.duration);
  } else if (res.status === 409) {
    duplicateCount.add(1);
  } else if (res.status === 422) {
    exhaustedCount.add(1);
  } else {
    errorCount.add(1);
    console.error(`unexpected status: ${res.status}, body: ${res.body}`);
  }

  check(res, {
    'status is 2xx/4xx': (r) => [200, 409, 422].includes(r.status),
  });
}

export function handleSummary(data) {
  const dur  = data.metrics.http_req_duration;
  const reqs = data.metrics.http_reqs;
  const fmt  = (v) => (v != null ? v.toFixed(1) : 'N/A');

  console.log('\n========== Phase 3: Stress Summary ==========');
  console.log('[ 300 VU × 5분 지속 부하 결과 ]');
  console.log(`총 요청 수      : ${reqs.values.count} 건`);
  console.log(`TPS (전체 평균) : ${reqs.values.rate.toFixed(1)} req/s`);
  console.log(`응답시간 avg    : ${fmt(dur.values.avg)} ms`);
  console.log(`응답시간 P50    : ${fmt(dur.values.med)} ms`);
  console.log(`응답시간 P95    : ${fmt(dur.values['p(95)'])} ms`);
  console.log(`응답시간 P99    : ${fmt(dur.values['p(99)'])} ms`);
  console.log(`응답시간 max    : ${fmt(dur.values.max)} ms`);
  console.log('----------------------------------------------');
  console.log(`발급 성공 (200) : ${data.metrics.coupon_success?.values.count ?? 0} 건`);
  console.log(`중복 신청 (409) : ${data.metrics.coupon_duplicate?.values.count ?? 0} 건`);
  console.log(`쿠폰 소진 (422) : ${data.metrics.coupon_exhausted?.values.count ?? 0} 건`);
  console.log(`서버 에러 (5xx) : ${data.metrics.coupon_error?.values.count ?? 0} 건`);
  console.log('----------------------------------------------');
  console.log('[ 판정 기준 ]');
  console.log('  Latency가 5분간 일정 → 시스템 안정');
  console.log('  Latency가 우상향     → 자원 누수 또는 큐 누적 의심');
  console.log('  5xx 에러가 우상향    → 시스템 점진적 열화');
  console.log('==============================================\n');

  return {};
}

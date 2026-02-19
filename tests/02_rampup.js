/**
 * Phase 2 — Ramp-up (한계선 탐색)
 * =====================================================================
 * 목적:
 *   VU를 단계적으로 늘리면서 두 가지 변곡점을 찾는다.
 *
 *   1) TPS saturation point
 *      VU를 늘려도 TPS가 더 이상 증가하지 않는 지점
 *      → 그 VU 수에서 시스템의 처리 한계에 도달했다는 의미
 *
 *   2) Latency knee point
 *      특정 VU 수를 넘으면서 P99 응답시간이 급격히 올라가는 지점
 *      → 처리 속도보다 요청이 더 빠르게 쌓이기 시작했다는 신호
 *
 *   이 두 지점을 찾으면 Phase 3(Stress)의 목표 VU를 설정할 수 있다.
 *
 * Phase 1과의 차이:
 *   Phase 1은 고정 VU(10명)로 "정상 상태"를 측정했다.
 *   Phase 2는 VU를 계속 올리면서 "어디서 무너지는가"를 탐색한다.
 *
 * 실행 명령:
 *   docker run --rm -i \
 *     -v $(pwd)/tests:/tests \
 *     -e BASE_URL=http://host.docker.internal:8080 \
 *     grafana/k6 run /tests/02_rampup.js
 * =====================================================================
 */

import http from 'k6/http';
import { check } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import { BASE_URL, uniqueUserId } from './common.js';

// 409/422를 실패로 간주하지 않도록 재정의 (Phase 1과 동일)
http.setResponseCallback(http.expectedStatuses(200, 409, 422));

// ─────────────────────────────────────────────
// 커스텀 메트릭 (Phase 1과 동일한 구조)
// ─────────────────────────────────────────────
const successCount   = new Counter('coupon_success');
const duplicateCount = new Counter('coupon_duplicate');
const exhaustedCount = new Counter('coupon_exhausted');
const errorCount     = new Counter('coupon_error');

// 성공(200) 응답만의 latency — 422와 섞이면 왜곡됨
const successLatency = new Trend('latency_success_ms', true);


// ─────────────────────────────────────────────
// 테스트 옵션
// ─────────────────────────────────────────────
export const options = {
  // Phase 1에서는 vus + duration으로 "고정 VU"를 사용했다.
  // Phase 2에서는 stages 배열로 "단계적 VU 증가"를 설정한다.
  //
  // stages 동작 방식:
  //   각 단계는 { duration, target } 으로 정의한다.
  //   - duration : 이 단계를 몇 초/분 동안 실행할지
  //   - target   : 이 단계가 끝날 때의 목표 VU 수
  //
  //   k6는 이전 단계 VU에서 target VU까지 duration 동안 선형으로 증감한다.
  //
  //   예시:
  //     { duration: '30s', target: 50 }  ← 30초 동안 현재 VU → 50으로 증가
  //     { duration: '60s', target: 50 }  ← 60초 동안 50 VU 유지 (측정 구간)
  //     { duration: '30s', target: 0  }  ← 30초 동안 50 → 0으로 감소 (정리)
  //
  // 각 단계를 "증가 + 유지"로 나눈 이유:
  //   증가 중에는 VU 수가 계속 변하므로 지표가 불안정하다.
  //   유지 구간에서 측정해야 해당 VU 수에서의 안정적인 TPS/latency를 얻을 수 있다.
  stages: [
    // ── 단계 1: 10 VU (워밍업 겸 Phase 1 기준값 재확인) ──────────
    { duration: '30s', target: 10  }, // 0 → 10 VU 워밍업
    { duration: '60s', target: 10  }, // 10 VU 유지 → Phase 1 결과와 비교 기준

    // ── 단계 2: 50 VU ────────────────────────────────────────────
    { duration: '30s', target: 50  }, // 10 → 50 VU 증가
    { duration: '60s', target: 50  }, // 50 VU 유지 → TPS가 5배가 됐는가?

    // ── 단계 3: 100 VU ───────────────────────────────────────────
    { duration: '30s', target: 100 }, // 50 → 100 VU 증가
    { duration: '60s', target: 100 }, // 100 VU 유지 → latency 변화 관찰

    // ── 단계 4: 300 VU ───────────────────────────────────────────
    // Tomcat 기본 스레드 풀은 200이다.
    // 300 VU는 스레드 풀을 초과하므로 이 단계에서 대기 큐가 생기기 시작할 수 있다.
    // → latency가 갑자기 오른다면 여기가 knee point
    { duration: '30s', target: 300 }, // 100 → 300 VU 증가
    { duration: '60s', target: 300 }, // 300 VU 유지 → 스레드 풀 압박 여부 확인

    // ── 단계 5: 500 VU ───────────────────────────────────────────
    { duration: '30s', target: 500 }, // 300 → 500 VU 증가
    { duration: '60s', target: 500 }, // 500 VU 유지

    // ── 단계 6: 1000 VU ──────────────────────────────────────────
    // 여기서 에러율이 급증하거나 latency가 폭발하면 이 근방이 시스템 한계
    { duration: '30s', target: 1000 }, // 500 → 1000 VU 증가
    { duration: '60s', target: 1000 }, // 1000 VU 유지

    // ── 정리: VU를 0으로 ─────────────────────────────────────────
    // 테스트 종료 전 VU를 0으로 내려야 열린 연결이 깔끔하게 닫힌다.
    { duration: '30s', target: 0 },
  ],
  // 총 실행 시간: (30s + 60s) × 6단계 + 30s 정리 ≈ 12분 30초

  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],

  thresholds: {
    // Phase 2는 한계를 "탐색"하는 단계이므로 기준을 느슨하게 설정한다.
    // 목적은 한계를 막는 것이 아니라 어디서 무너지는지 관찰하는 것이다.
    http_req_failed:   ['rate<0.05'],  // 5xx < 5% (Phase 1의 1%보다 완화)
    http_req_duration: ['p(99)<3000'], // P99 < 3초 (Phase 1의 500ms보다 완화)
  },
};


// ─────────────────────────────────────────────
// 메인 함수
// Phase 1과 로직은 완전히 동일하다.
// VU 수와 stages 설정만 다를 뿐, 각 VU의 행동은 같다.
// ─────────────────────────────────────────────
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


// ─────────────────────────────────────────────
// handleSummary
//
// Phase 2의 핵심은 "전체 평균"이 아닌 "단계별 추이"다.
// 아래 숫자는 전체 12분의 평균이므로 참고용이고,
// 실제 분석은 터미널 실시간 출력에서 VU별 변화를 직접 눈으로 확인해야 한다.
// ─────────────────────────────────────────────
export function handleSummary(data) {
  const dur  = data.metrics.http_req_duration;
  const reqs = data.metrics.http_reqs;
  const fmt  = (v) => (v != null ? v.toFixed(1) : 'N/A');

  console.log('\n========== Phase 2: Ramp-up Summary ==========');
  console.log('[ 아래는 전체 구간 평균 — 단계별 추이는 위 터미널 출력 참고 ]');
  console.log(`총 요청 수      : ${reqs.values.count} 건`);
  console.log(`TPS (전체 평균) : ${reqs.values.rate.toFixed(1)} req/s`);
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
  console.log('------------------------------------------------');
  console.log('[ 실시간 출력에서 확인할 포인트 ]');
  console.log('  1. VU 증가 시 TPS도 비례해서 오르는가?');
  console.log('     → 오르지 않으면: 그 VU 수가 TPS saturation point');
  console.log('  2. 특정 VU 구간에서 latency가 갑자기 오르는가?');
  console.log('     → 오르면: 그 VU 수가 latency knee point');
  console.log('     → Tomcat 스레드 풀(200) 초과 시점 주목');
  console.log('  3. 5xx 에러가 증가하기 시작하는 VU 수는?');
  console.log('     → 이 지점이 Phase 3(Stress) 목표 VU 설정 기준');
  console.log('================================================\n');

  return {};
}

/**
 * Phase 4 — Spike (급격한 트래픽 변동 대응력)
 * =====================================================================
 * 목적:
 *   트래픽이 갑자기 폭증했다가 급감하는 상황을 시뮬레이션한다.
 *   시스템이 급격한 변화에 얼마나 빠르게 적응하는지 확인한다.
 *
 *   Phase 3이 "일정한 부하를 오래 버티는가"를 봤다면,
 *   Phase 4는 "갑작스러운 변화에 어떻게 반응하는가"를 본다.
 *
 *   실제 서비스에서 선착순 이벤트 오픈 순간을 재현하는 것과 가장 유사하다.
 *   (평소 10명이 쓰다가 이벤트 시작과 동시에 1000명이 몰리는 상황)
 *
 * 확인할 것:
 *   1. 스파이크 직후 latency가 얼마나 올라가는가?
 *   2. 스파이크 이후 트래픽이 줄었을 때 latency가 빠르게 회복되는가?
 *      → 느리게 회복: 내부 큐/스레드 정리에 시간이 걸린다는 의미
 *   3. 스파이크 구간에서 5xx 에러가 발생하는가?
 *
 * Phase 3과의 차이:
 *   Phase 3 → 일정 VU 지속 유지 (내구성)
 *   Phase 4 → VU를 급격히 올렸다 내림 (순간 대응력)
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
 *     /tests/04_spike.js
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
  stages: [
    // ── 평상시 ───────────────────────────────────────────────────
    // 낮은 VU로 시작해 "정상 상태"의 latency 기준선을 확보한다.
    // 이 구간의 latency가 스파이크 이후 얼마나 빠르게 돌아오는지 비교 기준이 된다.
    { duration: '30s', target: 10  }, // 0 → 10 VU (워밍업)
    { duration: '60s', target: 10  }, // 10 VU 유지 → 기준 latency 측정

    // ── 스파이크 ─────────────────────────────────────────────────
    // 10 VU → 1000 VU로 10초 만에 급격히 올린다.
    // 실제 이벤트 오픈 순간을 재현하는 구간.
    // → 이 순간 latency와 에러율이 핵심 관찰 지표
    { duration: '10s', target: 1000 }, // 10 → 1000 VU 급증

    // ── 스파이크 유지 ─────────────────────────────────────────────
    // 1000 VU를 60초 유지한다.
    // 시스템이 급격한 부하를 받는 상태에서 안정화되는지 관찰.
    { duration: '60s', target: 1000 }, // 1000 VU 유지

    // ── 급감 ─────────────────────────────────────────────────────
    // 1000 VU → 10 VU로 10초 만에 급격히 내린다.
    // 트래픽이 빠진 뒤 시스템이 정상으로 복귀하는 속도를 관찰.
    { duration: '10s', target: 10  }, // 1000 → 10 VU 급감

    // ── 회복 구간 ─────────────────────────────────────────────────
    // 트래픽이 줄어든 뒤 latency가 "기준 latency"로 돌아오는지 확인.
    // 빠르게 돌아온다 → 시스템이 탄력적으로 회복
    // 느리게 돌아온다 → 내부 큐 또는 스레드 정리에 시간 필요
    { duration: '60s', target: 10  }, // 10 VU 유지 → 회복 여부 확인

    // ── 정리 ─────────────────────────────────────────────────────
    { duration: '10s', target: 0   }, // 0으로 감소
  ],
  // 총 실행 시간: 약 4분 10초

  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],

  thresholds: {
    // Spike 테스트는 순간적인 폭증을 허용하므로 기준을 가장 느슨하게 설정
    // 목적은 "통과"가 아닌 "스파이크 전후 비교"이기 때문
    http_req_failed:   ['rate<0.05'],   // 5xx < 5%
    http_req_duration: ['p(99)<2000'],  // P99 < 2초
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

  console.log('\n========== Phase 4: Spike Summary ==========');
  console.log('[ 전체 집계 — 구간별 비교는 Grafana 그래프 참고 ]');
  console.log(`총 요청 수      : ${reqs.values.count} 건`);
  console.log(`TPS (전체 평균) : ${reqs.values.rate.toFixed(1)} req/s`);
  console.log(`응답시간 avg    : ${fmt(dur.values.avg)} ms`);
  console.log(`응답시간 P50    : ${fmt(dur.values.med)} ms`);
  console.log(`응답시간 P95    : ${fmt(dur.values['p(95)'])} ms`);
  console.log(`응답시간 P99    : ${fmt(dur.values['p(99)'])} ms`);
  console.log(`응답시간 max    : ${fmt(dur.values.max)} ms`);
  console.log('--------------------------------------------');
  console.log(`발급 성공 (200) : ${data.metrics.coupon_success?.values.count ?? 0} 건`);
  console.log(`중복 신청 (409) : ${data.metrics.coupon_duplicate?.values.count ?? 0} 건`);
  console.log(`쿠폰 소진 (422) : ${data.metrics.coupon_exhausted?.values.count ?? 0} 건`);
  console.log(`서버 에러 (5xx) : ${data.metrics.coupon_error?.values.count ?? 0} 건`);
  console.log('--------------------------------------------');
  console.log('[ Grafana에서 확인할 포인트 ]');
  console.log('  1. 스파이크 순간(10s 급증) latency가 얼마나 올라갔는가?');
  console.log('  2. 스파이크 이후(10 VU 회복 구간) latency가 기준값으로 돌아왔는가?');
  console.log('  3. 스파이크 구간에서 5xx 에러가 발생했는가?');
  console.log('============================================\n');

  return {};
}

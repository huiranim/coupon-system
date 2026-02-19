/**
 * common.js — 공통 설정 및 유틸리티
 *
 * 모든 Phase 스크립트에서 import해서 사용한다.
 * k6는 ES Module 방식(import/export)을 지원한다.
 */

// 테스트 대상 서버 주소
// __ENV.BASE_URL 환경변수로 주입받고, 없으면 localhost 사용
// - Docker에서 실행 시: --env BASE_URL=http://host.docker.internal:8080
// - 로컬에서 실행 시: 기본값 http://localhost:8080
export const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';

/**
 * 충돌 없는 userId 생성 함수
 *
 * k6의 내장 변수:
 *   __VU   : 현재 VU의 번호 (1부터 시작, VU마다 고유)
 *   __ITER : 현재 VU가 default function을 몇 번째 실행하는지 (0부터 시작)
 *
 * 예시:
 *   VU=1, ITER=0 → userId = 1 * 100000 + 0 = 100000
 *   VU=1, ITER=1 → userId = 1 * 100000 + 1 = 100001
 *   VU=2, ITER=0 → userId = 2 * 100000 + 0 = 200000
 *
 * 이렇게 하면 VU와 반복 횟수의 조합이 항상 고유하므로
 * 동일 userId로 재신청(409 Conflict)이 발생하지 않는다.
 * → 쿠폰 소진(422) 전까지는 순수하게 처리량만 측정할 수 있다.
 */
export function uniqueUserId(vuId, iteration) {
  return vuId * 100000 + iteration;
}

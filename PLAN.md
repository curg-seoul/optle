# Plan — x402 기반 Solidity 가스 최적화 서비스

> 해카톤용 MVP. 최우선 목표는 **실제로 동작하는 데모**. 보안/성능/확장성은 후순위.
> 코드는 최대한 **간결하고 단순하게**. "동작하는 가장 작은 형태"를 먼저 만든다.

---

## 0. 진행 현황 & 개발 방침

### 개발 방침 (비용)
- **개발 중에는 실제 AI(Claude) API를 호출하지 않는다.** 추가 비용 0이 원칙.
  최적화는 **mock**(`apps/web/src/mockOptimizer.ts`)으로 대체하거나 수동으로 처리.
- **Claude Agent SDK / `claude` CLI 호출은 "배포" 결정 이후에만** 켠다.
  이 seam은 `mockOptimizer`가 잡고 있음 — 입력(Solidity)/출력(`OptimizeResult`) 모양을
  유지해, 나중에 mock 호출부만 실제 agent 호출로 교체하면 됨.

### 현재까지 완료
- ✅ **PoC (`poc/`)** — Agent SDK가 작업 디렉토리에서 `.sol` 편집 + `forge` 실행 +
  검증 루프를 무인 수행함을 1회 검증 완료 (`computeTotal` −5.2%, 동작 보존).
  *결과 검증됨 → 비용 절감 위해 개발 중 재실행 안 함.*
- ✅ **웹앱 (`apps/web/`)** — 단일 컨트랙트 입력 → mock 최적화 → 결과 렌더링.
  AI 호출 없음. 프론트(정적) + 백엔드(Express) 동작 확인.
- ⏳ **x402 서버 (`apps/server/`)** — 결제 게이트 구현 (테스트는 키/네트워크 없어 스킵).

> 참고: 아래 §2~§9의 "디렉토리 업로드(tar.gz) + COS + 비동기 잡" 플로우는 **최종 목표**다.
> 현재는 단순화를 위해 **단일 컨트랙트 코드 입력**부터 구현 중이며, 디렉토리/COS 플로우는
> 후속 단계로 둔다.

---

## 1. 프로젝트 개요

유저가 Solidity 프로젝트(디렉토리)를 업로드하면, x402 결제를 거친 뒤
AI agent가 가스 최적화를 적용하고, (옵션) foundry 테스트로 가스 절감을 검증한 다음,
최적화된 코드를 다운로드할 수 있게 해주는 서비스.

핵심 컴포넌트는 두 가지:

1. **x402 결제 웹 서버** — Tencent Cloud에 배포
2. **가스 최적화 AI Skill** — 웹 서버가 호출하는 AI agent가 사용하는 스킬

---

## 2. 전체 플로우

```
[유저]                         [웹 서버 (Tencent Cloud)]            [AI Agent + Skill]
  |                                    |                                   |
  | 1. 프로젝트 업로드 (tar.gz)        |                                   |
  |----------------------------------->|  COS에 저장                       |
  |              { jobId }             |  (cos://<bucket>/<jobId>/input.tar.gz)|
  |<-----------------------------------|                                   |
  |                                    |                                   |
  | 2. POST /optimize/:jobId           |                                   |
  |----------------------------------->|                                   |
  |   402 Payment Required (x402)      |                                   |
  |<-----------------------------------|                                   |
  |                                    |                                   |
  | 3. 결제 실행 후 재요청              |                                   |
  |   (X-PAYMENT 헤더 첨부)            |  facilitator로 결제 검증          |
  |----------------------------------->|  검증 OK → 백그라운드 잡 시작     |
  |              { jobId }             |---------------------------------->| 4. 최적화 수행
  |<-----------------------------------|                                   |    - 컨트랙트 분석
  |                                    |                                   |    - 가스 최적화 적용
  | (폴링) GET /status/:jobId          |                                   |    (4-1) forge test
  |----------------------------------->|                                   |    --gas-report 비교
  |   { status: running | done }       |<----------------------------------| 완료
  |<-----------------------------------|                                   |
  |                                    |                                   |
  | 5. GET /download/:jobId            |                                   |
  |----------------------------------->|  COS presigned URL 발급/리다이렉트 |
  |   최적화된 코드 (tar.gz)           |  (cos://.../<jobId>/output.tar.gz)|
  |<-----------------------------------|                                   |
```

---

## 3. 핵심 결정사항 (Decisions)

| 항목 | 결정 | 근거 |
|------|------|------|
| Tencent Cloud 배포 방식 | **CVM / Lighthouse(경량 응용 서버)** | foundry 빌드·테스트와 장시간 AI agent 실행은 serverless의 실행시간/환경 제약과 맞지 않음. 영속 디스크 + Docker/바이너리 자유롭게 사용 가능. |
| 스토리지 | **Tencent COS (Cloud Object Storage)** | 요구사항(클라우드 저장). 같은 Tencent Cloud 생태계라 CVM에서 SDK로 바로 접근. 업로드/다운로드는 tar.gz 단일 오브젝트로 저장해 단순화. 서버는 처리 시에만 임시로 로컬에 받아 작업(`/tmp/<jobId>/`)하고 결과를 다시 COS에 업로드. |
| 서버 스택 | **Node.js + TypeScript + Express** | x402 공식 미들웨어(`x402-express`)가 가장 성숙. 데모 안정성 우선. |
| 결제 프로토콜 | **x402** (`exact` scheme) | 요구사항. HTTP 402 네이티브. |
| 결제 네트워크 | **Mantle Sepolia (chainId 5003)** | x402 v1.2 `Network` enum에 Mantle이 없어 `x402-express`를 못 씀 → **체인 비종속 x402 게이트를 자체 구현**(`apps/server/src/x402.ts`)해 네트워크/자산/facilitator를 env로 주입. |
| 결제 코인 | **USDC (EIP-3009)** | x402 `exact` 스킴은 EIP-3009 `transferWithAuthorization`(gasless) 필요 → 정석 토큰은 USDC. 6 decimals, eip712 domain `{name:USDC, version:2}`. ⚠️ Mantle Sepolia의 실제 EIP-3009 USDC 주소는 빌드 시점 미확인 → env placeholder. |
| Facilitator | **Questflow (`facilitator.questflow.ai`)** | Mantle x402 지원을 발표한 멀티체인 facilitator. ⚠️ 공개 `/supported`는 현재 base/base-sepolia만 노출 → Mantle은 API 키 발급(Bearer) 후 활성화 필요할 수 있음. |
| AI 연동 | **Claude Agent SDK (TypeScript)** + **Skill(SKILL.md)** | agent가 작업 디렉토리에서 파일을 직접 편집하고 `forge`를 실행할 수 있어 "최적화 + 검증" 워크플로에 최적. 모델은 기본 `claude-sonnet-4-6`, 복잡할 때 `claude-opus-4-8`. **개발 중에는 mock으로 대체(§0), 배포 시 활성화.** |
| 모노레포 도구 | **앱별 독립 npm 프로젝트 (현재)** | 워크스페이스 플러밍보다 단순. 앱이 늘면 pnpm workspace로 승격 검토. |
| 결제 대상(현재) | **단일 컨트랙트 코드(JSON) → 최적화** | 디렉토리/tar.gz/COS 플로우 전에 가장 단순한 결제 게이트부터 구현. |
| 잡 처리 | **결제 후 백그라운드 비동기 + 상태 폴링** | 최적화+테스트는 수 분 소요 가능 → 동기 HTTP 타임아웃 리스크 회피. 잡 상태는 in-memory Map. |
| 검증(4-1) | **Foundry(`forge test --gas-report`) 만 지원** | 요구사항. 비-foundry 프로젝트는 검증 스킵하고 최적화만 수행. |
| 결과 포맷 | **tar.gz** | 업로드 포맷과 일치, 압축률·호환성 무난. |

---

## 4. 모노레포 구조

현재는 **앱별 독립 npm 프로젝트**(워크스페이스 미사용). 아래는 실제 현황(✅) + 계획(⏳/계획).

```
mantle-hackathon/
├── PLAN.md
├── .gitignore
├── skills/
│   └── gas-optimizer/
│       └── SKILL.md            # ✅ 가스 최적화 스킬 (배포 시 agent가 로드)
├── poc/                        # ✅ Agent SDK PoC (검증 완료, 개발 중 재실행 안 함)
│   ├── run.ts                  #    sample 복사 → 전 가스 → agent → 후 가스 → diff
│   └── sample/                 #    의존성 없는 foundry 샘플(오프라인 동작)
├── apps/
│   ├── web/                    # ✅ 데모 웹앱 (단일 컨트랙트, mock 최적화)
│   │   ├── src/
│   │   │   ├── server.ts       #    Express: 정적 서빙 + POST /api/optimize(mock)
│   │   │   └── mockOptimizer.ts#    AI seam — 배포 시 실제 agent로 교체
│   │   └── public/             #    index.html / app.js / style.css
│   └── server/                 # ⏳ x402 결제 게이트 서버
│       ├── src/
│       │   ├── index.ts        #    Express 앱 + 라우트
│       │   ├── config.ts       #    .env 로딩 (placeholder)
│       │   ├── x402.ts         #    x402 미들웨어 설정
│       │   └── optimize.ts     #    최적화 호출 (현재 mock)
│       ├── .env.example
│       └── package.json
├── packages/                   # (계획) 공유 타입/옵티마이저
└── scripts/                    # (계획) demo-client 등
```

> §2~§9의 COS/디렉토리/잡(`cos.ts`/`jobs.ts`) 컴포넌트는 단일 컨트랙트 플로우가 끝난 뒤 추가.

---

## 5. 컴포넌트 상세

### 5.1 웹 서버 (`apps/server`)

#### API 엔드포인트

| Method | Path | 설명 | x402 보호 |
|--------|------|------|:---:|
| `POST` | `/upload` | tar.gz 업로드 → COS `<jobId>/input.tar.gz`에 저장, `jobId` 반환 | ✗ |
| `POST` | `/optimize/:jobId` | 결제 검증 후 백그라운드 최적화 잡 시작 | ✓ |
| `GET`  | `/status/:jobId` | `{ status: "pending"｜"running"｜"done"｜"error", gasReport? }` | ✗ |
| `GET`  | `/download/:jobId` | COS `<jobId>/output.tar.gz`의 presigned URL로 302 리다이렉트 | ✗ |

> 인증 없음. 용량 제한/레이트리밋 없음 (MVP).
> `jobId`는 랜덤 UUID. 추측 어려운 정도면 충분 (보안 후순위).

#### x402 결제 설정 (`x402.ts`)

- `x402-express`의 `paymentMiddleware` 사용
- 보호 라우트: `POST /optimize/:jobId`
- 결제 요구사항: `payTo`(우리 지갑 주소), `amount`(소액, 예: 테스트 USDC 0.01), `network: mantle-sepolia`, `scheme: exact`
- facilitator: 자체 호스팅 or 사용 가능한 테스트넷 facilitator URL (env로 주입)
- 미결제 요청 → 자동 `402` + 결제 요구 JSON 반환
- `X-PAYMENT` 헤더 첨부 재요청 → facilitator 검증 → 통과 시 핸들러 진입

#### 잡 처리 (`jobs.ts`)

- `Map<jobId, { status, error?, gasReport? }>` 단순 in-memory 스토어 (서버 재시작 시 휘발 — 데모 OK)
- `/optimize` 핸들러는 결제 검증 직후 `status="running"`으로 두고 즉시 `jobId` 반환, `optimizeJob(jobId)`를 백그라운드로 실행(await 안 함)
- 완료 시 `output.tar.gz` 생성 + `status="done"` + 가스 리포트 저장

### 5.2 가스 최적화 (`optimize.ts` + `skills/gas-optimizer`)

#### 동작

1. COS에서 `<jobId>/input.tar.gz`를 임시 작업 디렉토리(`/tmp/<jobId>/`)로 받아 해제
2. 해당 디렉토리를 작업 디렉토리로 Claude Agent SDK 실행, `gas-optimizer` 스킬 로드 + 도구(파일 읽기/편집, bash) 허용
3. agent가 스킬 지침대로:
   - 컨트랙트(`*.sol`) 탐색·분석
   - 기능 동작을 바꾸지 않는 선에서 가스 최적화 적용
   - (foundry 프로젝트면) `forge test --gas-report`를 최적화 전/후로 실행해 비교
   - 변경 요약 작성 (`OPTIMIZATION_REPORT.md`)
4. 결과 디렉토리를 `output.tar.gz`로 압축 → COS `<jobId>/output.tar.gz`에 업로드 → 임시 디렉토리 정리

#### `SKILL.md`에 담을 가스 최적화 기법 (체크리스트)

- 스토리지 슬롯 패킹(struct/상태변수 타입 재배치)
- `constant` / `immutable` 적극 사용
- 반복 SLOAD를 메모리 캐싱으로 제거
- 안전한 산술에 `unchecked { }` 적용
- external 함수 인자 `memory` → `calldata`
- `require(문자열)` → custom error
- `i++` → `++i`, 루프 길이 캐싱
- 짧은 조건 우선 배치(short-circuit)
- 불필요한 초기화(`uint x = 0`) 제거
- 이벤트/함수 visibility 정리(`public`→`external`)

> 원칙: **동작·인터페이스를 바꾸지 않는 변경만**. 컴파일 실패/테스트 실패 시 해당 변경 롤백.

#### 검증(4-1)

- foundry 감지: 루트에 `foundry.toml` 존재 여부
- 있으면: 최적화 전 `forge test --gas-report` 스냅샷 → 최적화 후 재실행 → 가스 diff를 `gasReport`로 저장
- 없으면: 검증 스킵, 최적화만 수행 (상태에 `verified: false` 표기)

---

## 6. 환경 변수 (`.env.example`)

```
# 서버
PORT=8080
WORK_DIR=/tmp                   # 처리 중 임시 작업 디렉토리

# Tencent COS (Cloud Object Storage)
COS_SECRET_ID=...
COS_SECRET_KEY=...
COS_BUCKET=...                 # 예: mantle-hackathon-1250000000
COS_REGION=ap-guangzhou

# x402 (Mantle Sepolia) — 실제 적용본은 apps/server/.env.example 참고
PAYMENT_NETWORK=mantle-sepolia
PAYMENT_CHAIN_ID=5003
PAY_TO_ADDRESS=0x...            # 결제 수령 지갑
PAYMENT_ASSET_ADDRESS=0x...     # Mantle Sepolia USDC (EIP-3009, 미확인 → 채워야 함)
PAYMENT_PRICE=0.01
FACILITATOR_URL=https://facilitator.questflow.ai
FACILITATOR_API_KEY=           # Questflow Bearer 키 (Mantle 활성화 필요)

# AI
ANTHROPIC_API_KEY=sk-ant-...
CLAUDE_MODEL=claude-sonnet-4-6
```

---

## 7. 개발 마일스톤 (해카톤 순서)

> 각 단계는 "독립적으로 데모 가능한 상태"를 만든다. 막히면 다음 단계 스텁으로 진행.

- ✅ **M2 — AI 최적화 코어 (PoC)** — Agent SDK + `gas-optimizer` 스킬로 샘플 최적화 성공 검증 (`poc/`).
- ✅ **M-web — mock 데모 웹앱** — 단일 컨트랙트 입력 → mock 최적화 → 결과 렌더링 (`apps/web/`).
- ✅ **M4 — x402 결제 게이트 (Mantle Sepolia)** — 자체 x402 게이트로 `/api/optimize` 보호. 미결제 → 402(Mantle 파라미터) 로컬 검증 완료. verify/settle은 facilitator 위임(키 없어 라이브는 미검증).
- ⬜ **M-wire — 프론트 ↔ x402 서버 연결** — 웹앱이 결제 후 서버 최적화 호출.
- ⬜ **M1 — 디렉토리 업로드 + COS** — tar.gz 업로드/다운로드, presigned URL.
- ⬜ **M3 — 비동기 잡** — `/optimize`가 백그라운드 잡 트리거, `/status` 폴링.
- ⬜ **M5 — foundry 검증** — `forge test --gas-report` 전/후 비교 노출 (배포 시 실제 agent로).
- ⬜ **M6 — Tencent Cloud 배포 + 데모 스크립트.**

각 마일스톤이 끝나면 커밋. 데모 직전 상태를 항상 유지.

---

## 8. 데모 시나리오

1. 일부러 가스 비효율적인 샘플 foundry 프로젝트(`scripts/sample-contract`) 준비
2. `demo-client.ts` 실행:
   - tar.gz로 묶어 `/upload` → `jobId`
   - `/optimize/:jobId` → **402 응답 확인** (결제 요구 JSON 출력)
   - 테스트넷 지갑으로 결제 → `X-PAYMENT` 첨부 재요청
   - `/status` 폴링하며 진행 표시
   - `done` 되면 `/download` → 압축 해제
3. **before/after 가스 리포트 diff**와 `OPTIMIZATION_REPORT.md`를 화면에 출력 → "가스가 N% 줄었다" 증명

---

## 9. 리스크 & 대응

| 리스크 | 대응 |
|------|------|
| **x402 npm이 Mantle 미지원** (확인됨) | `x402-express` 강타입 enum 회피 위해 **자체 x402 게이트 구현 완료**(`x402.ts`). 402 페이로드는 Mantle Sepolia 파라미터로 정상 생성됨(로컬 검증). verify/settle은 facilitator로 위임. |
| **Mantle 결제의 미해결 3가지** (배포 전 확정 필요) | ① Questflow facilitator의 Mantle 활성화(API 키 발급 + `/supported`에서 정확한 network 식별자 확인: `mantle-sepolia` vs `eip155:5003`), ② Mantle Sepolia의 **실제 EIP-3009 USDC 주소** 확보(없으면 테스트용 EIP-3009 토큰 배포), ③ 결제 지갑(payTo)·테스트 자금. 모두 env로 주입만 하면 됨. |
| AI 최적화가 컨트랙트를 깨뜨림 | 스킬에 "컴파일/테스트 실패 시 변경 롤백" 강제. 검증 단계가 안전망. |
| foundry 실행 환경 부재 | 배포 서버 이미지에 `foundryup`으로 forge 사전 설치. Docker화 고려. |
| AI 실행 시간 길어 데모 지연 | 비동기 잡 + 폴링. 샘플 컨트랙트는 작게 유지. |
| 서버 재시작 시 잡 상태 휘발 | 데모에서는 무시. 파일 자체는 COS에 영속되므로 `output.tar.gz` 존재 여부로 완료 판단 가능. |
| COS 자격증명/CORS/권한 설정 | M1에서 가장 먼저 검증. presigned URL 만료시간 넉넉히(예: 1h). 버킷은 데모용 단일 버킷. |

---

## 10. 비범위 (Out of Scope, MVP)

- 인증/인가, 사용자 계정
- 용량 제한, 레이트리밋, 큐잉
- 멀티 테넌시/동시성 제어
- Hardhat 등 비-foundry 빌드시스템 검증
- 영속 DB (잡 상태는 in-memory, 파일은 COS로 충분)
- 결제 환불/재시도 로직

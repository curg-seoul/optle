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
- ✅ **웹앱 (`apps/web/`)** — Vite + React + **wagmi + viem + RainbowKit** 지갑 연결 UI
  (Mantle Sepolia). 단일 컨트랙트 입력 → x402 서버 호출(402 시 EIP-3009 서명·재요청)
  → 결과 렌더링. `vite build` 통과 검증.
- ✅ **x402 서버 (`apps/server/`)** — Mantle Sepolia 결제 게이트(자체 x402 구현).
  미결제 → 402 로컬 검증, `PAYMENT_MODE=bypass`로 facilitator 없이 데모 가능.

> **v2 (진행 중) — §11 참조.** 단일 컨트랙트 문자열 입력에서 **.zip 프로젝트 업로드 →
> COS 저장 → 격리 docker 컨테이너에서 최적화 루프 → .zip 다운로드(presigned)**로 확장한다.
> 가격은 프로젝트 크기에 따라 3-tier로 동적 책정. 최적화 엔진은 **mock-first**(파이프라인을
> 먼저 완성하고 Claude Agent SDK는 seam만 남겨 교체). 구체 설계·결정·Tencent 작업은 §11.

### 로컬 실행 (결제 없이 데모)
```bash
# 1) x402 서버 (결제 우회 모드)
cd apps/server && cp .env.example .env && PAYMENT_MODE=bypass npm start   # :8080
# 2) 프론트엔드 (다른 터미널) — /api 는 :8080 으로 프록시됨
cd apps/web && npm run dev                                                # :5173
```
> `PAYMENT_MODE=bypass`면 지갑 없이도 최적화(mock)까지 전체 UX 확인 가능.
> 실제 결제 플로우는 `enforce`(기본) + facilitator 키 + Mantle USDC 주소가 있어야 동작.
> 설치 시 네이티브 빌드(`utf-8-validate`/`bufferutil`) 실패하면 `npm install --ignore-scripts`.

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
| 프론트엔드/지갑 | **Vite + React + wagmi + viem + RainbowKit** | EVM 지갑 연결의 표준·최다 추천 스택. RainbowKit `ConnectButton`이 네트워크 전환/오류 UI까지 처리. 결제 서명(EIP-3009)은 viem `signTypedData`로 직접 구성(체인 비종속 → Mantle 동작). |
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
│   ├── web/                    # ✅ 프론트엔드 (Vite + React + wagmi/viem/RainbowKit)
│   │   ├── src/
│   │   │   ├── main.tsx        #    Wagmi/QueryClient/RainbowKit providers
│   │   │   ├── wagmi.ts        #    Mantle Sepolia 체인 + getDefaultConfig
│   │   │   ├── x402.ts         #    payAndOptimize: 402→EIP-3009 서명→재요청
│   │   │   └── App.tsx         #    ConnectButton + 입력 + 결과 UI
│   │   ├── vite.config.ts      #    /api·/health → :8080 프록시
│   │   └── .env.example        #    VITE_WALLETCONNECT_PROJECT_ID (선택)
│   └── server/                 # ✅ x402 결제 게이트 서버
│       ├── src/
│       │   ├── index.ts        #    Express + CORS + /health + 게이트된 /api/optimize
│       │   ├── config.ts       #    .env 로딩 (Mantle/facilitator/PAYMENT_MODE)
│       │   ├── x402.ts         #    자체 x402 게이트 (402 생성 + verify/settle)
│       │   └── optimize.ts     #    최적화 호출 (현재 mock = AI seam)
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
- ✅ **M-wire — 프론트 ↔ x402 서버 연결** — wagmi/RainbowKit 지갑 연결 + 402 시 EIP-3009 서명·재요청. 빌드 검증 완료. (라이브 결제는 facilitator/토큰 미확정으로 미검증.)
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

---

## 11. v2 — 프로젝트 업로드 + 격리 실행 + 동적 가격 (진행 중)

§2~§9의 최종 목표를 실제 구현한다. 단일 컨트랙트 문자열 → **.zip 프로젝트 업로드 → COS →
격리 docker 컨테이너에서 최적화/검증 루프 → .zip 다운로드**. 포맷은 tar.gz가 아니라 **.zip**.

### 11.1 플로우

```
[브라우저]                 [server (CVM, compose)]                 [runner 컨테이너]
  | 1. .zip 드래그앤드롭                                                   |
  |---- POST /upload (multipart) ----->| COS PUT jobs/<id>/input.zip       |
  |                                     | .zip 펼쳐 .sol 분석 → tier·가격   |
  |<--- { jobId, tier, priceUsd } ------|   in-memory job 생성              |
  |                                     |                                   |
  | 2. POST /optimize/:jobId            |                                   |
  |<--- 402 (가격 = job.priceUsd) ------| (동적 가격 x402 게이트)           |
  | 3. EIP-3009 서명 후 재요청          | facilitator verify/settle         |
  |---- X-PAYMENT --------------------->| 결제 OK → 잡 enqueue, 즉시 응답   |
  |                                     | COS GET input.zip → /jobs/<id>/work
  |                                     | docker run --network none ------->| 4. gas snapshot
  |  (폴링) GET /status/:jobId          |   -v <host>/<id>/work:/work       |    → optimize(mock)
  |<--- { status, stage, savedPct? } ---|   optle-runner                    |    → forge 검증
  |                                     | 종료코드/리포트 수거              |    → re-measure
  |                                     | /work → output.zip → COS PUT      |<---|  → REPORT.md
  | 5. GET /download/:jobId             |                                   |
  |<--- { url: presigned GET } ---------| COS presigned (1h)                |
```

### 11.2 v2 결정사항

| 항목 | 결정 | 근거 |
|------|------|------|
| 업로드 포맷 | **.zip 전용** (드래그앤드롭, Netlify-drop류 UX) | 폴더 업로드보다 단순·호환. 사용자 승인. |
| 업로드 경로 | **서버 경유** (브라우저→server→COS) | Netlify same-origin 프록시 그대로 활용 → COS CORS 불필요. 업로드 즉시 서버가 .sol 분석해 가격 산정. |
| 다운로드 경로 | **COS presigned GET URL** (1h) | 큰 결과물을 서버 안 거치고 브라우저가 직접 다운로드. 앵커 네비게이션이라 CORS 불필요. |
| 스토리지 | **Tencent COS, region `ap-singapore`** | CVM과 동일 리전(레이턴시·egress). `jobs/<id>/input.zip`, `jobs/<id>/output.zip`. |
| 격리 실행 | **server가 docker 소켓으로 형제 runner 컨테이너 spawn** | 업로드된 미신뢰 코드를 호스트가 아닌 일회용 컨테이너에서 실행. `--rm --network none --memory/--cpus/--pids` 제한 + 타임아웃. server 이미지에 docker CLI. |
| 컨테이너 I/O | **호스트 바인드 디렉토리 공유** (`HOST_JOBS_DIR`) | server(컨테이너)가 `docker run -v ${HOST_JOBS_DIR}/<id>/work:/work` 하려면 호스트 경로가 필요 → compose에서 동일 호스트 경로를 server에 `/jobs`로 마운트하고 `HOST_JOBS_DIR` env로 매핑. runner는 오프라인(`--network none`)으로 COS 접근 불필요(I/O는 server가 담당). |
| 가격 책정 | **3-tier 동적, `max(.sol 파일수, .sol 총 바이트)` 기준** | 업로드 시 .zip 내 `*.sol`(test/script/lib 제외) 수와 합산 용량으로 tier 결정 → 402 챌린지에 반영. |
| 최적화 엔진 | **mock-first** (regex 변환 + 선택적 forge 스냅샷) | PLAN 원칙(개발 중 AI 비용 0) 유지. 엔진 함수가 seam → 나중에 Claude Agent SDK로 교체. |
| 잡 상태 | **in-memory Map + stage 필드** | `pending→running(queued/downloading/optimizing/verifying/packaging)→done|error`. 폴링. 재시작 시 휘발(데모 OK). |

### 11.3 가격 tier

업로드된 .zip에서 `test/`·`script/`·`lib/` 밖의 `*.sol`만 집계. **파일수·용량 중 더 높은 tier** 적용.

| Tier | 조건 | 가격(USD) |
|------|------|----------|
| Small | ≤ 3 files **AND** ≤ 30 KB | $0.50 |
| Medium | ≤ 20 files **AND** ≤ 200 KB | $3.00 |
| Large | 그 이상 (DeFi급) | $10.00 |

> 서버 `PAYMENT_PRICE`(고정값)는 더 이상 결제액을 직접 결정하지 않고, tier 가격이 jobId별로
> x402 게이트에 주입된다. USDC 6 decimals로 base units 환산.

### 11.4 컴포넌트 (v2 추가)

```
apps/
├── server/src/
│   ├── cos.ts          # COS 클라이언트 (put/get/presigned) — cos-nodejs-sdk-v5
│   ├── pricing.ts      # .zip → .sol 분석 → tier·priceUsd·amountBaseUnits
│   ├── jobs.ts         # in-memory 잡 스토어 + runner 컨테이너 오케스트레이션
│   └── index.ts        # /upload, /optimize/:jobId(게이트), /status, /download
├── runner/             # 격리 실행 이미지 (foundry + node + skill + entrypoint)
│   ├── Dockerfile
│   └── run.mjs         # /work에서 snapshot→optimize(mock)→forge 검증→REPORT.md
└── web/src/            # .zip 드래그앤드롭 + 업로드→결제→폴링→다운로드 UX
```

### 11.5 ⚠️ Tencent Cloud에서 직접 해야 할 것

1. **COS 버킷 생성** — region `ap-singapore`(CVM과 동일). 버킷명 예: `optle-jobs-12500xxxxx`.
2. **API 키 발급** — 콘솔 → 访问管理(CAM) → API 키. `SecretId`/`SecretKey` 확보(데모용 메인 키 OK).
   → CVM의 `apps/server/.env`에 `COS_*`로 넣음. CORS 설정은 **불필요**(업로드 서버경유, 다운로드 네비게이션).
3. (CVM) compose에 호스트 잡 디렉토리(`/srv/optle-jobs`)와 docker 소켓 마운트 추가 — 코드로 제공.


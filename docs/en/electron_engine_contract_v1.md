# Electron Engine Contract v1 (CLI Bridge Truth Source)

## 1. 목적과 범위

이 문서는 Electron Main Process와 MinerU CLI 사이의 실행 계약(Contract)을 정의한다.

- 대상: 데스크톱 래퍼(MVP)에서 실행되는 `mineru` CLI 브리지
- 목적: 입력/출력, 진행 이벤트, 종료 코드, 오류 코드의 결정론적 동작 고정
- 비목적: HTTP server 모드 기본화(금지), 엔진 내부 알고리즘 변경

## 2. 규범 키워드

`MUST`, `MUST NOT`, `SHOULD`, `MAY`는 RFC 2119 의미로 해석한다.

## 3. 실행 모델

- 실행 방식: 로컬 프로세스 실행(`spawn`) 기반 CLI bridge
- 기본 백엔드: MVP에서 `backend` 기본값은 **반드시 `pipeline`**
- `method` 기본값: `auto`
- 출력 기준 파일: `result.json` (bridge가 생성하는 실행 결과 매니페스트)
- 진행 전달: JSON Lines(JSONL) 표준 이벤트 스트림

## 4. 입력 계약 (EngineRequest v1)

### 4.1 필수 입력

| 필드 | 타입 | 필수 | 기본값 | 설명 |
|---|---|---|---|---|
| `inputPath` | string | Y | - | 입력 파일 또는 디렉터리 경로 |
| `outputDir` | string | Y | - | 결과 출력 루트 경로 |

### 4.2 선택 입력

| 필드 | 타입 | 필수 | 기본값 | 설명 |
|---|---|---|---|---|
| `jobId` | string | N | bridge 생성 UUID | 실행 상관관계 ID |
| `backend` | enum | N | `pipeline` | MVP 기본 백엔드. 다른 값은 명시 opt-in일 때만 허용 |
| `method` | enum(`auto`,`txt`,`ocr`) | N | `auto` | 파싱 방법 |
| `lang` | string | N | `ch` | OCR 보조 언어 |
| `start` | integer | N | `0` | 시작 페이지(0-based) |
| `end` | integer/null | N | `null` | 종료 페이지(0-based, 포함) |
| `formula` | boolean | N | `true` | 수식 파싱 |
| `table` | boolean | N | `true` | 표 파싱 |
| `device` | string/null | N | `null` | 디바이스 힌트 |
| `vram` | integer/null | N | `null` | VRAM 상한 |
| `source` | enum | N | `huggingface` | 모델 소스 |
| `timeoutMs` | integer/null | N | `null` | 전체 작업 타임아웃 |

### 4.3 검증 규칙

- `inputPath`는 존재해야 한다.
- `outputDir`는 생성 가능(쓰기 가능)해야 한다.
- `start <= end` (둘 다 주어진 경우)여야 한다.
- `backend`가 미지정이면 `pipeline`을 강제한다.

## 5. CLI 옵션 매핑

| EngineRequest | CLI Option |
|---|---|
| `inputPath` | `--input` |
| `outputDir` | `--output` |
| `jobId` | `--job-id` |
| `backend` | `--backend` |
| `method` | `--method` |
| `lang` | `--lang` |
| `start` | `--start` |
| `end` | `--end` |
| `formula` | `--formula` |
| `table` | `--table` |
| `device` | `--device` |
| `vram` | `--vram` |
| `source` | `--source` |
| `timeoutMs` | `--timeout-ms` |

참고: 현재 upstream `mineru` CLI 기본 backend는 `hybrid-auto-engine`이지만, 데스크톱 MVP 계약은 이를 덮어써 `pipeline`을 기본값으로 고정한다.

## 6. 환경 변수 처리 원칙

CLI에서 `MINERU_` 환경 변수(예: `MINERU_DEVICE_MODE`, `MINERU_VIRTUAL_VRAM_SIZE`, `MINERU_MODEL_SOURCE`)가 사용될 수 있다. bridge는 다음을 따른다.

- 명시적 요청 값이 있으면 해당 CLI option을 우선 전달한다.
- 명시적 요청 값이 없으면 계약 기본값을 사용한다(`backend=pipeline`, `method=auto`).
- 환경 변수의 존재 여부는 동작 보조 수단이며, 계약의 성공/실패 판정 근거가 되어서는 안 된다.

## 7. JSONL 진행 이벤트 스키마

진행 이벤트는 `application/x-ndjson` 형식으로 1줄 1 JSON object를 출력해야 한다.

### 7.1 Event 필드 정의

| 필드 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `type` | enum | Y | `job.started`, `job.progress`, `job.succeeded`, `job.failed`, `job.cancelled` |
| `ts` | string(ISO-8601) | Y | 이벤트 발생 시각(UTC 권장) |
| `jobId` | string | Y | 요청과 동일한 job ID |
| `stage` | string | Y | `queued`, `starting`, `running`, `finalizing`, `completed`, `failed`, `cancelled` |
| `progress` | number | Y | `0..100` 범위, 단조 증가 권장 |
| `message` | string | N | 사용자 친화 메시지 |
| `errorCode` | string/null | N | 실패/취소 시 안정 코드 |
| `payload` | object | N | 확장 가능한 구조화 데이터 |

### 7.2 JSONL 예시

```json
{"type":"job.started","ts":"2026-02-25T03:10:00.123Z","jobId":"job_001","stage":"starting","progress":0,"message":"Engine process started","errorCode":null,"payload":{"backend":"pipeline","method":"auto"}}
{"type":"job.progress","ts":"2026-02-25T03:10:05.987Z","jobId":"job_001","stage":"running","progress":42,"message":"Parsing pages","errorCode":null,"payload":{"currentPage":21,"totalPages":50}}
{"type":"job.succeeded","ts":"2026-02-25T03:10:18.444Z","jobId":"job_001","stage":"completed","progress":100,"message":"Completed","errorCode":null,"payload":{"resultPath":"/tmp/out/result.json"}}
```

실패 예시:

```json
{"type":"job.failed","ts":"2026-02-25T03:11:18.444Z","jobId":"job_002","stage":"failed","progress":100,"message":"Engine exited with error","errorCode":"E_ENGINE_FAILED","payload":{"exitCode":1}}
```

## 8. result.json 매니페스트 스키마

bridge는 실행 종료 시 `outputDir/result.json`을 반드시 기록해야 한다.

### 8.1 필드 정의

| 필드 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `status` | enum | Y | `succeeded`, `failed`, `cancelled`, `timeout` |
| `errorCode` | string/null | Y | 성공 시 `null`, 실패 시 안정 코드 |
| `outputDir` | string | Y | 출력 루트 경로 |
| `artifacts` | object | Y | 산출물 경로 모음 |
| `engineVersion` | string | Y | `mineru --version` 기반 버전 |
| `backend` | string | Y | 실제 실행 backend |
| `method` | string | Y | 실제 실행 method |
| `timings` | object | Y | 시간 정보(ms) |

`artifacts` 권장 키:

- `markdown`: `*.md` 목록
- `contentList`: `*_content_list.json` 목록
- `middleJson`: `*_middle.json` 목록
- `modelJson`: `*_model.json` 목록

### 8.2 성공 예시

```json
{
  "status": "succeeded",
  "errorCode": null,
  "outputDir": "/tmp/out",
  "artifacts": {
    "markdown": ["/tmp/out/demo/auto/demo.md"],
    "contentList": ["/tmp/out/demo/auto/demo_content_list.json"],
    "middleJson": ["/tmp/out/demo/auto/demo_middle.json"],
    "modelJson": ["/tmp/out/demo/auto/demo_model.json"]
  },
  "engineVersion": "2.7.6",
  "backend": "pipeline",
  "method": "auto",
  "timings": {
    "startedAt": "2026-02-25T03:10:00.123Z",
    "endedAt": "2026-02-25T03:10:18.444Z",
    "durationMs": 18321
  }
}
```

### 8.3 실패 예시

```json
{
  "status": "failed",
  "errorCode": "E_OUTPUT_UNWRITABLE",
  "outputDir": "/readonly/out",
  "artifacts": {
    "markdown": [],
    "contentList": [],
    "middleJson": [],
    "modelJson": []
  },
  "engineVersion": "2.7.6",
  "backend": "pipeline",
  "method": "auto",
  "timings": {
    "startedAt": "2026-02-25T03:20:00.000Z",
    "endedAt": "2026-02-25T03:20:00.210Z",
    "durationMs": 210
  }
}
```

## 9. 종료 코드와 errorCode 결정 규칙

### 9.1 종료 코드 (process exit code)

| Exit Code | 의미 |
|---|---|
| `0` | 성공 (`status=succeeded`) |
| `1` | 일반 실패 (`status=failed`) |
| `2` | 잘못된 입력 (`status=failed`, `E_INVALID_INPUT`) |
| `3` | 출력 경로 기록 불가 (`status=failed`, `E_OUTPUT_UNWRITABLE`) |
| `4` | 사용자 취소 (`status=cancelled`, `E_CANCELLED`) |
| `5` | 타임아웃 (`status=timeout`, `E_TIMEOUT`) |

### 9.2 안정 errorCode 테이블

아래 코드는 v1에서 stable contract로 고정한다.

| errorCode | 의미 |
|---|---|
| `E_INVALID_INPUT` | 입력 경로/옵션 검증 실패 |
| `E_ENGINE_FAILED` | 엔진 실행 실패(내부 예외/비정상 종료 포함) |
| `E_CANCELLED` | 사용자 또는 상위 계층 취소 요청으로 중단 |
| `E_TIMEOUT` | timeoutMs 초과로 강제 종료 |
| `E_OUTPUT_UNWRITABLE` | outputDir 생성/쓰기 불가 |

`status=succeeded`에서는 `errorCode`가 반드시 `null`이어야 한다.

## 10. 취소(Cancellation)와 타임아웃(Timeout) 의미론

### 10.1 Cancellation

- 사용자가 취소를 요청하면 bridge는 자식 프로세스 종료 시그널을 보낸다.
- 취소 경로는 최종 상태를 `status=cancelled`, `errorCode=E_CANCELLED`, exit code `4`로 고정한다.
- 취소 후에도 `result.json`은 반드시 작성한다.

### 10.2 Timeout

- wrapper는 `timeoutMs`를 `--timeout-ms`로 전달해 CLI 레벨 타임아웃을 강제한다.
- 브리지의 kill-tree는 에스컬레이션 경로(프로세스 정리/강제 종료)로 동작한다.
- 타임아웃 경로는 `status=timeout`, `errorCode=E_TIMEOUT`, exit code `5`로 고정한다.
- 타임아웃 후에도 `result.json`은 반드시 작성한다.

## 11. 로그/표준에러 비의존성 규칙

정확성(correctness)은 stderr/stdout 로그 문자열 파싱에 의존하면 안 된다.

- 성공/실패 판정의 진실 원천(truth source)은 `exit code` + `result.json`이다.
- 진행/상태 표현의 진실 원천은 JSONL 구조화 이벤트다.
- 로그 텍스트는 디버깅 용도로만 사용하며 계약 판정 조건에서 제외한다.

## 12. 호환성 및 v1 변경 정책

- v1의 필수 필드/안정 errorCode/exit code 의미는 하위 호환 없이 변경할 수 없다.
- 새 필드는 `payload` 또는 선택 필드로만 확장한다.
- 파괴적 변경은 `v2`로 승격한다.

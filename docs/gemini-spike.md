# Gemini CLI spike (gemini-cli 0.62.0)

deck 의 세 번째 엔진. **명시 선택 전용** — 엔진 선택에서 "Gemini" 를 고를 때만 쓰이고, 자동(모델 자동·엔진 자동)은 절대 Gemini 로 열지 않는다.

## 설치

`npm i -g @google/gemini-cli --prefix ~/.local` → `~/.local/bin/gemini` (sudo 없음).
deck 은 `DECK_GEMINI_BIN` → `PATH` → `~/.local/bin/gemini` 순으로 찾는다. 없으면 Gemini 선택지 자체가 숨겨진다.

## 로그인 (사용자가 직접 — deck 은 로그인하지 않는다)

계정은 `g1`, `g2` 두 칸. 계정마다 홈을 분리한다(`GEMINI_CLI_HOME`).

```sh
# API 키가 있으면 OAuth 대신 키를 쓰므로 먼저 지운다
unset GEMINI_API_KEY GOOGLE_API_KEY GOOGLE_GENAI_USE_VERTEXAI

mkdir -p ~/.config/deck/gemini/g1
GEMINI_CLI_HOME=~/.config/deck/gemini/g1 gemini
#   → "Login with Google" 선택 → 브라우저에서 계정 1 로 로그인 → /quit

mkdir -p ~/.config/deck/gemini/g2
GEMINI_CLI_HOME=~/.config/deck/gemini/g2 gemini
#   → "Login with Google" → 계정 2 → /quit
```

로그인 판정: `~/.config/deck/gemini/<acct>/.gemini/oauth_creds.json` **존재 여부만** 본다(deck 은 이 파일을 열지 않는다).
`GEMINI_FORCE_ENCRYPTED_FILE_STORAGE` 를 켜면 자격이 키체인 공유 항목으로 가서 두 계정이 충돌하므로 쓰지 말 것 — deck 은 자식 env 에서 이 변수를 지운다.
로그인 후 deck 재접속(새로고침) 시 "Gemini · 로그인 필요" 가 활성 "Gemini" 로 바뀐다.

## 동작하는 것

| 항목 | 방식 |
|---|---|
| 헤드리스 | stdin 이 TTY 가 아니면 헤드리스. deck 은 프롬프트를 **stdin** 으로만 넘긴다(argv 에 넣지 않음). |
| 스트림 | `-o stream-json`: `init{session_id,model}` · `message{role,content,delta}` · `tool_use` · `tool_result` · `error{severity,message}` · `result{status,error?,stats}` |
| 이어하기 | `--resume <uuid>` — 대화는 `$GEMINI_CLI_HOME/.gemini/tmp/<project>/chats` 에 있어 **같은 cwd·같은 계정**이어야 한다. deck 은 세션을 계정에 고정하고, UUID 가 아닌 id 는 거부한다. |
| 신뢰 | `--skip-trust` (미신뢰 폴더에서 헤드리스가 실패하므로) |
| 권한 | 읽기 전용 → `--approval-mode plan`, 파일 편집 허용 → `auto_edit`. 헤드리스는 확인이 필요한 도구를 거부한다. |
| 샌드박스 | macOS: `-s` + `SEATBELT_PROFILE=permissive-open` (sandbox-exec) — 쓰기는 작업 폴더·tmp/cache·`~/.gemini` 만. |
| 인증 | `GOOGLE_GENAI_USE_GCA=true` 로 OAuth 강제, API 키/Vertex/ADC/베이스 URL 변수는 전부 제거. |
| 사용량 | `result.stats` 의 `input_tokens`(cached 포함) · `output_tokens` · `cached` → deck usage 로 환산. |
| 한도 | `RESOURCE_EXHAUSTED` / `Quota exceeded` / 429 를 감지하면 그 계정을 메모리에서 쿨다운, 새 세션은 다른 계정(g1→g2)으로. |

## 모델

Gemini 4.0 id 는 0.62 와 nightly 0.64 어디에도 없다. 알려진 id: `gemini-2.5-pro`(기본), `gemini-3-pro-preview`, `gemini-3.1-pro-preview`, `gemini-3-flash-preview`, `gemini-3.5-flash`, `gemini-3.8-flash`, `gemini-3.1-flash-lite`, `gemini-3.5-flash-lite`. 모델 구성은 서버에서 동적으로 내려온다.
그래서 deck 은 별칭만 쓴다: **Gemini Pro → `-m pro`**, **Gemini Flash → `-m flash`**. 실제 모델명은 `init.model` 로 받는다.
추론 수준(effort) 플래그는 없다 — 피커에서 effort 가 비활성.

## 한계

- **기록 없음**: Gemini 세션을 다시 열면 이전 메시지가 보이지 않는다(deck 은 gemini 의 chat 파일을 읽지 않는다). 이어하기 자체는 된다.
- **네트워크 미차단**: seatbelt 의 네트워크 차단 프로필은 프록시(localhost:8877)가 필요해 쓰지 않는다. 쓰기만 제한된다.
- **셸 불가**: `auto_edit` 에서도 셸 명령은 확인이 필요해 헤드리스에서 거부된다. 편집만 가능.
- **프롬프트 해석**: `/` 로 시작하면 슬래시 명령, `@경로` 는 파일 삽입으로 해석된다.
- **샌드박스 안에서는** gemini 가 프롬프트를 자식 argv 로 다시 넘긴다(프로세스 목록에 보일 수 있음).
- **Linux**: `-s` 는 docker/podman 이 필요해 끈다 — approval mode 만 보호.
- **쿼터 조회 불가**: 로컬에서 남은 한도를 읽을 수 없다(무료: 60 req/min, 1000 req/day). 쿨다운은 메모리에만 있어 재시작하면 초기화.
- **첨부**: 작업 폴더 밖 첨부 파일은 gemini 의 파일 도구(및 seatbelt)가 못 읽을 수 있다.
- 사용량 헤더(5h/주간)에는 Gemini 가 포함되지 않는다.

## 코드

- `src/server/engine/GeminiEngine.ts` — args, 이벤트 매퍼, 프로세스 실행, `resolveGeminiBin`, `geminiLoggedIn`
- `src/shared/accounts.ts` — `GeminiAccount`, `geminiHome`, `geminiCredFile`, `geminiEnv`
- `src/server/turn/TurnRunner.ts` — `runGemini` (계정 선택·고정·쿨다운)
- 테스트: `GeminiEngine.test.ts` (가짜 gemini 바이너리), `TurnRunner.test.ts` 의 "Gemini sessions"

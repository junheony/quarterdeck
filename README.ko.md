# quarterdeck

[![CI](https://github.com/junheony/quarterdeck/actions/workflows/ci.yml/badge.svg)](https://github.com/junheony/quarterdeck/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[English](README.md) | 한국어

이미 로그인해 둔 코딩 CLI 를 Claude Desktop 과 비슷한 화면으로 쓰는, 내 컴퓨터에서 돌리는 웹 셸.

quarterdeck 은 자기 컴퓨터에서 실행한다. 공식 Claude Code 엔진(Claude Agent SDK)과 Codex CLI, Gemini CLI 를 **본인 로그인 그대로** 구동한다. Claude 계정(좌석)이 여러 개면 계정별 사용량을 보여 주고, 턴마다 알맞은 계정을 자동으로 고른다. 같은 화면을 폰·태블릿에서도 열 수 있어서, 돌고 있는 세션을 다른 기기에서 이어 볼 수 있다.

이름은 선장이 배를 지휘하는 갑판(quarterdeck)에서 왔다. 내부 식별자는 짧은 이름 `deck` 을 그대로 쓴다(`DECK_*` 환경변수, `~/.config/deck`).

<!-- 스크린샷 자리: docs/screenshot.png (데스크톱, 분할보기) 를 넣고 여기서 참조한다. -->

> **UI 언어:** 화면은 현재 한국어만 지원한다. 다국어는 로드맵에 있다.

## 기능

- **채팅 셸** — 스트리밍 마크다운, 접을 수 있는 도구 호출, diff 보기, 생각 블록, 할 일 패널, 이미지·파일 첨부, 슬래시 명령·파일 경로 자동완성.
- **분할보기** — 패널 2~4개, 패널마다 독립 세션. 좁은 화면에서는 패널 하나와 서랍형 사이드바.
- **세션 목록** — 디스크에 이미 있는 Claude Code 기록을 읽어 프로젝트 폴더별로 묶는다. 고정, 이름 바꾸기, 보관, 검색, 분기, 삭제(되돌리기 가능), 마크다운 내보내기.
- **Claude Desktop 미러링** — 다른 계정 프로필에서 돌린 세션을 홈 프로필로 되써서 Claude Desktop 과 `claude --resume` 이 같은 대화를 본다. 다른 `claude` 프로세스가 열고 있는 세션은 표시된다.
- **계정 라우팅** — Claude 턴마다 사용량·캐시 온도·쿨다운을 보고 계정을 정한다. 세션을 한 계정에 고정할 수 있고, 한 계정을 *보호 계정*(똑같이 순위를 매기되 동률이면 마지막)으로 둘 수 있다.
- **사용량 패널** — 계정별 5시간·주간·Fable 잔여량, 그리고 로컬 기록으로 만든 토큰 사용 이력 화면.
- **권한** — 승인 카드(한 번 / 이 세션 / 거부), 세션별 권한 모드, `AskUserQuestion` 카드, 모든 결정의 감사 로그.
- **끼워 넣기와 대기열** — 턴이 도는 중에 보낸 메시지는 다음 도구 경계에서 턴에 들어가거나, 턴이 끝난 뒤로 미뤄진다.
- **재연결 따라잡기** — 브라우저가 끊겨도 턴은 서버에서 계속 돈다. 다시 붙은 기기는 놓친 이벤트만 받는다.
- **푸시 알림** — 설치한 PWA 로 Web Push(HTTPS 필요, [원격 접속](#원격-접속) 참고).
- **Codex·Gemini 엔진** — 선택 사항. 세션의 엔진은 만들 때 정해지고 바뀌지 않는다.

## 요구 사항

| | |
|---|---|
| Node.js | 24 이상(`package.json` 의 `engines`) |
| Claude Code | 이 컴퓨터에서 `claude` 로 로그인돼 있을 것. 계정 하나로도 된다. |
| OS | macOS 에서 개발하고 지원한다. |
| 선택 | Codex CLI 0.159 이상(`codex login`), Gemini CLI, Tailscale |

**Linux:** 서버, Claude·Codex 엔진, Tailscale 바인딩은 macOS 전용이 아니며, 단위 테스트는 CI 에서 Linux 로도 참고용으로 돈다. Linux 에서 안 되는 것: launchd 서비스 스크립트(`scripts/install-launchd.sh`), Claude Desktop 세션 기록(기본 경로가 macOS 의 `~/Library/Application Support/Claude`), Gemini 쓰기 샌드박스(macOS seatbelt). 저자는 Linux 에서 상시로 쓰지 않는다.

## 빠른 시작

```bash
git clone https://github.com/junheony/quarterdeck.git
cd quarterdeck
npm install        # Claude Code 네이티브 바이너리 포함(SDK 의 optional dependency)
npm run build      # UI -> dist/ui
npm start          # http://127.0.0.1:9320
```

서버가 뜨면 듣는 주소와 로그인 토큰 위치를 출력한다.

```
deck: http://127.0.0.1:9320
deck: 로그인 토큰은 /Users/alice/.config/deck/token 에 있습니다 (내용은 출력하지 않음)
```

`http://127.0.0.1:9320` 을 열고 토큰 파일의 내용을 로그인 창에 붙여 넣는다.

```bash
cat ~/.config/deck/token
# 5f2c…(16진수 64자)…9e1a
```

토큰은 처음 실행할 때 만들어지며(파일 권한 `0600`) 화면에 출력되지 않는다. 브라우저는 토큰에서 파생한 세션 쿠키를 30일 동안 갖는다. 모든 세션을 끊으려면 토큰 파일을 지우고 다시 시작한다.

새 Claude 세션은 결정이 필요한 도구 호출마다 먼저 묻는다. 자동 승인은 직접 켜는 선택 사항이며, 켜기 전에 [보안 모델](#보안-모델)을 읽는다.

### 서비스로 실행(macOS)

```bash
scripts/install-launchd.sh              # 사용자 LaunchAgent(com.deck.server) 설치 후 시작
scripts/install-launchd.sh --uninstall
npm run restart                         # 재시작: 돌던 턴이 끝난 뒤 내려간다
```

서비스는 `~/.config/deck/env` 의 환경변수(`KEY=value` 한 줄씩)를 읽는다. 이 파일은 셸 스크립트로 읽히므로(`scripts/launchd/run.sh` 가 source) 본인만 쓸 수 있게 둔다(`chmod 600`).

## Claude 계정 여러 개 쓰기

계정 하나가 Claude Code **프로필 디렉터리** 하나다. 프로필마다 한 번씩 로그인한다.

```bash
claude                                   # 첫 계정   -> ~/.claude
CLAUDE_CONFIG_DIR=~/.claude-b claude     # 둘째 계정 -> ~/.claude-b
CLAUDE_CONFIG_DIR=~/.claude-c claude     # 셋째 계정 -> ~/.claude-c  (계정 수는 제한 없음)
```

`accounts.json` 이 없으면 시작할 때 자동으로 찾는다. `~/.claude` 는 계정 `a`, `~/.claude-<영문 소문자 한 글자>` 는 그 글자의 계정이 된다. `.claude-<x>` 는 안에 `projects` 디렉터리나 `.claude.json` 이 있을 때만 센다. 그 밖의 `~/.claude-*` 이름(`.claude-backup`, `.claude-2` 등)은 무시하고, 시작 로그에 그 디렉터리를 추가할 `accounts.json` 항목을 한 줄씩 알려 준다. 계정은 하나만 있어도 동작하고, 아무것도 없으면 `a` 하나다.

다른 id 나 디렉터리를 쓰거나, 이름을 붙이거나, 홈 계정을 바꾸거나, 계정을 빼려면 `<설정 디렉터리>/accounts.json`(기본 `~/.config/deck/accounts.json`)을 만든다.

```json
{
  "version": 1,
  "home": "a",
  "accounts": [
    { "id": "a", "label": "Main" },
    { "id": "work", "label": "Work", "configDir": "~/.claude-work" },
    { "id": "side", "configDir": "/Users/alice/profiles/side", "card": "claude:side-project" },
    { "id": "old", "label": "Old", "retired": true }
  ]
}
```

| 필드 | 기본값 | 뜻 |
|---|---|---|
| `version` | 필수 | `1` 이어야 한다. |
| `id` | 필수 | 바뀌지 않는 키, `^[a-z0-9][a-z0-9_-]{0,15}$`. 세션과 함께 저장된다. 쓸 수 없는 이름: `gpt`, `g1`, `g2`, `codex`, `all`, `auto`, `none`, `null`, `undefined`, `constructor`. |
| `label` | `id` 의 대문자 | 화면에 보이는 이름(1~40자). |
| `configDir` | `a` 는 `~/.claude`, 그 밖은 `~/.claude-<id>` | 프로필 디렉터리. 절대 경로이거나 `~/` 로 시작. |
| `card` | `a`·`b`·`c` 는 `claude:main`·`claude:second`·`claude:third`, 그 밖은 `claude:<id>` | 선택 사항인 사용량 대시보드의 카드 id([사용량 자료](#사용량-자료) 참고). |
| `retired` | `false` | 읽기 전용. 세션과 사용량은 계속 보이지만 라우팅·계정 선택기·고정에서 빠진다. 이 계정의 세션을 이어 가려 하면 안내 문구와 함께 거부된다. |
| `home`(최상위) | `a` 가 쓸 수 있으면 `a`, 아니면 첫 번째 쓸 수 있는 계정 | Claude Desktop 이 읽고 쓰는 프로필 하나. 다른 계정에서 돌린 세션을 여기로 미러링한다. 쓸 수 있는(retired 가 아닌) 계정이어야 한다. |

쓸 수 있는 계정이 최소 하나는 있어야 한다. 모르는 필드는 무시한다.

**파일이 있는데 잘못됐으면**(읽을 수 없음, JSON 아님, 형식 오류, id·디렉터리·card 중복, 없는 `home`, 상대 경로 `configDir`) 서버는 시작하지 않고 파일 경로와 이유를 출력한다. 자동 발견으로 넘어가지 않는다. 파일이 말하는 것과 다른 계정 구성으로 조용히 도는 것을 막기 위해서다. 파일이 없을 때만 자동 발견을 한다.

### 계정 추가

1. 새 프로필 디렉터리에 Claude Code CLI 로 직접 로그인한다. 예: `CLAUDE_CONFIG_DIR=~/.claude-work claude`.
2. `accounts.json` 에 항목을 추가한다. 파일이 없고 `~/.claude-d` 처럼 한 글자 접미사라면 항목이 필요 없다.
3. 서버를 다시 시작한다.

### 계정 빼기

- **`"retired": true`** — 세션과 사용량이 읽기 전용으로 계속 보인다. 기록을 남기려면 이쪽을 쓴다.
- **항목을 지우기** — 그 계정의 `projects` 디렉터리를 더 이상 읽지 않으므로 세션이 목록에서 사라진다. 디스크의 파일은 그대로다. 남겨서 보려면 `retired` 를 쓴다.

주의:

- `id` 를 바꾸거나 두 계정의 `configDir` 을 맞바꾸면 사용량 집계가 겹쳐 실제보다 높게 나올 수 있다. id 는 바꾸지 않는다.
- 토큰 사용량 인덱스가 다루는 Claude 계정은 뺀 계정·지운 계정을 포함해 평생 최대 23개다. 넘치는 계정은 로그에 한 번 알리고 세지 않는다.

**Claude Desktop** 미러링 대상은 최상위 `home` 계정 하나다.

**보호 계정.** 한 계정을 직접(예: Claude Desktop 에서) 같이 쓴다면 보호 계정으로 지정한다. 자동 라우팅은 그 계정도 사용량으로 똑같이 순위를 매기되, 후보가 비슷할 때만 가장 나중에 쓴다. `accounts.json` 이 아니라 별도로 지정한다. `CLAUDE_PROTECT=<id>` 로 지정하거나, `~/.config/offload/protect` 의 주석이 아닌 첫 줄에 id 를 적는다(작성자의 다른 도구와 공유하는 선택적 경로이며 없어도 된다). 설정에 없는 계정 id 는 시작 로그에 경고를 남기고 무시한다. 세션을 보호 계정에 고정하는 것은 그대로 된다 — 고정은 사용자가 직접 고른 것이기 때문이다.

### 턴이 계정을 받는 방법

1. 고정된 세션은 고정 계정을 쓴다. 그 계정이 한도에 닿았거나 쿨다운 중일 때만 예외다.
2. 그 밖에는 프롬프트 캐시가 따뜻한 동안(마지막 턴 후 55분 미만) 지금 계정에 머문다.
3. 지금 계정이 5시간 창 80% 또는 주간 창 85% 를 넘거나 쿨다운 중이면 옮긴다. 95% 이상인 계정은 후보에서 빠진다.
4. 새 세션과 캐시가 식은 세션은 가장 좋은 후보로 간다. 정책은 설정에서 고른다: *고르게 분산*(기본, 5시간 사용률이 낮은 계정 먼저) 또는 *리셋 임박 먼저 소진*(주간 창이 가장 빨리 리셋되는 계정 먼저).
5. 턴이 한도 오류나 인증 오류로 실패하면 그 계정을 쿨다운에 넣고(1시간 / 6시간), 세션 기록을 다음 계정의 프로필로 복사해 거기서 다시 시도한다(재시도 최대 2회).

턴마다 뱃지에 계정, 모델, 그렇게 고른 이유가 표시된다.

## Codex 와 Gemini(선택)

| 엔진 | 실행 방식 | 참고 |
|---|---|---|
| Codex | `codex exec --json` 을 자식 프로세스로 | codex-cli 0.159 이상 필요. 승인 카드가 없다. `approval_policy=never` 와 샌드박스로 돈다. 샌드박스 기본값은 Claude 기본 권한과 상관없이 네트워크를 허용한 작업 폴더 쓰기이고, 읽기 전용을 고를 수 있다. 이미 있는 세션도 샌드박스 칩에서 바꿀 수 있고 다음 턴부터 적용된다. `danger-full-access` 는 쓰지 않는다. |
| Gemini | `gemini -o stream-json` 을 자식 프로세스로 | 직접 골랐을 때만 쓰이고 자동으로는 선택되지 않는다. 계정 두 개까지(`g1`, `g2`), 계정마다 `GEMINI_CLI_HOME` 을 `<configDir>/gemini/<id>` 로 따로 둔다. 다시 연 세션에는 이전 메시지가 보이지 않는다. |

바이너리가 없으면 그 엔진은 화면에서 숨겨진다. quarterdeck 은 대신 로그인하지 않는다. Codex 는 `codex login` 으로, Gemini 의 로그인 절차와 한계는 [docs/gemini-spike.md](docs/gemini-spike.md) 를 본다.

## 설정

설정은 모두 환경변수이고, 필수인 것은 없다.

| 변수 | 기본값 | 설명 |
|---|---|---|
| `DECK_PORT` | `9320` | 듣는 포트. |
| `DECK_CONFIG_DIR` | `~/.config/deck` | 토큰, 설정, 세션 상태, 감사 로그, 첨부. |
| `DECK_LOOPBACK_ONLY` | 미설정 | `1` 이면 Tailscale 이 떠 있어도 `127.0.0.1` 에서만 듣는다. |
| `DECK_EXTRA_HOSTS` | 없음 | `Host` 헤더로 추가 허용할 이름(콤마 구분). |
| `DECK_STEER` | 켜짐 | `0` 이면 턴 도중 보낸 메시지를 끼워 넣지 않고 턴 뒤로 미룬다. |
| `DECK_DRAIN_MAX_MIN` | `15` | 재시작할 때 돌고 있는 턴을 기다리는 최대 분. |
| `DECK_BG_MAX_MIN` | `120` | 턴이 끝난 뒤 백그라운드 작업 때문에 CLI 프로세스를 열어 두는 최대 분. |
| `DECK_BACKUP_RETENTION_DAYS` | `30` | 분기 백업과 삭제한 세션을 지우는 기준 일수. |
| `DECK_USAGE_STRICT` | 미설정 | `1` = 잔여량 모름 → Opus·엔진 전환, `0` = 전환 안 함. 미설정이면 `usage-source.json` 으로 정한다. |
| `DECK_URL` | `http://127.0.0.1:9310` | 선택 사항인 사용량 대시보드의 주소. 미설정이면 `~/.config/claude-pick/deck_url` 파일이 있을 때 그 첫 줄을 쓴다(작성자의 다른 도구와 공유하는 선택적 경로이며 없어도 된다). |
| `CLAUDE_PROTECT` | 미설정 | 보호 계정 id. 없으면 `~/.config/offload/protect`(작성자의 다른 도구와 공유하는 선택적 경로, 없어도 된다). |
| `CLAUDE_PICK_COOLDOWN_DIR` | `$XDG_CACHE_HOME/offload/cooldown` (`~/.cache/...`) | 계정별 쿨다운 파일이 있는 디렉터리. |
| `DECK_CODEX_BIN` | `PATH`, `~/.local/bin`, `~/.nvm` 순으로 탐색 | `codex` 경로. 직접 지정하면 버전 검사를 건너뛴다. |
| `CODEX_HOME` | `~/.codex` | Codex 세션 롤아웃을 읽는 위치. |
| `DECK_GEMINI_BIN` | `PATH`, `~/.local/bin` 순으로 탐색 | `gemini` 경로. |
| `DECK_DESKTOP_SESSIONS_DIR` | `~/Library/Application Support/Claude/claude-code-sessions` | Claude Desktop 세션 기록(읽기 전용). |
| `DECK_VAPID_SUBJECT` | 자동 | Web Push 의 `https:` 또는 `mailto:` subject. |
| `DECK_UI_DIR` | `dist/ui` | 빌드된 UI 디렉터리. |
| `DECK_EXTRA_CWD_ROOTS` | 없음 | 홈 디렉터리 외에 새 세션을 시작할 수 있게 할 절대 경로(콤마 구분). `DECK_LOOPBACK_ONLY=1` 일 때만 적용되고 `/` 는 받지 않는다. 테스트 하네스용. |
| `DECK_DEV_ORIGIN` | 없음 | 개발 중 추가로 허용할 origin(콤마 구분, Vite 개발 서버). |

화면에서 바꾸는 서버 전체 설정(기본 권한 모드, 라우팅 정책)은 설정 디렉터리의 `settings.json` 에 저장된다. 고정 프로젝트 폴더는 `projects.json` 에 `[{"cwd": "/Users/alice/code/acme-app", "name": "acme-app"}]` 형식으로 적는다.

### 사용량 자료

quarterdeck 은 `DECK_URL` 의 외부 사용량 대시보드를 60초마다 조회해(`GET /api/state`) 계정별 사용량 창을 받을 수 있다. **없어도 된다.** 대시보드는 별도 프로그램이고 이 저장소에 들어 있지 않다. 기대하는 응답은 다음과 같다.

```json
{ "cards": [ { "id": "claude:main", "status": "ok", "fetchedAt": "2026-01-01T00:00:00Z",
  "rows": [ { "label": "Session (5h)", "used": 12, "resetsAt": "2026-01-01T05:00:00Z" },
            { "label": "Weekly (7d)", "used": 40, "resetsAt": "2026-01-05T00:00:00Z" } ] } ] }
```

계정 `a`·`b`·`c` 는 카드 id `claude:main`·`claude:second`·`claude:third` 에 대응하고, 나머지 계정은 `claude:<id>` 에 대응한다. 바꾸려면 `accounts.json` 의 `card` 를 쓴다.

대시보드가 응답하지 않아도 전부 동작한다. 이때 사용량 창은 각 CLI 가 턴 도중 알려 주는 값에서 온다. 그래서 계정은 턴을 한 번 돌린 뒤에야 숫자가 보이고, 사용량을 모르는 계정은 값이 알려진 후보보다 뒤, 한도에 닿은 것으로 알려진 계정보다 앞 순위 후보가 된다. 토큰 사용 이력 화면은 로컬 기록을 읽으므로 대시보드와 무관하다.

**사용량 대시보드가 없으면 잔여량을 알 수 없고, quarterdeck 은 그 이유만으로 요청을 바꾸지 않는다.** "모름"만으로는 모델이나 엔진을 바꾸지 않는다. Fable 을 요청하면 Fable 로 실행한다. 플랜 한도를 넘는 Fable 초과 과금은 사용자가 직접 관리해야 한다. 대시보드 응답을 한 번이라도 본 설치는 엄격 모드로 `<설정 디렉터리>/usage-source.json` 에 기록되고, 대시보드 주소를 직접 설정한 설치(`DECK_URL` 또는 `deck_url` 파일)는 처음부터 엄격 모드다. 이때는 잔여량 모름이 Fable 대신 Opus, 엔진 전환으로 이어진다. `DECK_USAGE_STRICT=1` 로 엄격 모드를, `DECK_USAGE_STRICT=0` 으로 느슨한 모드를 강제한다. 첫 대시보드 조회가 끝나기 전에는 엄격한 쪽으로 동작한다.

## 원격 접속

기본으로 서버는 `127.0.0.1` 과, 이 컴퓨터의 **Tailscale** IPv4 주소라고 판단한 주소에서 듣는다. `0.0.0.0` 에는 절대 바인드하지 않는다.

이름이 `utunN`(macOS) 또는 `tailscaleN`(Linux)인 인터페이스에 있는 `100.64.0.0/10` 범위의 IPv4 주소를 Tailscale 주소로 본다. `tailscale` CLI 가 설치돼 있고 응답하면 그 주소가 `tailscale ip -4` 결과에도 있어야 한다. CLI 가 없거나 실패하면 이 대조는 건너뛰고 인터페이스 이름과 대역만으로 판단한다.

> 다른 VPN 도 `utunN` 인터페이스를 쓰고, 일부는 `100.64.0.0/10` 대역을 쓴다. 그런 VPN 을 쓰는 환경이라면(특히 `tailscale` CLI 가 없다면) `DECK_LOOPBACK_ONLY=1` 로 그 네트워크에서 듣지 않게 한다.

- tailnet 의 다른 기기에서: `http://<tailscale-ip>:9320`.
- `Host` 헤더가 루프백, 바인드한 주소, 이 노드의 MagicDNS 이름, `DECK_EXTRA_HOSTS` 중 하나일 때만 요청을 받는다.
- Web Push 와 PWA 설치는 HTTPS 가 필요하다. `tailscale serve` 뒤에 둔다. 예: `tailscale serve --bg --https=443 http://127.0.0.1:9320` 후 `https://deck-host.example.ts.net/` 을 연다. (저자 환경에서 쓰는 명령이며 테스트로 검증되지는 않는다.)

포트를 공개 인터넷에 열지 않는다. 다중 사용자 지원이 없고, 로그인 시도 횟수 제한도 없다.

## 보안 모델

quarterdeck 은 내 컴퓨터에서 명령을 실행할 수 있다. 여기에 접속할 수 있다는 것은 셸에 접속할 수 있다는 것과 같다고 본다.

- **누가 접속할 수 있나.** 이 컴퓨터의 프로세스와 내 tailnet 의 기기. 로그인을 뺀 모든 `/api` 요청과 WebSocket 은 세션 쿠키가 있어야 한다.
- **토큰.** `~/.config/deck/token`(`0600`)의 16진수 64자. 브라우저는 SHA-256 으로 파생한 쿠키만 갖는다(`HttpOnly`, `SameSite=Strict`, HTTPS 에서는 `Secure`).
- **교차 사이트 요청.** 상태를 바꾸는 HTTP 요청과 WebSocket 업그레이드는 `Origin` 이 서버 자신의 origin 과 같아야 한다. `Host` 허용 목록으로 DNS 리바인딩을 막는다. 응답에는 제한적인 Content-Security-Policy 가 붙고, 모델 출력의 이미지는 불러오지 않고 링크로 그린다.
- **권한 모드.** Claude 세션마다 고른다: 매번 묻기, 편집 자동 승인, 계획 모드, 모두 자동 승인. 새 세션의 기본값은 **매번 묻기**다 — 결정이 필요한 도구 호출마다 승인 카드가 뜬다. Claude 설정의 거부 규칙은 어느 모드에서나 적용된다.
- **"모두 자동 승인"은 직접 켜는 선택 사항이다.** 한 세션에서만 켜거나 설정에서 기본값으로 만들 수 있다. 켜면 모델이 부르는 모든 도구 호출(셸 명령, 파일 편집, 네트워크 접근 포함)이 카드 없이, 어느 기기에서 보냈든, 아무도 보고 있지 않아도 실행된다. 호출은 여전히 감사 로그에 남고 거부 규칙과 훅도 적용된다. (Codex 세션과는 상관없다. Codex 의 기본 샌드박스는 언제나 작업 폴더 쓰기다.) 답하지 않은 요청은 30분이 지나거나 턴이 끝나면 거부로 닫힌다.
- **Claude 설정이 그대로 적용된다.** 턴은 사용자·프로젝트·로컬 Claude Code 설정(허용 규칙과 훅 포함)을 CLI 와 똑같이 읽는다.
- **감사 로그.** 모든 권한 결정이 `~/.config/deck/audit.log` 에 JSON 한 줄씩 쌓인다: 시각, 세션, 도구 이름, 결정, 누가 결정했는지, 도구 입력의 SHA-256(입력 자체는 남기지 않는다). 5 MiB 가 되면 `audit.log.1` 로 넘어간다.
- **자격 증명.** quarterdeck 은 CLI 의 자격 증명을 읽거나 저장하거나 전달하지 않는다. 프로필 디렉터리를 골라 공식 CLI 를 띄울 뿐이고, Gemini 는 자격 파일이 있는지만 확인한다. Claude 턴을 띄우기 전에 자식 환경에서 `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_AUTH_TOKEN` 과 베이스 URL 변수를 지워서, 턴이 조용히 다른 계정으로 과금되지 않게 한다.
- **파일 접근.** 새 세션은 홈 디렉터리 안(또는 루프백 전용 서버에서 `DECK_EXTRA_CWD_ROOTS` 로 지정한 경로)에서만 시작할 수 있다. 파일 미리보기 API 는 설정 디렉터리, 홈 바로 아래의 점(.) 디렉터리, 흔한 비밀 파일(`.env`, 개인 키, 자격 파일)을 거부한다.

취약점은 [SECURITY.md](SECURITY.md) 대로 제보한다.

## 파일

`~/.config/deck`(또는 `DECK_CONFIG_DIR`) 아래:

| 파일 | 내용 |
|---|---|
| `token` | 로그인 토큰(`0600`). |
| `accounts.json` | 선택. 계정 목록([Claude 계정 여러 개 쓰기](#claude-계정-여러-개-쓰기)). |
| `settings.json` | 기본 권한 모드(기본값: 매번 묻기), 라우팅 정책. |
| `projects.json` | 선택. 고정 프로젝트 폴더. |
| `session-state.json` | 세션별 계정·모델·마지막 턴. |
| `session-meta.json`, `pins.json` | 바꾼 제목, 보관 표시, 고정한 세션. |
| `recent-folders.json` | 새 세션용으로 최근에 연 폴더. |
| `accepted-refs.json` | 받아들인 전송의 참조값. 다시 보낸 메시지가 한 번만 실행되게 한다. |
| `audit.log` | 권한 결정. |
| `attachments/` | 올린 파일(`0700`, 파일당 10 MiB, 7일 뒤 삭제). |
| `vapid.json`, `push-subscriptions.json` | Web Push 키와 구독(`0600`). |
| `usage-index-v2.json`, `usage-index-v2.json.seen` | 토큰 사용량 집계와 중복 제거 로그. 옛 `usage-index.json` 은 변환할 때 한 번 읽고 그대로 둔다. |
| `usage-source.json` | 사용량 대시보드가 처음 응답했을 때 한 번 기록(`{"deckSeenAt": ...}`). |
| `gemini/<id>/` | Gemini 계정별 Gemini CLI 홈(`DECK_CONFIG_DIR` 를 따른다). |

launchd 서비스는 여기에 더해 `~/.config/deck/env`(서비스용 환경변수)를 읽고 출력을 `~/.config/deck/deck.log` 에 쓴다.

대화 기록은 각 CLI 가 두는 자리에 그대로 있다(Claude 는 `<프로필>/projects/`, Codex 는 `$CODEX_HOME/sessions`).

## 개발

```bash
DECK_DEV_ORIGIN=http://localhost:5173 npm run dev:server   # 자동 재시작되는 서버
npm run dev:ui                                             # Vite :5173, /api 와 /ws 를 :9320 으로 프록시
npm run typecheck
npm test                                                   # 단위 테스트(네트워크·계정 불필요)
npm run build
```

> **`npm run test:e2e` 는 실제 계정을 쓴다.** 진짜 서버를 띄워 로그인된 Claude 프로필(설치돼 있으면 Codex 도)로 짧은 턴을 돌린다. 구독의 토큰을 소모한다. CI 에서는 돌리지 않는다.

### 구조

```
src/server/          HTTP + WebSocket 서버 (Node, TypeScript)
  engine/            ClaudeEngine (Agent SDK), CodexEngine, GeminiEngine
  routing/           계정·엔진·모델 선택, 쿨다운
  turn/              TurnRunner: 라우팅부터 결과까지 한 턴, 재시도
  sessions/          세션 목록, 프로필 간 이동, 분기, 휴지통, 검색
  usage/             사용량 조회와 토큰 사용량 인덱스
  push/              Web Push
src/shared/          서버와 UI 가 함께 쓰는 타입과 WebSocket 프로토콜
src/ui/              React UI (Vite)
scripts/             launchd 서비스와 재시작 도구
tests/e2e/           실제 계정으로 도는 종단 테스트
docs/                구조와 프로토콜 문서
```

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)(영어) — 각 부분이 어떻게 맞물리는지.
- [docs/protocol.md](docs/protocol.md) — WebSocket 프로토콜을 바꿀 때의 규칙. UI 와 서버는 따로 배포되므로 모든 변경은 양방향으로 호환돼야 한다.
- [CONTRIBUTING.md](CONTRIBUTING.md)

## 면책

quarterdeck 은 비공식 개인 프로젝트다. Anthropic, OpenAI, Google 과 관계가 없고, 이들의 승인이나 지원을 받지 않는다. "Claude", "Codex", "Gemini" 는 각 소유자의 상표다.

이 도구는 사용자가 직접 설치하고 직접 로그인한 CLI 를 본인 기기에서 쓰기 위한 로컬 프런트엔드다. API 키를 쓰지 않고, 사람들 사이에 계정을 공유하지 않는다. 여러 계정을 쓰는 것을 포함해, 자신의 사용이 각 서비스의 약관에 맞는지는 사용자 책임이다.

## 라이선스

[MIT](LICENSE)

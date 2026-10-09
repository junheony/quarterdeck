# quarterdeck

[![CI](https://github.com/junheony/quarterdeck/actions/workflows/ci.yml/badge.svg)](https://github.com/junheony/quarterdeck/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

English | [한국어](README.ko.md)

A self-hosted, Claude Desktop-style web shell for the coding CLIs you are already logged in to.

quarterdeck runs on your own computer. It drives the official Claude Code engine (through the Claude Agent SDK), the Codex CLI and the Gemini CLI **with your own logins, as they are**. If you have more than one Claude account ("seat"), it shows the usage of each and assigns every turn to a suitable one automatically. The same UI works from a phone or tablet, so you can pick up a running session from another device.

The name: a quarterdeck is where the captain commands the ship. Internal identifiers keep the short name `deck` (`DECK_*` environment variables, `~/.config/deck`).

<!-- Screenshot placeholder: add docs/screenshot.png (desktop, split view) and reference it here. -->

> **UI language:** the interface is currently Korean only. Internationalization is on the roadmap.

## Features

- **Chat shell** — streaming markdown, collapsible tool calls, diff view, thinking blocks, todo panel, image and file attachments, slash-command and file-path completion.
- **Split view** — 2 to 4 panes, each an independent session. On narrow screens: one pane and a drawer sidebar.
- **Session list** — reads the Claude Code transcripts already on disk, grouped by project folder. Pin, rename, archive, search, fork, delete (with undo), export to Markdown.
- **Claude Desktop mirroring** — a session that ran on another account's profile is copied back to the home profile, so Claude Desktop and `claude --resume` see the same conversation. Sessions currently held open by another `claude` process are marked.
- **Account routing** — every Claude turn gets an account based on usage, cache warmth and cooldowns. A session can be pinned to one account. One account can be marked *protected* (ranked like the others; last only on a tie).
- **Usage panel** — remaining 5-hour / weekly / Fable windows per account, plus a token-usage history view built from local transcripts.
- **Permissions** — approval cards (once / this session / deny), per-session permission modes, `AskUserQuestion` cards, and an audit log of every decision.
- **Steer and queue** — a message sent while a turn runs is injected at the next tool boundary, or queued for after the turn.
- **Reconnect catch-up** — turns keep running on the server when a browser disconnects; a reconnecting device receives only the events it missed.
- **Push notifications** — Web Push from the installed PWA (needs HTTPS, see [Remote access](#remote-access)).
- **Codex and Gemini engines** — optional; a session is bound to one engine when it is created.

## Requirements

| | |
|---|---|
| Node.js | 24 or newer (`engines` in `package.json`) |
| Claude Code | Logged in with `claude` on this machine. One account is enough. |
| OS | macOS is the development and supported platform. |
| Optional | Codex CLI 0.159 or newer (`codex login`), Gemini CLI, Tailscale |

**Linux:** the server, the Claude and Codex engines and Tailscale binding are not macOS-specific, and the unit tests run on Linux in CI as an informational job. Not available on Linux: the launchd service scripts (`scripts/install-launchd.sh`), Claude Desktop session records (the default path is macOS's `~/Library/Application Support/Claude`), and the Gemini write sandbox (macOS seatbelt). Linux is not regularly used by the author.

## Quick start

```bash
git clone https://github.com/junheony/quarterdeck.git
cd quarterdeck
npm install        # includes the Claude Code native binary (optional dependency of the SDK)
npm run build      # UI -> dist/ui
npm start          # http://127.0.0.1:9320
```

On start the server prints the addresses it listens on and where the login token is:

```
deck: http://127.0.0.1:9320
deck: 로그인 토큰은 /Users/alice/.config/deck/token 에 있습니다 (내용은 출력하지 않음)
```

Open `http://127.0.0.1:9320` and paste the contents of the token file into the login form:

```bash
cat ~/.config/deck/token
# 5f2c…(64 hex characters)…9e1a
```

The token is generated on first start (file mode `0600`) and never printed. The browser keeps a derived session cookie for 30 days. To invalidate every session, delete the token file and restart.

New Claude sessions ask before each tool call that needs a decision. Auto-approval is opt-in; read [Security model](#security-model) before turning it on.

### Run as a service (macOS)

```bash
scripts/install-launchd.sh              # install a user LaunchAgent (com.deck.server) and start it
scripts/install-launchd.sh --uninstall
npm run restart                         # graceful restart: running turns finish first
```

The service reads environment variables from `~/.config/deck/env` (`KEY=value` lines). The file is read as a shell script (`scripts/launchd/run.sh` sources it), so keep it writable by you only (`chmod 600`).

## Multiple Claude accounts

Each account is a Claude Code **profile directory**. Log in once per profile:

```bash
claude                                   # first account  -> ~/.claude
CLAUDE_CONFIG_DIR=~/.claude-b claude     # second account -> ~/.claude-b
CLAUDE_CONFIG_DIR=~/.claude-c claude     # third account  -> ~/.claude-c  (any number of accounts works)
```

With no `accounts.json`, quarterdeck discovers accounts at start: `~/.claude` becomes account `a`, and `~/.claude-<letter>` (one lower-case ASCII letter) becomes the account with that letter. A `.claude-<x>` directory counts only if it contains a `projects` directory or a `.claude.json`. Any other `~/.claude-*` name (`.claude-backup`, `.claude-2`) is ignored, and the start log prints the `accounts.json` entry that would add it. One account is enough; with nothing found, the account is `a`.

To use other ids or directories, name accounts, set the home account or retire one, create `<config dir>/accounts.json` (default `~/.config/deck/accounts.json`):

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

| Field | Default | Meaning |
|---|---|---|
| `version` | required | Must be `1`. |
| `id` | required | Permanent key, `^[a-z0-9][a-z0-9_-]{0,15}$`. Stored with sessions. Not allowed: `gpt`, `g1`, `g2`, `codex`, `all`, `auto`, `none`, `null`, `undefined`, `constructor`. |
| `label` | `id` in upper case | Name shown in the UI (1 to 40 characters). |
| `configDir` | `~/.claude` for `a`, else `~/.claude-<id>` | The profile directory: absolute, or starting with `~/`. |
| `card` | `claude:main`, `claude:second`, `claude:third` for `a`, `b`, `c`; else `claude:<id>` | Card id in the optional usage dashboard (see [Usage data](#usage-data)). |
| `retired` | `false` | Read-only: sessions and usage stay visible, but the account is left out of routing, the account picker and pinning. Continuing one of its sessions is refused with a message. |
| `home` (top level) | `a` if it is active, else the first active account | The one profile Claude Desktop reads and writes. Sessions run on other accounts are mirrored back to it. Must be an active account. |

At least one account must be active. Unknown fields are ignored.

**If the file is there but wrong** (unreadable, not JSON, wrong shape, duplicate id, directory or card, unknown `home`, relative `configDir`), the server does not start. It prints the file path and the reason. It does not fall back to discovery, because that would silently run with a different set of accounts than the file says. Only a missing file means discovery.

### Add an account

1. Log in to a new profile directory with the Claude Code CLI yourself, for example `CLAUDE_CONFIG_DIR=~/.claude-work claude`.
2. Add an entry to `accounts.json`. Without the file, a one-letter suffix such as `~/.claude-d` needs no entry.
3. Restart the server.

### Remove an account

- **`"retired": true`** keeps its sessions and usage visible, read-only. Use this to keep history.
- **Deleting the entry** removes the account's sessions from the list, because its `projects` directory is no longer scanned. Files on disk are not touched. To keep seeing them, use `retired`.

Cautions:

- Changing an `id`, or swapping the `configDir` of two accounts, makes usage counts overlap and read too high. Treat ids as permanent.
- The token-usage index has room for 23 Claude accounts over its lifetime, retired and removed ones included. Further accounts are logged once and not counted.

**Claude Desktop** mirroring targets the single top-level `home` account.

**Protected account.** If you also use one account interactively (for example in Claude Desktop), mark it protected: automatic routing still ranks it by usage like any other account, but when candidates are otherwise equal it is used last. This is not part of `accounts.json`. Set `CLAUDE_PROTECT=<id>`, or put the id on the first non-comment line of `~/.config/offload/protect` (an optional path shared with the author's other tools; it does not need to exist). An id that is not a configured account is ignored with a start-log warning. Pinning a session to the protected account still works; a pin is an explicit choice.

### How a turn gets an account

1. A pinned session uses its pinned account unless that account is at its limit or cooling down.
2. Otherwise the session stays on its current account while the prompt cache is warm (last turn less than 55 minutes ago).
3. It switches when the current account passes 80% of the 5-hour window or 85% of the weekly window, or is cooling down. Accounts at 95% or more are excluded.
4. New sessions and cold sessions go to the best candidate. The policy is a setting: *balance* (default; lowest 5-hour usage first) or *drain* (the account whose weekly window resets soonest first).
5. If a turn fails with a rate-limit or authentication error, the account is put on cooldown (1 hour / 6 hours), the session transcript is copied to the next account's profile, and the turn is retried there (up to 2 retries).

Each turn's badge shows the account, the model and the reason for the choice.

## Codex and Gemini (optional)

| Engine | How it runs | Notes |
|---|---|---|
| Codex | `codex exec --json` as a child process | Needs codex-cli 0.159 or newer. No approval cards: turns run with `approval_policy=never` inside a sandbox. The sandbox is workspace-write with network access on by default (whatever the Claude permission default), or read-only if you pick it. You can change it on an existing session from its sandbox chip; it applies from the next turn. `danger-full-access` is never used. |
| Gemini | `gemini -o stream-json` as a child process | Explicit choice only; never selected automatically. Up to two accounts (`g1`, `g2`), each with its own `GEMINI_CLI_HOME` at `<configDir>/gemini/<id>`. Reopened sessions do not show earlier messages. |

Without the binary, the engine is hidden in the UI. quarterdeck never logs in for you: use `codex login`, and see [docs/gemini-spike.md](docs/gemini-spike.md) (Korean) for the Gemini login steps and limits.

## Configuration

All settings are environment variables. None is required.

| Variable | Default | Description |
|---|---|---|
| `DECK_PORT` | `9320` | Listen port. |
| `DECK_CONFIG_DIR` | `~/.config/deck` | Token, `accounts.json`, settings, session state, audit log, attachments, usage files, Gemini homes. |
| `DECK_LOOPBACK_ONLY` | unset | `1` = listen on `127.0.0.1` only, even when Tailscale is up. |
| `DECK_EXTRA_HOSTS` | empty | Comma-separated extra names accepted in the `Host` header. |
| `DECK_STEER` | on | `0` = messages sent during a turn are queued for after it instead of injected. |
| `DECK_DRAIN_MAX_MIN` | `15` | On graceful restart, minutes to wait for running turns. |
| `DECK_BG_MAX_MIN` | `120` | Minutes a CLI process may stay open for background tasks after its turn. |
| `DECK_BACKUP_RETENTION_DAYS` | `30` | Age at which fork backups and trashed sessions are deleted. |
| `DECK_USAGE_STRICT` | unset | `1` = unknown quota means Opus / engine switch, `0` = never. Unset: decided by `usage-source.json`. |
| `DECK_URL` | `http://127.0.0.1:9310` | Base URL of the optional usage dashboard. When unset, the first line of `~/.config/claude-pick/deck_url` is used if that file exists (an optional path shared with the author's other tools). |
| `CLAUDE_PROTECT` | unset | Protected account id. Falls back to `~/.config/offload/protect` (optional, shared with the author's other tools). |
| `CLAUDE_PICK_COOLDOWN_DIR` | `$XDG_CACHE_HOME/offload/cooldown` (`~/.cache/...`) | Directory of per-account cooldown files. |
| `DECK_CODEX_BIN` | search `PATH`, `~/.local/bin`, `~/.nvm` | Path to `codex`. An explicit path skips the version check. |
| `CODEX_HOME` | `~/.codex` | Where Codex session rollouts are read from. |
| `DECK_GEMINI_BIN` | search `PATH`, `~/.local/bin` | Path to `gemini`. |
| `DECK_DESKTOP_SESSIONS_DIR` | `~/Library/Application Support/Claude/claude-code-sessions` | Claude Desktop session records (read-only). |
| `DECK_VAPID_SUBJECT` | derived | `https:` or `mailto:` subject for Web Push. |
| `DECK_UI_DIR` | `dist/ui` | Built UI directory. |
| `DECK_EXTRA_CWD_ROOTS` | empty | Comma-separated absolute paths where new sessions may start in addition to the home directory. Honoured only with `DECK_LOOPBACK_ONLY=1`; `/` is never accepted. Meant for test harnesses. |
| `DECK_DEV_ORIGIN` | empty | Comma-separated extra origins allowed during development (the Vite dev server). |

Server-wide settings changed in the UI (default permission mode, routing policy) are stored in `settings.json` in the config directory. Pinned project folders can be listed in `projects.json` as `[{"cwd": "/Users/alice/code/acme-app", "name": "acme-app"}]`.

### Usage data

quarterdeck can poll an external usage dashboard at `DECK_URL` (`GET /api/state`, every 60 seconds) for per-account usage windows. **This is optional.** The dashboard is a separate program and not part of this repository; the expected response is:

```json
{ "cards": [ { "id": "claude:main", "status": "ok", "fetchedAt": "2026-01-01T00:00:00Z",
  "rows": [ { "label": "Session (5h)", "used": 12, "resetsAt": "2026-01-01T05:00:00Z" },
            { "label": "Weekly (7d)", "used": 40, "resetsAt": "2026-01-05T00:00:00Z" } ] } ] }
```

Account `a`, `b` and `c` map to the card ids `claude:main`, `claude:second` and `claude:third`; every other account maps to `claude:<id>`. Set `card` in `accounts.json` to change it.

When no dashboard answers, everything still works. Usage windows then come from what the CLIs report during each turn, so an account shows numbers only after it has run a turn, and accounts with unknown usage are tried after accounts with known usage and before accounts known to be at their limit. The token-usage history view reads local transcripts and does not depend on the dashboard.

**Without a usage dashboard, remaining quota is unknown, and quarterdeck does not change your request because of that.** An unknown value alone does not switch the model or the engine: a Fable turn runs on Fable as requested. Managing Fable usage beyond your plan's limit (extra billing) is up to you. An install that has seen a dashboard answer even once is recorded as strict in `<config dir>/usage-source.json`, and one where the dashboard address is set explicitly (`DECK_URL`, or the `deck_url` file) is strict from the start; there, unknown quota means Opus instead of Fable and a switch of engine. Set `DECK_USAGE_STRICT=1` to force strict mode or `DECK_USAGE_STRICT=0` to force the lenient one. Until the first dashboard request has finished, the strict side applies.

## Remote access

By default the server listens on `127.0.0.1`, plus what it takes to be this machine's **Tailscale** IPv4 address. It never binds to `0.0.0.0`.

An address is treated as Tailscale when it is an IPv4 address in `100.64.0.0/10` on an interface named `utunN` (macOS) or `tailscaleN` (Linux). If the `tailscale` CLI is installed and answers, the address must also appear in `tailscale ip -4`. If the CLI is missing or fails, that cross-check is skipped and the interface and range alone decide.

> Other VPNs also use `utunN` interfaces, and some use the `100.64.0.0/10` range. If you run such a VPN, especially without the `tailscale` CLI installed, set `DECK_LOOPBACK_ONLY=1` so the server does not listen on that network.

- From another device on your tailnet: `http://<tailscale-ip>:9320`.
- Requests are accepted only when the `Host` header is loopback, a bound address, this node's MagicDNS name, or listed in `DECK_EXTRA_HOSTS`.
- Web Push and PWA installation need HTTPS. Put the server behind `tailscale serve`, for example `tailscale serve --bg --https=443 http://127.0.0.1:9320`, then open `https://deck-host.example.ts.net/`. (This command comes from the author's setup; it is not exercised by the test suite.)

Do not expose the port to the public internet. There is no multi-user support and no rate limiting on login.

## Security model

quarterdeck can run commands on your machine. Treat access to it like shell access.

- **Who can connect.** Processes on the machine and devices on your tailnet. Every `/api` request except login, and the WebSocket, requires the session cookie.
- **Token.** 64 hex characters in `~/.config/deck/token` (`0600`). The browser holds only a SHA-256-derived cookie (`HttpOnly`, `SameSite=Strict`, `Secure` over HTTPS).
- **Cross-site requests.** State-changing HTTP requests and the WebSocket upgrade must carry an `Origin` equal to the server's own origin. The `Host` allowlist guards against DNS rebinding. Responses carry a restrictive Content-Security-Policy; images in model output are rendered as links, not loaded.
- **Permission modes.** Per Claude session: ask every time, auto-accept edits, plan, or auto-approve everything. New sessions default to **ask every time**: each tool call that needs a decision shows an approval card. Deny rules in your Claude settings apply in every mode.
- **Auto-approve everything is opt-in.** You can turn it on for one session or make it the default in Settings. With it on, every tool call the model makes, including shell commands, file edits and network access, runs without a card, on any device and while nobody is watching. Each call is still written to the audit log, and deny rules and hooks still apply. (Codex sessions are not affected: they always default to the workspace-write sandbox.) Unanswered requests are denied after 30 minutes or when the turn ends.
- **Claude settings apply.** Turns load your user, project and local Claude Code settings, including allow rules and hooks, exactly as the CLI would.
- **Audit log.** Every permission decision is appended to `~/.config/deck/audit.log` as JSON lines: time, session, tool name, decision, who decided, and a SHA-256 of the tool input (not the input itself). The file rotates to `audit.log.1` at 5 MiB.
- **Credentials.** quarterdeck does not read, store or forward CLI credentials. It starts the official CLIs with a profile directory selected; for Gemini it checks only whether the credential file exists. Before a Claude turn it removes `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_AUTH_TOKEN` and base-URL variables from the child environment, so a turn cannot silently bill a different account.
- **File access.** New sessions must start inside your home directory (or a `DECK_EXTRA_CWD_ROOTS` path on a loopback-only server). The file preview API refuses the config directory, dot-directories directly under home, and common secret files (`.env`, private keys, credential files).

Report vulnerabilities as described in [SECURITY.md](SECURITY.md).

## Files

Under `~/.config/deck` (or `DECK_CONFIG_DIR`):

| File | Content |
|---|---|
| `token` | Login token (`0600`). |
| `accounts.json` | Optional account list ([Multiple Claude accounts](#multiple-claude-accounts)). |
| `settings.json` | Default permission mode (default: ask every time), routing policy. |
| `projects.json` | Optional pinned project folders. |
| `session-state.json` | Per-session account, model and last turn. |
| `session-meta.json`, `pins.json` | Renamed titles, archive flags, pinned sessions. |
| `recent-folders.json` | Folders recently opened for new sessions. |
| `accepted-refs.json` | References of accepted sends, so a re-sent message runs once. |
| `audit.log` | Permission decisions. |
| `attachments/` | Uploaded files (`0700`; 10 MiB each, deleted after 7 days). |
| `vapid.json`, `push-subscriptions.json` | Web Push keys and subscriptions (`0600`). |
| `usage-index-v2.json`, `usage-index-v2.json.seen` | Token-usage aggregates and their dedupe log. An older `usage-index.json` is read once for conversion and left in place. |
| `usage-source.json` | Written once, the first time a usage dashboard answers (`{"deckSeenAt": ...}`). |
| `gemini/<id>/` | Gemini CLI home per Gemini account (follows `DECK_CONFIG_DIR`). |

The launchd service additionally uses `~/.config/deck/env` (environment for the service) and writes its output to `~/.config/deck/deck.log`.

Conversation transcripts stay where the CLIs keep them (`<profile>/projects/` for Claude, `$CODEX_HOME/sessions` for Codex).

## Development

```bash
DECK_DEV_ORIGIN=http://localhost:5173 npm run dev:server   # server with reload
npm run dev:ui                                             # Vite on :5173, proxies /api and /ws to :9320
npm run typecheck
npm test                                                   # unit tests (no network, no accounts)
npm run build
```

> **`npm run test:e2e` uses your real accounts.** It starts a real server and runs short turns against the logged-in Claude profiles (and Codex if installed). It consumes tokens from your subscription. It is never run in CI.

### Layout

```
src/server/          HTTP + WebSocket server (Node, TypeScript)
  engine/            ClaudeEngine (Agent SDK), CodexEngine, GeminiEngine
  routing/           account, engine and model selection; cooldowns
  turn/              TurnRunner: one turn from routing to result, retries
  sessions/          session index, cross-profile moves, forks, trash, search
  usage/             usage polling and token-usage index
  push/              Web Push
src/shared/          types and the WebSocket protocol shared by server and UI
src/ui/              React UI (Vite)
scripts/             launchd service and restart helpers
tests/e2e/           end-to-end tests against real accounts
docs/                architecture and protocol notes
```

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — how the pieces fit together.
- [docs/protocol.md](docs/protocol.md) (Korean) — rules for changing the WebSocket protocol. The UI and the server are deployed separately, so every change must stay compatible in both directions.
- [CONTRIBUTING.md](CONTRIBUTING.md)

## Disclaimer

quarterdeck is an unofficial personal project. It is not affiliated with, endorsed by or supported by Anthropic, OpenAI or Google. "Claude", "Codex" and "Gemini" are trademarks of their respective owners.

It is a local front end for CLIs that you have installed and logged in to yourself, on your own device. It does not use API keys and does not share accounts between people. Whether your use, including the use of more than one account, complies with each service's terms is your responsibility.

## License

[MIT](LICENSE)

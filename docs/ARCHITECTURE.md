# Architecture

quarterdeck is one Node.js server plus a React UI. The server runs on the machine that holds your project files and CLI logins; browsers connect over HTTP and a WebSocket. Internal names use the short form `deck`.

## Processes

```
browser (desktop, phone) ──HTTP + WS──▶ deck server (one Node process)
                                         ├─ TurnRunner ─┬─ ClaudeEngine ── Claude Agent SDK ── claude CLI (child, per account profile)
                                         │              ├─ CodexEngine ─── codex exec --json (child)
                                         │              └─ GeminiEngine ── gemini -o stream-json (child)
                                         ├─ AccountRouter / EngineChoice / ModelPolicy
                                         ├─ SessionIndex, SessionMover, SessionStateStore
                                         ├─ UsageService, UsageIndex
                                         └─ auth, audit log, attachments, Web Push
```

- **Server** (`src/server/main.ts`): one `http.Server` per bound address (loopback, plus Tailscale addresses), all sharing one request handler and one WebSocket layer. Run directly with `tsx`; there is no server build step.
- **UI** (`src/ui`): built by Vite into `dist/ui` and served as static files. It can be rebuilt without restarting the server, which is why the protocol has compatibility rules (below).
- **Engines** (`src/server/engine`): every model call goes through an official client that you logged in to. The server never calls a model API itself and never reads credential files.
- **Graceful restart** (`src/server/lifecycle.ts`): on `SIGTERM` or `SIGUSR2` the server refuses new turns, lets running turns and background work finish (up to `DECK_DRAIN_MAX_MIN`), then exits for a supervisor to restart it.

## Accounts

An account is a Claude Code profile directory (`src/shared/accounts.ts`). For each turn the engine child gets an environment in which:

- `CLAUDE_CONFIG_DIR` selects the profile. The default profile `~/.claude` is run with the variable **unset**; setting it changes how the CLI names its stored login.
- `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL` and the Bedrock/Vertex switches are removed. An inherited token would override the profile and bill another account.

Which accounts exist is configuration, not code: `<config dir>/accounts.json` (`src/server/accounts.ts`), or, when that file is missing, the profiles found in the home directory (`~/.claude` as `a`, `~/.claude-<one letter>`). A file that exists but is invalid stops the server with the path and reason; it never falls back to discovery. The result is an `AccountRegistry`, passed to every component that needs account names, labels, card ids or profile directories. Ids are the persistent key (session state, cooldown file names, usage rows). A *retired* account stays in `all()` (its sessions and usage are read) but not in `list()` (routing, pickers, pins).

The *home* account (top-level `home`) is the single profile Claude Desktop uses; write-back targets it. The *protected* account is one the user also works in directly; automatic routing ranks it last. It comes from `CLAUDE_PROTECT` or `~/.config/offload/protect`, not from `accounts.json`.

## Turn flow

`TurnRunner` (`src/server/turn/TurnRunner.ts`) owns a turn from the `send` message to its `turn_result`.

1. **Engine.** A new session's engine is decided once (`routing/EngineChoice.ts`): Claude, Codex, or *auto*, which opens on Codex only when Codex has clearly more weekly room than the best Claude account. Gemini is never chosen automatically. An existing session keeps its engine, because the engines' session formats differ.
2. **Account** (Claude only, `routing/AccountRouter.ts`), decided for every turn:
   - a pinned session uses its pin unless that account is excluded;
   - a session stays on its account while the prompt cache is warm (`WARM_MS`, 55 minutes);
   - it must switch at 80% of the 5-hour window, 85% of the weekly window, or during a cooldown;
   - accounts at 95% or more, in cooldown, or with stale usage data are not candidates;
   - an account whose usage is unknown (no dashboard, no card, a stale card) is a later-tier candidate: after candidates with known usage, before accounts known to be at their limit;
   - candidates are ordered by the routing policy: `balance` (lowest 5-hour usage) or `drain` (`(100 − weekly%) / hours to weekly reset`, highest first). The protected account is last.
3. **Model** (`routing/ModelPolicy.ts`, `routing/AutoModel.ts`): the session's model, or the per-turn choice. A Fable turn on an account whose Fable window is at 80% runs on Opus instead. An unknown Fable window has the same effect only on an install that has seen a usage dashboard answer (strict mode, see Usage data); otherwise the turn runs as requested.
4. **Relocation.** If the chosen account differs from where the session's transcript lives, `SessionMover` copies the transcript (and its side files) into the target profile's `projects/` directory and verifies the copy by hash. The source is never modified. If the copies have diverged, the move is refused rather than overwritten, except that a diverged copy outside the home/protected profile is backed up first.
5. **Run.** `ClaudeEngine` calls the Agent SDK with `resume`, the session's permission mode and the user/project/local setting sources. Engine events are mapped to protocol messages and emitted to the turn's sink. Permission requests arrive through the SDK's `canUseTool` callback, are shown as cards on every connected device, and each decision is appended to the audit log.
6. **Retry.** `limitDetect.ts` classifies a failed result from the SDK's own error text. A `limit` failure puts the account on cooldown for 1 hour and an `auth` failure for 6 hours; the session is relocated and the same turn is retried on the next account, at most 2 times. Cooldowns are plain files (`<cooldown dir>/<account id>` holding a Unix time) so other local tools can share them.
7. **Write-back.** After a turn on a non-home account, the transcript is mirrored to the home profile so Claude Desktop sees the current conversation.

Codex and Gemini turns skip steps 2 and 4–7: one child process per turn, a sandbox instead of approval cards, and an in-memory cooldown after a quota error.

**Steering.** With `DECK_STEER` on, a message sent while a Claude turn runs is written to the live process and picked up at the next tool boundary; otherwise it queues for after the turn. A session runs one turn at a time.

**Background work.** When a turn ends while the CLI still has background tasks, the process is held open (up to `DECK_BG_MAX_MIN`) and later output continues under the same session.

## Session storage

The server does not own conversations. Transcripts stay in the CLIs' own files:

| Data | Location | Owner |
|---|---|---|
| Claude transcripts | `<profile>/projects/<cwd slug>/<session id>.jsonl` | Claude Code |
| Codex rollouts | `$CODEX_HOME/sessions/…` | Codex CLI (read-only for deck) |
| Claude Desktop session records | macOS app support directory | Claude Desktop (read-only; titles and recency) |
| Per-session account, model, pin, permission mode | `session-state.json` | deck |
| Titles, archive flags, sidebar pins | `session-meta.json`, `pins.json` | deck |
| Fork backups, trash | `<profile>/session-backups/`, `<profile>/session-trash/` | deck (pruned after `DECK_BACKUP_RETENTION_DAYS`) |

`SessionIndex` scans every profile's `projects/` directory and groups sessions by working directory. `ProcessHolders` reads `ps` output to mark sessions another `claude` process has resumed, since that process will continue from its own in-memory history.

## Usage data

`UsageService` keeps one snapshot of the 5-hour, weekly and Fable windows per account. It has two sources: an optional external dashboard polled every 60 seconds (`GET <DECK_URL>/api/state`), and the rate-limit information each CLI reports during a turn, which overrides an older or missing dashboard reading. `UsageIndex` is separate: it incrementally scans local transcripts into token-usage aggregates for the history view (`usage-index-v2.json`; the index can hold 23 Claude accounts over its lifetime, retired and removed ones included).

**Usage source.** `UsageSnapshot.usageSource` is `deck` or `none`. An install that has never had a dashboard answer is `none` (lenient): unknown quota alone changes neither the model nor the engine. The first answer is recorded in `usage-source.json` and the install is `deck` (strict) from then on. `DECK_USAGE_STRICT=1|0` overrides it. Before the first fetch attempt has ended, the snapshot is `deck`.

## WebSocket protocol

Messages are defined in `src/shared/protocol.ts`: client messages as zod schemas, server messages as a TypeScript union. On connect the server sends `hello` with the usage snapshot, the session index, running turns, settings and a `features` list.

Frames are limited to 1 MiB. Turn events go to the socket that started the turn and to sockets that opened that session; permission cards go to every socket.

### Compatibility rules

The UI changes on rebuild and the server on restart, so a new UI talks to an old server and old tabs talk to a new server. [protocol.md](protocol.md) (Korean) is the authoritative text; in short:

1. Add fields only as optional. The receiver keeps its old behavior when a field is absent.
2. Never remove a field, narrow a type or change a meaning. Add a new field instead.
3. Send a new message type only in answer to a request that an old peer would not make.
4. The UI asks what the server can do in exactly one place: `has('<feature>')` in `src/ui/features.ts`, backed by `hello.features`. It does not infer capabilities from field presence or build ids.

Current features: `sessionModel`, `abortLabel`, `catchup`, `accounts`.

## Catch-up

A turn runs to completion on the server whether or not any browser is connected.

- Every turn event carries `pos: { sid, epoch, seq }`. `seq` grows by one per event per session; `epoch` names the process that produced it.
- For each running process the server keeps recent events: up to 5000 events or 4 MiB, cleared after 10 minutes without events once the turn has ended.
- The UI (`src/ui/catchup.ts`) remembers the last `pos` it applied per open session. On reconnect, on returning to the foreground, or when it sees a gap in `seq`, it sends `open_session { after: { epoch, seq } }`.
- The server answers with either `catchup` followed by exactly the missed events, or, when it cannot supply the whole gap, a full `history`. It never sends a partial range.
- `AcceptedRefs` records the client reference of each accepted `send`, so a message that is re-sent after a reconnect runs once.

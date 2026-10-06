import type { Seat } from './accounts';
import type { BranchLink } from './branches';
import type { CodexSandbox, EngineKind } from './models';
import type { ContextUsage } from './turn-types';

/** Who else has a Claude session open: Claude Desktop's own CLI process, or another one (a terminal `claude --resume`). */
export type SessionHolder = 'desktop' | 'other';

export type SessionEntry = {
  sessionId: string;
  /** Claude profile the jsonl lives in, or 'gpt' for a deck-created Codex thread (D4). */
  account: Seat;
  /** Absent = 'claude' (Plan 1 entries). */
  engine?: EngineKind;
  sandbox?: CodexSandbox;
  cwd: string;
  /** Claude: absolute project dir the jsonl currently lives in (never derived from cwd). Codex: dir of the rollout file, or '' until known. */
  projectDir: string;
  file: string;
  title: string;
  lastModified: number;
  sizeBytes: number;
  /** deck-side 보관됨 (session-meta.json); hidden from the lists unless the 보관됨 filter is on. */
  archived?: boolean;
  /** A Codex Desktop / CLI thread read from ~/.codex/sessions that deck has not run yet (becomes a deck Codex session on the first turn). */
  imported?: boolean;
  /** An imported thread from a non-interactive `codex exec` run (shown with a 자동 실행 tag). */
  codexExec?: boolean;
  /** An imported thread from `~/.codex/archived_sessions` (archived in Codex): listed under 보관됨, view only. */
  codexArchived?: boolean;
  /** An imported thread whose folder no longer exists: view only (codex cannot run without its cwd). */
  cwdMissing?: boolean;
  /** 새 세션으로 이어가기 (session-meta.json): the session this one continued from / was continued in. */
  prevSession?: string;
  nextSession?: string;
  /** 메시지 편집 갈래 (session-meta.json): this session was forked from `parent` by editing its user message `n`. */
  branch?: BranchLink;
  /**
   * A `claude` process outside deck has this session resumed right now (process scan, see ProcessHolders). It keeps
   * its own history in memory, so messages sent from both sides fork the conversation. Absent = nobody (or unknown).
   */
  heldBy?: SessionHolder;
};

/** A recent Claude Desktop (Code tab) session; opened like any other session by `sessionId`. */
export type DesktopSession = {
  sessionId: string;
  /** Profile the transcript lives in now (A, or B/C after deck moved it). */
  account: Seat;
  title: string;
  cwd: string;
  /** basename of cwd */
  project: string;
  lastModified: number;
  archived?: boolean;
  heldBy?: SessionHolder;
};

export type PinnedProject = { cwd: string; name?: string };

export type ProjectEntry = { cwd: string; name: string; pinned: boolean; sessions: SessionEntry[] };

export type TranscriptMessage =
  /** `n`: ordinal among the session's user messages (0 = first), counted over the whole transcript (Claude only). */
  | { kind: 'user'; text: string; ts: string | null; n?: number }
  | { kind: 'assistant'; text: string; model: string | null; toolCalls: { id: string; name: string; input: unknown }[]; ts: string | null; /** Claude transcripts: the turn's thinking text, and whether an encrypted (redacted) block was in it. */ thinking?: string; thinkingRedacted?: boolean; /** The API call's prompt tokens (Claude transcripts): restores the context gauge. */ usage?: ContextUsage }
  | { kind: 'tool_result'; toolUseId: string; content: string; isError: boolean; ts: string | null; /** content was cut to the size cap */ truncated?: boolean }
  /** A hook's message to the model (Claude Code logs it as an `isMeta` user line), e.g. a Stop hook sending it back to work. `event`: Stop, PreToolUse… */
  | { kind: 'system'; source: string; label: string; text: string; ts: string | null };

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Account, AccountNames, AccountRegistry, AccountRoot } from '../shared/accounts';
import { loadAccountRegistry } from './accounts';
import { resolveCodexBin } from './engine/CodexEngine';
import { resolveGeminiBin } from './engine/GeminiEngine';
import { defaultCooldownDir } from './routing/cooldown';

export type DeckConfig = {
  home: string;
  configDir: string;
  tokenFile: string;
  pinnedFile: string;
  stateFile: string;
  auditFile: string;
  deckUrl: string;
  /** Claude accounts: `<configDir>/accounts.json`, else the profiles found in the home dir. */
  accounts: AccountRegistry;
  protectedAccount: Account | null;
  cooldownDir: string;
  port: number;
  loopbackOnly: boolean;
  devOrigins: string[];
  /** `projects` dir of every configured account (retired included), in configured order. */
  projectsRoots: readonly AccountRoot[];
  uiDir: string;
  /** Deviation (added per review I5): extra Host-header names (e.g. Tailscale MagicDNS) allowed in addition to loopback/CGNAT. */
  extraHosts: string[];
  /** D11: null = Codex disabled (no `codex` binary found). */
  codexBin: string | null;
  /** null = Gemini disabled (no `gemini` binary found). Accounts live under `<configDir>/gemini/<g1|g2>`. */
  geminiBin: string | null;
  /** `$CODEX_HOME/sessions` (rollout files; read-only for deck). */
  codexSessionsRoot: string;
  /** `$CODEX_HOME/archived_sessions` (threads archived in Codex; read-only for deck, listed under 보관됨). */
  codexArchivedRoot: string;
  /** D7: private attachment dir (0700) under the config dir. */
  attachmentsDir: string;
  /** F1: folders opened with 폴더 열기 (newest first, max 20). */
  recentFoldersFile: string;
  /** F2: pinned session ids. */
  pinsFile: string;
  /** Server settings (자동 승인). */
  settingsFile: string;
  /** F1: a new session's cwd must lie inside one of these: home, plus `DECK_EXTRA_CWD_ROOTS` (E2E temp dirs; loopback-only servers, never `/`). */
  cwdRoots: string[];
  /** Claude Desktop's Code-tab session records (read-only; titles/recency of Desktop sessions). */
  desktopSessionsRoot: string;
  /** Graceful restart (SIGTERM/SIGUSR2): how long running turns and background work may finish (`DECK_DRAIN_MAX_MIN`, default 15). */
  drainMaxMs: number;
  /** How long a CLI process is held open for background tasks after its turn (`DECK_BG_MAX_MIN`, default 120). */
  bgMaxMs: number;
  /** Messages typed while a Claude turn runs go into it at the next tool boundary (`DECK_STEER=0` turns it off: queued for after the turn). */
  steer: boolean;
  /** Fork backups (`<profile>/session-backups/`) and 삭제 trash (`<profile>/session-trash/`) older than this many days are deleted (`DECK_BACKUP_RETENTION_DAYS`, default 30). */
  backupRetentionDays: number;
  /** Web Push: VAPID keypair (0600, generated once) and browser subscriptions (0600). */
  vapidFile: string;
  pushSubscriptionsFile: string;
  /** 사용량 view: token usage aggregates + per-file read offsets (index format 2). */
  /** `{"deckSeenAt": "<ISO>"}`: written once, the first time usage-deck answers (see UsageService). */
  usageSourceFile: string;
  /** `DECK_USAGE_STRICT`: `1` = always treat unknown usage as with usage-deck (Fable → Opus), `0` = never; null = by `usageSourceFile`. */
  usageStrict: boolean | null;
  /** The usage-deck address was set by the user (`DECK_URL`, or `~/.config/claude-pick/deck_url`), not the default: an install that expects usage-deck. */
  deckUrlConfigured: boolean;
  usageIndexFile: string;
  /** The format-1 index a build before configurable accounts wrote: converted once into `usageIndexFile`, never written. */
  usageIndexV1File: string;
  /** VAPID `sub` claim override (`DECK_VAPID_SUBJECT`, https: or mailto:); default derived from the MagicDNS name. */
  vapidSubject: string | null;
};

/** ~/.config/offload/protect: comment lines start with '#'; the first non-blank token must be a configured account — any other is no protection, and `warn` is told once. */
export function readProtect(file: string, accounts: AccountNames, warn: (line: string) => void = () => {}): Account | null {
  try {
    for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const tok = line.split(/\s+/)[0];
      if (accounts.has(tok)) return tok;
      warn(`deck: 보호 계정 "${tok}"(${file})는 설정에 없는 계정이라 무시합니다 — 보호 계정 없이 시작합니다 (계정: ${accounts.all().join(', ')})`);
      return null;
    }
  } catch {
    // missing file
  }
  return null;
}

const DEFAULT_DECK_URL = 'http://127.0.0.1:9310';

export function readDeckUrl(file: string, fallback = DEFAULT_DECK_URL): string {
  try {
    const first = fs.readFileSync(file, 'utf8').split('\n')[0]?.trim() ?? '';
    return first || fallback;
  } catch {
    return fallback;
  }
}

/** Review fix 2: extra new-session roots exist for the E2E harnesses only — honoured on a loopback-only server, and `/` is never a root. */
function extraCwdRoots(env: NodeJS.ProcessEnv): string[] {
  if (env.DECK_LOOPBACK_ONLY !== '1') return [];
  return (env.DECK_EXTRA_CWD_ROOTS ?? '').split(',').map((s) => s.trim()).filter((s) => s.startsWith('/') && path.resolve(s) !== '/');
}

/** Positive minutes from env as ms, else the default. */
function minutes(v: string | undefined, fallbackMin: number): number {
  const n = Number(v);
  return (Number.isFinite(n) && n > 0 ? n : fallbackMin) * 60_000;
}

export function repoRootDefault(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

/** Throws `AccountsFileError` when `<configDir>/accounts.json` is there and cannot be used. `log`: startup notes (skipped profile dirs, an unknown protected account). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir(), repoRoot: string = repoRootDefault(), log: (line: string) => void = (l) => console.error(l)): DeckConfig {
  const configDir = env.DECK_CONFIG_DIR || path.join(home, '.config', 'deck');
  const accounts = loadAccountRegistry({ configDir, homeDir: home, log });
  // CLAUDE_PROTECT wins over the file; a value that is not a configured account falls through to the file, with a warning.
  if (env.CLAUDE_PROTECT && !accounts.has(env.CLAUDE_PROTECT)) log(`deck: CLAUDE_PROTECT="${env.CLAUDE_PROTECT}" 는 설정에 없는 계정이라 무시합니다 (계정: ${accounts.all().join(', ')})`);
  const deckUrlFromFile = readDeckUrl(path.join(home, '.config', 'claude-pick', 'deck_url'), '');
  const protectedAccount = accounts.has(env.CLAUDE_PROTECT) ? env.CLAUDE_PROTECT : readProtect(path.join(home, '.config', 'offload', 'protect'), accounts, log);
  return {
    home,
    configDir,
    accounts,
    tokenFile: path.join(configDir, 'token'),
    pinnedFile: path.join(configDir, 'projects.json'),
    stateFile: path.join(configDir, 'session-state.json'),
    auditFile: path.join(configDir, 'audit.log'),
    deckUrl: env.DECK_URL || deckUrlFromFile || DEFAULT_DECK_URL,
    protectedAccount,
    cooldownDir: defaultCooldownDir(env, home),
    port: Number(env.DECK_PORT) || 9320,
    loopbackOnly: env.DECK_LOOPBACK_ONLY === '1',
    devOrigins: (env.DECK_DEV_ORIGIN ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    projectsRoots: accounts.projectsRoots(),
    uiDir: env.DECK_UI_DIR || path.join(repoRoot, 'dist', 'ui'),
    extraHosts: (env.DECK_EXTRA_HOSTS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    codexBin: resolveCodexBin(env, home),
    geminiBin: resolveGeminiBin(env, home),
    codexSessionsRoot: path.join(env.CODEX_HOME || path.join(home, '.codex'), 'sessions'),
    codexArchivedRoot: path.join(env.CODEX_HOME || path.join(home, '.codex'), 'archived_sessions'),
    attachmentsDir: path.join(configDir, 'attachments'),
    recentFoldersFile: path.join(configDir, 'recent-folders.json'),
    pinsFile: path.join(configDir, 'pins.json'),
    settingsFile: path.join(configDir, 'settings.json'),
    cwdRoots: [home, ...extraCwdRoots(env)],
    desktopSessionsRoot: env.DECK_DESKTOP_SESSIONS_DIR || path.join(home, 'Library', 'Application Support', 'Claude', 'claude-code-sessions'),
    drainMaxMs: minutes(env.DECK_DRAIN_MAX_MIN, 15),
    bgMaxMs: minutes(env.DECK_BG_MAX_MIN, 120),
    steer: env.DECK_STEER !== '0',
    backupRetentionDays: Number(env.DECK_BACKUP_RETENTION_DAYS) > 0 ? Number(env.DECK_BACKUP_RETENTION_DAYS) : 30,
    vapidFile: path.join(configDir, 'vapid.json'),
    pushSubscriptionsFile: path.join(configDir, 'push-subscriptions.json'),
    usageSourceFile: path.join(configDir, 'usage-source.json'),
    usageStrict: env.DECK_USAGE_STRICT === '1' ? true : env.DECK_USAGE_STRICT === '0' ? false : null,
    deckUrlConfigured: !!env.DECK_URL || deckUrlFromFile !== '',
    usageIndexFile: path.join(configDir, 'usage-index-v2.json'),
    usageIndexV1File: path.join(configDir, 'usage-index.json'),
    vapidSubject: /^(https:|mailto:)/.test(env.DECK_VAPID_SUBJECT ?? '') ? env.DECK_VAPID_SUBJECT! : null,
  };
}

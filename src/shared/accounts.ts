/**
 * A Claude account id: the persistent key of one Claude profile (session state, cooldown file name, usage rows).
 * Which ids exist is configuration (`AccountRegistry`), not a type — validate with `registry.has()`.
 */
export type Account = string;

export const ACCOUNT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,15}$/;

/**
 * Never a Claude account: ids that already mean another seat or usage source (`Seat`, `UsageSource`), the words the
 * UI and the wire use for "no account" (`auto`, `none`, a stringified null), and an Object.prototype member (ids key plain objects).
 */
export const RESERVED_ACCOUNT_IDS: readonly string[] = ['gpt', 'g1', 'g2', 'codex', 'all', 'auto', 'none', 'null', 'undefined', 'constructor'];

/** One entry of `<configDir>/accounts.json`. */
export type AccountSpec = {
  id: string;
  /** Default `id.toUpperCase()`. */
  label?: string;
  /** Profile dir (`~` = the home dir). Default `~/.claude` for `a`, else `~/.claude-<id>`. */
  configDir?: string;
  /** usage-deck card id. Default `claude:main|second|third` for a|b|c (claude-pick), else `claude:<id>`. */
  card?: string;
  /** Read-only: sessions and usage stay visible, the router and pickers skip it. */
  retired?: boolean;
};

/** `<configDir>/accounts.json`. `home`: the profile Claude Desktop reads and writes (default `a`, else the first active account). */
export type AccountsConfig = { version: 1; home?: string; accounts: AccountSpec[] };

/** The part of the registry that needs no paths (routing, labels, usage cards). */
export interface AccountNames {
  /** Active accounts, in configured order (the order ties are broken in). */
  list(): readonly Account[];
  /** Active and retired accounts, in configured order. */
  all(): readonly Account[];
  /** A configured account (active or retired). */
  has(id: unknown): id is Account;
  isRetired(id: Account): boolean;
  /** Any id has a label: an id that is no longer configured shows as `ID`. */
  label(id: Account): string;
  /** usage-deck card id (`claude:<id>` for an id that is not configured). */
  cardId(id: Account): string;
  /** The profile Claude Desktop reads and writes: deck mirrors sessions it ran elsewhere back there. */
  readonly home: Account;
  isHome(id: Account): boolean;
  /** The account to use when nothing ranks: the first active account that is neither `protect` nor home (`b` in the a/b/c set), else the first that is not `protect`, else the only one there is. */
  fallback(protect: Account | null): Account;
}

/** One account's `projects` dir. A list, not an object keyed by id: object keys that look like numbers do not keep their order. */
export type AccountRoot = { id: Account; dir: string };

/** What the session readers take: the registry's ordered list (`registry.projectsRoots()`). */
export type ProjectsRoots = readonly AccountRoot[];

export interface AccountRegistry extends AccountNames {
  /** Throws for an id that is not configured (never guess a profile: the turn would bill another account). */
  profileDir(id: Account): string;
  projectsDir(id: Account): string;
  /** `projects` dir of every configured account (retired included), in configured order. */
  projectsRoots(): readonly AccountRoot[];
  /**
   * Environment for one SDK turn. Copies `base`, removes every token variable (env tokens override the config dir
   * and would silently bill another account) and the base-URL / Bedrock / Vertex / entrypoint variables, and selects
   * the profile: the default dir `~/.claude` = no CLAUDE_CONFIG_DIR (keychain service name has no hash suffix), any
   * other = CLAUDE_CONFIG_DIR. Throws for an id that is not configured.
   */
  env(id: Account, base: NodeJS.ProcessEnv): Record<string, string | undefined>;
}

/** claude-pick's card ids for the first three accounts. */
const LEGACY_CARD: ReadonlyMap<string, string> = new Map([['a', 'claude:main'], ['b', 'claude:second'], ['c', 'claude:third']]);

const TOKEN_VARS = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'] as const;

/** Inherited from a parent Claude Code / proxy setup, these would send the turn elsewhere or mislabel it. */
const ROUTING_VARS = ['ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_ENTRYPOINT'] as const;

/** `~` → the home dir, then what `path.resolve` does to an absolute path (`.`, `..`, `//`, trailing `/`); a relative path is returned as it is. */
function expandDir(dir: string, homeDir: string): string {
  const d = dir === '~' ? homeDir : dir.startsWith('~/') ? `${homeDir}/${dir.slice(2)}` : dir;
  if (!d.startsWith('/')) return d;
  const out: string[] = [];
  for (const part of d.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return `/${out.join('/')}`;
}

/**
 * The registry for a parsed config. Throws (with the reason) on an id that is not `ACCOUNT_ID_RE` or is reserved,
 * a duplicate id / profile dir / card, a relative profile dir, a `home` that is not an active account, or no active account.
 * Two profile dirs are the same when their normalized paths are, or — with `canonical` (the server passes realpath) —
 * when their canonical forms are. The canonical form is only compared: the CLI gets the configured spelling, because
 * CLAUDE_CONFIG_DIR names the keychain entry.
 */
export function buildRegistry(config: AccountsConfig, opts: { homeDir: string; canonical?: (dir: string) => string }): AccountRegistry {
  const homeDir = expandDir(opts.homeDir, opts.homeDir);
  const canonical = opts.canonical ?? ((d: string) => d);
  const defaultDir = expandDir(`${homeDir}/.claude`, homeDir);
  type Entry = { id: Account; label: string; dir: string; card: string; retired: boolean };
  const byId = new Map<Account, Entry>();
  const dirs = new Map<string, Account>();
  const cards = new Map<string, Account>();
  for (const spec of config.accounts) {
    const id = spec.id;
    if (typeof id !== 'string' || !ACCOUNT_ID_RE.test(id)) throw new Error(`계정 id "${String(id)}" 는 쓸 수 없습니다 (${ACCOUNT_ID_RE.source})`);
    if (RESERVED_ACCOUNT_IDS.includes(id)) throw new Error(`계정 id "${id}" 는 다른 자리에 쓰는 이름입니다 (${RESERVED_ACCOUNT_IDS.join(', ')})`);
    if (byId.has(id)) throw new Error(`계정 id 중복: ${id}`);
    const dir = expandDir(spec.configDir ?? (id === 'a' ? defaultDir : `${homeDir}/.claude-${id}`), homeDir);
    if (!dir.startsWith('/')) throw new Error(`계정 ${id} 의 configDir "${dir}" 는 절대 경로(또는 ~/…)여야 합니다`);
    const card = spec.card ?? LEGACY_CARD.get(id) ?? `claude:${id}`;
    const real = canonical(dir);
    const sameDir = dirs.get(real);
    if (sameDir !== undefined) throw new Error(`계정 ${sameDir} 와 ${id} 의 configDir 이 같은 디렉터리입니다: ${dir}${real === dir ? '' : ` (→ ${real})`}`);
    const sameCard = cards.get(card);
    if (sameCard !== undefined) throw new Error(`계정 ${sameCard} 와 ${id} 의 card 가 같습니다: ${card}`);
    dirs.set(real, id);
    cards.set(card, id);
    byId.set(id, { id, label: spec.label || id.toUpperCase(), dir, card, retired: spec.retired === true });
  }
  const all: readonly Account[] = [...byId.keys()];
  const active: readonly Account[] = all.filter((id) => !byId.get(id)!.retired);
  const first = active[0];
  if (first === undefined) throw new Error('쓸 수 있는(retired 가 아닌) 계정이 하나도 없습니다');
  const home = config.home ?? (active.includes('a') ? 'a' : first);
  if (!active.includes(home)) throw new Error(`home "${home}" 은 쓸 수 있는 계정이 아닙니다`);
  const known = (id: Account): Entry => {
    const e = typeof id === 'string' ? byId.get(id) : undefined;
    if (!e) throw new Error(`설정에 없는 계정: ${String(id)}`);
    return e;
  };
  const get = (id: Account): Entry | undefined => (typeof id === 'string' ? byId.get(id) : undefined);
  const roots: readonly AccountRoot[] = all.map((id) => ({ id, dir: `${known(id).dir}/projects` }));
  return {
    list: () => active,
    all: () => all,
    has: (id: unknown): id is Account => typeof id === 'string' && byId.has(id),
    isRetired: (id) => get(id)?.retired ?? false,
    label: (id) => get(id)?.label ?? String(id).toUpperCase(),
    cardId: (id) => get(id)?.card ?? `claude:${id}`,
    home,
    isHome: (id) => id === home,
    fallback: (protect) => active.find((id) => id !== protect && id !== home) ?? active.find((id) => id !== protect) ?? first,
    profileDir: (id) => known(id).dir,
    projectsDir: (id) => `${known(id).dir}/projects`,
    projectsRoots: () => roots,
    env: (id, base) => {
      const dir = known(id).dir;
      const env: Record<string, string | undefined> = { ...base };
      for (const v of [...TOKEN_VARS, ...ROUTING_VARS]) delete env[v];
      if (dir === defaultDir) delete env.CLAUDE_CONFIG_DIR;
      else env.CLAUDE_CONFIG_DIR = dir;
      return env;
    },
  };
}

/**
 * The config used when there is no accounts.json, from the names of the profile directories found in the home dir:
 * `.claude` → a, `.claude-<one letter>` → that letter in lower case (`configDir` keeps the real name when it differs),
 * sorted by id. Nothing else is taken for an account — `.claude-backup`, `.claude-2`, `.claude-old` are what people
 * name copies — and each such name gets one `note` line with the accounts.json entry that would add it. So do
 * `.claude-a` (a is `~/.claude`) and a second spelling of a letter. Home = a, else the first. Nothing found = a alone
 * (`~/.claude` appears at the first login).
 */
export function defaultAccountsConfig(profileNames: readonly string[], note: (line: string) => void = () => {}): AccountsConfig {
  const found = new Map<string, AccountSpec>();
  const skip = (name: string, why: string, id: string | null) =>
    note(`deck: ~/${name} 은 ${why} — 계정으로 쓰려면 accounts.json 에 추가하세요: ${JSON.stringify({ id: id ?? '<id>', configDir: `~/${name}` })}`);
  // The exact lower-case spelling first, so `.claude-b` wins over `.claude-B`.
  const names = [...new Set(profileNames)].sort((x, y) => Number(x !== x.toLowerCase()) - Number(y !== y.toLowerCase()) || (x < y ? -1 : 1));
  for (const name of names) {
    if (name === '.claude') found.set('a', { id: 'a' });
    if (!name.startsWith('.claude-') || name.length === '.claude-'.length) continue;
    const suffix = name.slice('.claude-'.length);
    const id = suffix.toLowerCase();
    const usable = ACCOUNT_ID_RE.test(id) && !RESERVED_ACCOUNT_IDS.includes(id);
    if (!/^[a-z]$/.test(id)) skip(name, '자동으로 계정으로 쓰지 않습니다(자동 발견은 ~/.claude 와 ~/.claude-<한 글자>만)', usable ? id : null);
    else if (id === 'a') skip(name, '자동으로 계정으로 쓰지 않습니다(계정 a 는 ~/.claude)', null);
    else if (found.has(id)) skip(name, `건너뜁니다(계정 ${id} 는 이미 ~/.claude-${id})`, null);
    else found.set(id, name === `.claude-${id}` ? { id } : { id, configDir: `~/${name}` });
  }
  if (found.size === 0) found.set('a', { id: 'a' });
  const sorted = [...found.keys()].sort();
  return { version: 1, home: found.has('a') ? 'a' : (sorted[0] as string), accounts: sorted.map((id) => found.get(id) as AccountSpec) };
}

/**
 * The a/b/c names deck had before accounts.json — for one caller only: a new UI attached to an old server whose
 * `hello` has no `accounts` falls back to these (`src/ui/accounts.ts`). Server code takes the registry it is given
 * (`loadAccountRegistry`), never this.
 */
export const LEGACY_ACCOUNTS: AccountNames = buildRegistry(defaultAccountsConfig(['.claude', '.claude-b', '.claude-c']), { homeDir: '/' });

/** Two Google accounts for gemini-cli, each with its own GEMINI_CLI_HOME (never chosen by 자동). */
export type GeminiAccount = 'g1' | 'g2';
export const GEMINI_ACCOUNTS: readonly GeminiAccount[] = ['g1', 'g2'];

export function isGeminiAccount(x: unknown): x is GeminiAccount {
  return x === 'g1' || x === 'g2';
}

/** g1 → `<deck config dir>/gemini/g1` (`~/.config/deck/gemini/g1` unless DECK_CONFIG_DIR): gemini-cli keeps everything (OAuth file, settings, chats) under `$GEMINI_CLI_HOME/.gemini`. */
export function geminiHome(account: GeminiAccount, configDir: string): string {
  return `${configDir}/gemini/${account}`;
}

/** The OAuth file gemini-cli writes after "Login with Google". deck only checks that it exists — never reads it. */
export function geminiCredFile(account: GeminiAccount, configDir: string): string {
  return `${geminiHome(account, configDir)}/.gemini/oauth_creds.json`;
}

/** Who ran a turn: a Claude account, the single ChatGPT Pro account, or a Gemini account. */
export type Seat = Account | 'gpt' | GeminiAccount;
/** Seats with a usage card (Gemini quota is not readable locally). */
export type UsageSeat = Account | 'gpt';
export const GEMINI_LABEL: Record<GeminiAccount, string> = { g1: 'G1', g2: 'G2' };

const OPENAI_VARS = ['OPENAI_API_KEY', 'OPENAI_BASE_URL'] as const;

/**
 * Environment for one Codex CLI turn: the base env minus every OpenAI/Anthropic token and routing
 * variable. CODEX_HOME passes through untouched — the CLI owns its auth store; deck never reads it.
 */
export function codexEnv(base: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...base };
  for (const v of [...TOKEN_VARS, ...ROUTING_VARS, ...OPENAI_VARS]) delete env[v];
  return env;
}

/** API keys, ADC, Vertex and endpoint overrides: any of these would bypass the per-account OAuth login. */
const GEMINI_VARS = [
  'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_GENAI_USE_VERTEXAI', 'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_CLOUD_PROJECT_ID', 'GOOGLE_CLOUD_LOCATION', 'GOOGLE_GEMINI_BASE_URL', 'GOOGLE_VERTEX_BASE_URL', 'GEMINI_CLI_USE_COMPUTE_ADC', 'CLOUD_SHELL',
  // Keychain/encrypted storage uses one shared entry ("gemini-cli-oauth" / "main-account"): g1 and g2 would collide.
  'GEMINI_FORCE_ENCRYPTED_FILE_STORAGE',
  // The sandbox is chosen by deck, not inherited.
  'GEMINI_SANDBOX', 'SEATBELT_PROFILE', 'GEMINI_CLI_TRUST_WORKSPACE', 'GEMINI_CLI_HOME',
] as const;

/**
 * Environment for one gemini-cli turn: the base env minus every Anthropic/OpenAI/Google token and routing variable,
 * GEMINI_CLI_HOME pinned to the account's dir (under the deck config dir), and GOOGLE_GENAI_USE_GCA so headless runs use the account's
 * "Login with Google" OAuth file. deck never reads that file.
 */
export function geminiEnv(account: GeminiAccount, base: NodeJS.ProcessEnv, configDir: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...base };
  for (const v of [...TOKEN_VARS, ...ROUTING_VARS, ...OPENAI_VARS, ...GEMINI_VARS]) delete env[v];
  env.GEMINI_CLI_HOME = geminiHome(account, configDir);
  env.GOOGLE_GENAI_USE_GCA = 'true';
  // macOS seatbelt: writes only to the workspace, tmp/cache and the account's .gemini dir.
  env.SEATBELT_PROFILE = 'permissive-open';
  return env;
}

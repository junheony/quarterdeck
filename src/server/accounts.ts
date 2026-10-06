import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { ACCOUNT_ID_RE, buildRegistry, defaultAccountsConfig, type AccountRegistry, type AccountSpec } from '../shared/accounts';

/** `<configDir>/accounts.json` (optional). Unknown fields are ignored. */
const accountsFileSchema = z.object({
  version: z.literal(1),
  home: z.string().optional(),
  accounts: z.array(z.object({
    id: z.string().regex(ACCOUNT_ID_RE),
    label: z.string().min(1).max(40).optional(),
    configDir: z.string().min(1).optional(),
    card: z.string().min(1).optional(),
    retired: z.boolean().optional(),
  })),
});

function exists(p: string): boolean {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Names of the profile-looking directories in the home dir: `.claude`, and every `.claude-<x>` directory that holds a
 * `projects` dir or a `.claude.json` (what a profile has once it was logged in or used) — a same-looking directory
 * that is not a profile (plugin data, an emptied backup) is not even mentioned. Which of these become accounts is
 * `defaultAccountsConfig`'s rule. Only names and existence are read.
 */
export function discoverProfileNames(homeDir: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(homeDir);
  } catch {
    return [];
  }
  const isDir = (p: string) => {
    try {
      return fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  };
  return names
    .filter((n) => n === '.claude' || n.startsWith('.claude-'))
    .filter((n) => {
      const dir = path.join(homeDir, n);
      if (!isDir(dir)) return false;
      return n === '.claude' || isDir(path.join(dir, 'projects')) || exists(path.join(dir, '.claude.json'));
    })
    .sort();
}

/** `accounts.json` is there and cannot be used. The message names the file and the reason; the server prints it and does not start. */
export class AccountsFileError extends Error {
  override name = 'AccountsFileError';
}

/** The real directory behind a profile dir (symlinks, letter case on a case-insensitive disk); a dir that does not exist yet is itself. */
function canonicalDir(dir: string): string {
  try {
    return fs.realpathSync.native(dir);
  } catch {
    return path.resolve(dir);
  }
}

/**
 * The registry of the profiles found in the home dir. Never throws: a candidate that cannot join the ones before it
 * (the same directory under another name) is logged and skipped, and with nothing left the account is `a`.
 */
function discoverRegistry(homeDir: string, log: (line: string) => void): AccountRegistry {
  const build = (accounts: AccountSpec[]) => buildRegistry({ version: 1, accounts }, { homeDir, canonical: canonicalDir });
  const kept: AccountSpec[] = [];
  for (const spec of defaultAccountsConfig(discoverProfileNames(homeDir), log).accounts) {
    try {
      build([...kept, spec]);
      kept.push(spec);
    } catch (err) {
      log(`deck: 자동 발견한 계정 ${spec.id} 를 건너뜁니다 — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  try {
    return build(kept);
  } catch {
    return buildRegistry({ version: 1, accounts: [{ id: 'a' }] }, { homeDir });
  }
}

/**
 * The account registry: `<configDir>/accounts.json` when there is one, else the profiles found in the home dir
 * (`~/.claude`, `~/.claude-<one letter>`).
 * A file that is there but cannot be used (unreadable, broken JSON, schema, duplicate id / dir / card, unknown home, …)
 * throws `AccountsFileError`: falling back to discovery would bring back accounts the file had removed or retired and
 * move `home`. Only a missing file means discovery, and discovery never throws.
 */
export function loadAccountRegistry(opts: { configDir: string; homeDir: string; log?: (line: string) => void }): AccountRegistry {
  const file = path.join(opts.configDir, 'accounts.json');
  const refuse = (reason: string) => new AccountsFileError(`deck: ${file} 을 쓸 수 없어 시작하지 않습니다 — ${reason}\n      파일을 고친 뒤 다시 시작하세요. (파일이 없을 때만 ~/.claude, ~/.claude-<한 글자> 를 자동으로 찾습니다.)`);
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return discoverRegistry(opts.homeDir, opts.log ?? console.error);
    throw refuse(`읽지 못함 (${(err as NodeJS.ErrnoException).code ?? String(err)})`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw refuse(`JSON 이 아닙니다 (${err instanceof Error ? err.message : String(err)})`);
  }
  const parsed = accountsFileSchema.safeParse(json);
  if (!parsed.success) throw refuse(parsed.error.issues.map((i) => `${i.path.join('.') || '(최상위)'}: ${i.message}`).join('; '));
  try {
    return buildRegistry(parsed.data, { homeDir: opts.homeDir, canonical: canonicalDir });
  } catch (err) {
    throw refuse(err instanceof Error ? err.message : String(err));
  }
}

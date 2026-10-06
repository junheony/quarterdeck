import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Repository hygiene check (src/hygiene.test.ts): no file that ships may hold anything key-shaped, nor match
 * the rules of an optional local rules file (`.hygiene-private.json`: `[{ name, pattern, flags?, allow? }]`,
 * JavaScript regular expressions) — the place for values specific to one checkout. Rules apply to file
 * contents and to file names.
 */
export type Rule = { name: string; pattern: RegExp; /** A match is fine when this matches the matched text. */ allow?: RegExp };

export const RULES_FILE = '.hygiene-private.json';
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git']);
const BINARY = /\.(png|jpe?g|gif|webp|ico|icns|woff2?|ttf|otf|pdf|zip|gz)$/i;
const EXAMPLE = /EXAMPLE/;

/** Key shapes. Anything that must look like one in a fixture stays under the length here or carries EXAMPLE. */
export const GENERIC_RULES: Rule[] = [
  { name: 'api key (sk-…)', pattern: /sk-(?:ant-|proj-)?[A-Za-z0-9_-]{40,}/g, allow: EXAMPLE },
  { name: 'github token', pattern: /(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{30,}/g, allow: EXAMPLE },
  { name: 'aws key id', pattern: /A[KS]IA[0-9A-Z]{16}/g, allow: EXAMPLE },
  { name: 'slack token', pattern: /xox[abprs]-[A-Za-z0-9-]{10,}/g, allow: EXAMPLE },
  { name: 'google api key', pattern: /AIza[0-9A-Za-z_-]{35}/g, allow: EXAMPLE },
  { name: 'macOS temp dir hash', pattern: /\/var\/folders\/[a-z0-9_]{2}\/[a-z0-9_]{10,}\//gi },
  { name: 'private key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
];

/** Rules from a rules file; a missing file is no rules, a malformed one throws (a broken check must not pass). */
export function loadRules(file: string): Rule[] {
  let text: string;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const raw = JSON.parse(text) as Array<{ name: string; pattern: string; flags?: string; allow?: string }>;
  return raw.map((r) => {
    const flags = r.flags ?? '';
    return { name: r.name, pattern: new RegExp(r.pattern, flags.includes('g') ? flags : `${flags}g`), ...(r.allow ? { allow: new RegExp(r.allow, 'i') } : {}) };
  });
}

/** Names of the rules `text` breaks (one entry per match). Compared in NFC, so either spelling of a name is caught. */
export function violations(text: string, rules: Rule[]): string[] {
  const out: string[] = [];
  const s = text.normalize('NFC');
  for (const r of rules) for (const m of s.matchAll(r.pattern)) if (!r.allow?.test(m[0])) out.push(r.name);
  return out;
}

function gitFiles(root: string): string[] | null {
  if (!fs.existsSync(path.join(root, '.git'))) return null;
  try {
    const run = (args: string[], input?: string) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', input, maxBuffer: 64 << 20, stdio: ['pipe', 'pipe', 'ignore'] });
    // Tracked plus not-yet-added (unignored) files: a new file is checked before its first commit.
    const files = run(['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean);
    const attrs = run(['check-attr', '-z', '--stdin', 'export-ignore'], files.join('\0') + '\0').split('\0');
    const ignored = new Set<string>();
    for (let i = 0; i + 2 < attrs.length; i += 3) if (attrs[i + 2] === 'set') ignored.add(attrs[i]!);
    return files.filter((f) => !ignored.has(f));
  } catch {
    return null;
  }
}

function walk(dir: string, rel = ''): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) out.push(...walk(path.join(dir, e.name), path.join(rel, e.name))); }
    else out.push(path.join(rel, e.name));
  }
  return out;
}

/** The files that ship: git's list minus `export-ignore`; without git (a tarball) every file under `root`. */
export function shippedFiles(root: string): string[] {
  return [...new Set(gitFiles(root) ?? walk(root))].sort();
}

/** `file:line rule` (or `file (file name) rule`) per finding — locations only, never the matched text. */
export function scan(root: string, files: string[], rules: Rule[]): string[] {
  const out: string[] = [];
  for (const f of files) {
    for (const name of violations(f, rules)) out.push(`${f} (file name) ${name}`);
    if (BINARY.test(f)) continue;
    let text: string;
    try { text = fs.readFileSync(path.join(root, f), 'utf8'); } catch { continue; } // deleted in the work tree, or not a regular file
    text.split('\n').forEach((line, i) => { for (const name of violations(line, rules)) out.push(`${f}:${i + 1} ${name}`); });
  }
  return out;
}

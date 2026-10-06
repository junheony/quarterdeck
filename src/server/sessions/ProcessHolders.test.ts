import { describe, expect, it } from 'vitest';
import { ProcessHolders, parseHolders } from './ProcessHolders';

const A = 'aa000000-0000-4000-8000-000000000001';
const B = 'bb000000-0000-4000-8000-000000000002';
const C = 'cc000000-0000-4000-8000-000000000003';
const D = 'dd000000-0000-4000-8000-000000000004';
const DECK = 39022;
const ROOT = '/Users/u/Documents/작업/deck/node_modules/';
const SDK = `${ROOT}@anthropic-ai/claude-agent-sdk-darwin-arm64/claude --output-format stream-json --verbose --input-format stream-json --model claude-opus-5-5 --permission-prompt-tool stdio`;
const DESKTOP = '/Users/u/Library/Application Support/Claude/claude-code/2.1.280/claude.app/Contents/MacOS/claude --output-format stream-json --verbose --input-format stream-json';

const PS = [
  `    1     0 /sbin/launchd`,
  `${DECK}     1 node /Users/u/Documents/작업/deck/dist/server/main.js`,
  // deck's own children: one of them holds the same session Desktop does.
  ` 8595 ${DECK} ${SDK} --resume=${A}`,
  `25117 ${DECK} ${SDK} --resume=${B}`,
  // Claude Desktop: the wrapper and the CLI it starts both carry the arguments.
  `32325 71058 /Applications/Claude.app/Contents/Helpers/disclaimer --pgroup -- ${DESKTOP} --resume=${A} --allowedTools mcp__computer-use,mcp__ccd_session__spawn_task`,
  `32326 32325 ${DESKTOP} --resume=${A} --allowedTools mcp__computer-use,mcp__ccd_session__spawn_task`,
  // A terminal CLI, both spellings of the flag.
  `40001   900 claude --resume ${C}`,
  `40002   900 /Users/u/.local/bin/claude --model opus --resume=${D.toUpperCase()} --verbose`,
  `40003   900 vim notes about --resume=${A.slice(0, 8)}`,
  `garbage line`,
  '',
].join('\n');

describe('parseHolders', () => {
  it('lists sessions resumed by processes outside deck: Desktop by its path / ccd tools, anything else as other', () => {
    const held = parseHolders(PS, { pid: DECK, ownRoots: [ROOT] });
    expect(Object.fromEntries(held)).toEqual({ [A]: 'desktop', [C]: 'other', [D]: 'other' });
  });

  it("deck's own CLI children are never holders: by parent pid, by ancestry, and by this repo's node_modules path", () => {
    // A second deck instance (another pid) running the same repo's SDK binary: told apart by path alone.
    expect(parseHolders(`700 600 ${SDK} --resume=${B}`, { pid: DECK, ownRoots: [ROOT] }).size).toBe(0);
    // Started through a wrapper: a grandchild of deck, from a path deck does not own.
    expect(parseHolders(`${DECK} 1 node main.js\n500 ${DECK} sh -c wrapper\n501 500 /opt/claude --resume=${B}`, { pid: DECK }).size).toBe(0);
    // The same line under another parent is somebody else's.
    expect(parseHolders(`501 500 /opt/claude --resume=${B}`, { pid: DECK }).get(B)).toBe('other');
    // An NFD spelling of the repo path (macOS) still matches.
    expect(parseHolders(`700 600 ${SDK.normalize('NFD')} --resume=${B}`, { pid: DECK, ownRoots: [ROOT] }).size).toBe(0);
  });

  it('desktop wins when both kinds hold one session, whatever the order; mcp__ccd_ alone marks Desktop', () => {
    const other = `40001 900 claude --resume ${A}`;
    const desk = `32326 32325 ${DESKTOP} --resume=${A}`;
    expect(parseHolders(`${other}\n${desk}`, { pid: DECK }).get(A)).toBe('desktop');
    expect(parseHolders(`${desk}\n${other}`, { pid: DECK }).get(A)).toBe('desktop');
    expect(parseHolders(`9 8 /x/claude --resume=${B} --allowedTools mcp__ccd_session__x`, { pid: DECK }).get(B)).toBe('desktop');
  });

  it('the short flag counts too: `claude -r <id>`', () => {
    expect(parseHolders(`9 8 claude -r ${C}`, { pid: DECK }).get(C)).toBe('other');
    expect(parseHolders(`9 8 /Users/u/.local/bin/claude --verbose -r  ${C.toUpperCase()}`, { pid: DECK }).get(C)).toBe('other');
    expect(parseHolders(`9 8 node /Users/u/.npm/lib/node_modules/@anthropic-ai/claude-code/cli.js --resume ${C}`, { pid: DECK }).get(C)).toBe('other');
  });

  it('only a claude CLI is a holder: a grep for the flag, a shell wrapper or an editor with the id in its arguments is not', () => {
    const none = (command: string) => expect(parseHolders(`9 8 ${command}`, { pid: DECK }).size, command).toBe(0);
    none(`grep -- --resume=${A}`);
    none(`/usr/bin/grep -r --resume=${A} /Users/u/logs`);
    none(`zsh -c claude --resume ${A}`);
    none(`/bin/sh -c /Users/u/.local/bin/claude --resume=${A}`);
    none(`vim /Users/u/notes/claude --resume=${A}.md`);
    none(`/Users/u/bin/claude-wrapper --resume=${A}`);
    none(`tail -f /Users/u/claude -r ${A}`);
    // Desktop's wrapper counts only with the CLI path behind it.
    none(`/Applications/Claude.app/Contents/Helpers/disclaimer --pgroup --resume=${A}`);
    none(`/Applications/Claude.app/Contents/Helpers/disclaimer --pgroup -- /usr/bin/env FOO=1 --resume=${A}`);
  });

  it('empty or junk output: nobody', () => {
    expect(parseHolders('', { pid: 1 }).size).toBe(0);
    expect(parseHolders('ps: illegal option', { pid: 1 }).size).toBe(0);
  });
});

describe('ProcessHolders', () => {
  it('scans at most once per ttl, reports only changes, and shares a scan in flight', async () => {
    let text = `9 8 claude --resume ${C}`;
    let calls = 0;
    let now = 0;
    const h = new ProcessHolders({ pid: DECK, ttlMs: 5000, now: () => now, ps: async () => { calls++; return text; } });
    expect(h.heldBy(C)).toBeNull();
    expect(await Promise.all([h.refresh(), h.refresh()])).toEqual([true, true]);
    expect(calls).toBe(1);
    expect(h.heldBy(C)).toBe('other');
    expect(h.heldBy(C.toUpperCase())).toBe('other');
    now = 4000;
    text = '';
    expect(await h.refresh()).toBe(false);
    expect(calls).toBe(1);
    now = 6000;
    expect(await h.refresh()).toBe(true);
    expect(h.heldBy(C)).toBeNull();
    now = 12_000;
    expect(await h.refresh()).toBe(false);
    expect(calls).toBe(3);
  });

  it('a failing ps never throws and changes nothing: the last scan stands, and it is not retried before the ttl', async () => {
    let fail = false;
    let calls = 0;
    let now = 0;
    const h = new ProcessHolders({ pid: DECK, ttlMs: 5, now: () => now, ps: async () => { calls++; if (fail) throw new Error('spawn ps ENOENT'); return `9 8 claude --resume ${C}`; } });
    await h.refresh();
    expect(h.heldBy(C)).toBe('other');
    fail = true;
    now = 10;
    await expect(h.refresh()).resolves.toBe(false);
    expect(h.heldBy(C)).toBe('other');
    now = 12;
    await expect(h.refresh()).resolves.toBe(false);
    expect(calls).toBe(2);
    fail = false;
    now = 20;
    await expect(h.refresh()).resolves.toBe(false);
    expect(h.heldBy(C)).toBe('other');
    expect(calls).toBe(3);
  });
});

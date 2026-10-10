import { describe, expect, it } from 'vitest';
import { TCC_DENIAL_NOTICE, isTccDenial } from './tccDenial';

// Real shapes (paths changed): a PreToolUse hook living under ~/Documents that the denied process could not even start,
// then the agent's own probes of the same file.
const HOOK_ERROR =
  "PreToolUse:Agent hook error: [/Users/alice/Documents/work/tools/offload-guard]: shell-init: error retrieving current directory: getcwd: cannot access parent directories: Operation not permitted\n" +
  "/Library/Developer/CommandLineTools/usr/bin/python3: can't open file '/Users/alice/Documents/work/tools/offload-guard': [Errno 1] Operation not permitted\n";
const PY_EPERM =
  'Exit code 1\n.\nTraceback (most recent call last):\n  File "<string>", line 1, in <module>\n' +
  "PermissionError: [Errno 1] Operation not permitted: '/Users/alice/Documents/work/tools/offload-guard'";
const HEAD_EPERM =
  'Exit code 1\ndrwxr-xr-x@ 129 alice  staff  4128 10월  8 19:27 /Users/alice/Documents/work\n' +
  'head: /Users/alice/Documents/work/tools/offload-guard: Operation not permitted';
const VOLUME_EPERM = 'Exit code 1\nls: /Volumes/Backup/notes: Operation not permitted';

describe('isTccDenial', () => {
  it('recognises a hook under the denied folder failing to start (getcwd + EPERM)', () => {
    expect(isTccDenial(HOOK_ERROR, true)).toBe(true);
  });
  it('recognises EPERM on a path under /Users or /Volumes', () => {
    expect(isTccDenial(PY_EPERM, true)).toBe(true);
    expect(isTccDenial(HEAD_EPERM, true)).toBe(true);
    expect(isTccDenial(VOLUME_EPERM, true)).toBe(true);
  });
  it('ignores a successful result that merely quotes the text (a log grep, a transcript read)', () => {
    expect(isTccDenial('18:deck: run.sh: Operation not permitted\n19:deck: relaunch 1/5', false)).toBe(false);
    expect(isTccDenial(HOOK_ERROR, false)).toBe(false);
  });
  it('ignores other denials and other EPERMs', () => {
    expect(isTccDenial('Permission for this action was denied by the Claude Code auto mode classifier. Reason: Blocked by classifier.', true)).toBe(false);
    expect(isTccDenial('Exit code 1\nbash: kill: (123) - Operation not permitted', true)).toBe(false);
    expect(isTccDenial('Exit code 1\nchown: /etc/hosts: Operation not permitted', true)).toBe(false);
    expect(isTccDenial('', true)).toBe(false);
  });
  it('tells the user what to allow', () => {
    expect(TCC_DENIAL_NOTICE).toContain('Operation not permitted');
    expect(TCC_DENIAL_NOTICE).toContain('전체 디스크 접근');
  });
});

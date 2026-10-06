import { describe, expect, it } from 'vitest';
import { hasInjected, parseUserText } from './injected';

const TASK = `<task-notification>
<task-id>abc730bf4872fa123</task-id>
<tool-use-id>toolu_01TESTtestTESTtestTEST0001</tool-use-id>
<output-file>/private/tmp/claude-501/x/tasks/abc730bf4872fa123.output</output-file>
<status>completed</status>
<summary>Agent "docs review" finished</summary>
<note>A task-notification fires each time this agent stops.</note>
<result>I couldn't do any of the research.

- **WebSearch:** refused</result>
</task-notification>`;

describe('parseUserText', () => {
  it('leaves ordinary text untouched (fast path)', () => {
    expect(hasInjected('hello <b>world</b>')).toBe(false);
    expect(parseUserText('hello <b>world</b>')).toEqual({ text: 'hello <b>world</b>', notices: [] });
  });

  it('turns a task-notification-only turn into one task notice and no text', () => {
    const r = parseUserText(TASK);
    expect(r.text).toBe('');
    expect(r.notices).toHaveLength(1);
    const n = r.notices[0]!;
    expect(n.kind).toBe('task');
    expect(n.status).toBe('completed');
    expect(n.label).toBe('백그라운드 작업 완료');
    expect(n.summary).toBe('Agent "docs review" finished');
    expect(n.body).toContain("I couldn't do any of the research.");
    expect(n.body).toContain('**WebSearch:** refused');
    expect(n.raw).toBe(TASK);
  });

  it('labels failed / killed / unknown task statuses', () => {
    const mk = (s: string) => parseUserText(`<task-notification><status>${s}</status><summary>x</summary></task-notification>`).notices[0]!.label;
    expect(mk('failed')).toBe('백그라운드 작업 실패');
    expect(mk('killed')).toBe('백그라운드 작업 중단됨');
    expect(mk('weird')).toBe('백그라운드 작업 알림');
  });

  it('handles several notifications in one turn, in order', () => {
    const two = TASK + '\n' + TASK.replace('completed', 'failed').replace('docs', 'api');
    const r = parseUserText(two);
    expect(r.notices.map((n) => n.status)).toEqual(['completed', 'failed']);
    expect(r.notices[1]!.summary).toContain('api');
    expect(r.text).toBe('');
  });

  it('strips system-reminder blocks but keeps what the user typed', () => {
    const r = parseUserText('표 좀 정리해줘\n<system-reminder>\nWhenever you read a file…\n</system-reminder>\n');
    expect(r.text).toBe('표 좀 정리해줘');
    expect(r.notices).toEqual([]);
  });

  it('keeps user text next to a notification', () => {
    const r = parseUserText(`${TASK}\n\n결과 요약해줘`);
    expect(r.text).toBe('결과 요약해줘');
    expect(r.notices).toHaveLength(1);
  });

  it('folds slash-command echo tags into one command notice and drops the caveat', () => {
    const r = parseUserText('<local-command-caveat>Caveat: ignore</local-command-caveat><command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>opus</command-args>');
    expect(r.text).toBe('');
    expect(r.notices).toHaveLength(1);
    expect(r.notices[0]).toMatchObject({ kind: 'command', label: '명령 실행', summary: '/model opus' });
  });

  it('turns command stdout into an output notice; empty stdout is dropped', () => {
    const r = parseUserText('<local-command-stdout>Set model to opus</local-command-stdout>');
    expect(r.notices[0]).toMatchObject({ kind: 'output', label: '명령 출력', summary: 'Set model to opus', body: 'Set model to opus' });
    expect(parseUserText('<local-command-stdout></local-command-stdout>')).toEqual({ text: '', notices: [] });
  });

  it('shortens a long summary to one line', () => {
    const long = 'x'.repeat(300);
    const n = parseUserText(`<task-notification><status>completed</status><summary>${long}\nmore</summary></task-notification>`).notices[0]!;
    expect(n.summary.length).toBeLessThanOrEqual(140);
    expect(n.summary.endsWith('…')).toBe(true);
    expect(n.summary).not.toContain('\n');
  });

  it('leaves an unclosed tag as plain text rather than eating the message', () => {
    const r = parseUserText('<system-reminder> oops, no close');
    expect(r.text).toBe('<system-reminder> oops, no close');
  });
});

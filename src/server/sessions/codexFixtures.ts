import fs from 'node:fs/promises';
import path from 'node:path';

/** Test fixtures: Codex rollout files in a temp `sessions` root (tests only). */
export const DESKTOP_ID = '01a0f2d3-0000-7c92-aeea-00000000000a';
export const CLI_ID = '01a0f2d3-0000-7c92-aeea-00000000000b';
export const SUB_ID = '01a0f2d3-0000-7c92-aeea-00000000000c';
export const GONE_ID = '01a0f2d3-0000-7c92-aeea-00000000000d';

export const meta = (id: string, cwd: string, extra: Record<string, unknown> = {}) => ({ timestamp: '2026-10-01T01:00:00.000Z', type: 'session_meta', payload: { id, cwd, originator: 'codex_work_desktop', source: 'vscode', thread_source: 'user', base_instructions: { text: 'x'.repeat(5000) }, ...extra } });
export const user = (...texts: string[]) => ({ type: 'response_item', payload: { type: 'message', role: 'user', content: texts.map((text) => ({ type: 'input_text', text })) } });
export const assistant = (text: string) => ({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } });
export const jsonl = (lines: unknown[]) => lines.map((l) => JSON.stringify(l)).join('\n') + '\n';

/** Shapes observed 2026-10-02 in Codex Desktop (0.153) and `codex exec` rollouts (texts shortened). */
export async function writeFixtures(root: string, work: string): Promise<{ desktop: string; cli: string }> {
  const dir = path.join(root, '2026', '10', '01');
  await fs.mkdir(dir, { recursive: true });
  const desktop = path.join(dir, `rollout-2026-10-01T10-00-00-${DESKTOP_ID}.jsonl`);
  await fs.writeFile(desktop, jsonl([
    meta(DESKTOP_ID, work),
    { type: 'event_msg', payload: { type: 'task_started' } },
    { type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '<app-context>…' }] } },
    user('<recommended_plugins>…</recommended_plugins>'),
    user('# AGENTS.md instructions\n…', '<environment_context>…</environment_context>'),
    user('\n# Files mentioned by the user:\n\n## a.png: /tmp/a.png\n\n## My request for Codex:\n  스크린샷의 버그 고쳐줘\n둘째 줄'),
    assistant('먼저 살펴볼게요.'),
    { type: 'response_item', payload: { type: 'custom_tool_call', status: 'completed', call_id: 'c1', name: 'apply_patch', input: '*** Begin Patch' } },
    { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c1', output: 'Success' } },
    assistant('고쳤습니다.'),
  ]));
  const cli = path.join(dir, `rollout-2026-10-01T11-00-00-${CLI_ID}.jsonl`);
  await fs.writeFile(cli, jsonl([meta(CLI_ID, work, { originator: 'codex_cli_rs', source: 'cli' }), user('<environment_context>…'), user('List the files'), assistant('a.txt')]));
  await fs.writeFile(path.join(dir, `rollout-2026-10-01T12-00-00-${SUB_ID}.jsonl`), jsonl([meta(SUB_ID, work, { source: { subagent: { thread_spawn: { parent_thread_id: DESKTOP_ID } } }, thread_source: 'subagent' }), user('do part 1')]));
  await fs.writeFile(path.join(dir, `rollout-2026-10-01T13-00-00-${GONE_ID}.jsonl`), jsonl([meta(GONE_ID, path.join(work, 'deleted-temp-dir')), user('hi')]));
  await fs.writeFile(path.join(dir, 'rollout-junk.jsonl'), 'not json\n');
  await fs.writeFile(path.join(dir, 'notes.txt'), 'ignored');
  return { desktop, cli };
}

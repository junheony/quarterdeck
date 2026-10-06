// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PermissionCard } from './PermissionCard';
import { ToolCalls } from './ToolCallView';

afterEach(cleanup);

const call = (toolUseId: string, name: string, input: unknown, result: string | null = 'ok') => ({ toolUseId, name, input, result, isError: false });

describe('diff cards', () => {
  it('Edit renders a card with a cwd-relative path, +N −M and red/green lines', () => {
    render(<ToolCalls cwd="/w/p" calls={[call('t1', 'Edit', { file_path: '/w/p/src/a.ts', old_string: 'one\ntwo', new_string: 'one\nTWO\nthree' })]} />);
    const card = screen.getByTestId('diff-card');
    expect(card.querySelector('.diff-path')!.textContent).toBe('src/a.ts');
    expect(card.querySelector('.diff-count.add')!.textContent).toBe('+2');
    expect(card.querySelector('.diff-count.del')!.textContent).toBe('−1');
    expect(card.querySelectorAll('.diff-line.add').length).toBe(2);
    expect(card.querySelectorAll('.diff-line.del').length).toBe(1);
    expect(card.querySelectorAll('.diff-line.ctx').length).toBe(1);
  });

  it('Write of a new file is all green with line numbers, folded past 30 lines with 더 보기', () => {
    const content = Array.from({ length: 45 }, (_, i) => `line ${i + 1}`).join('\n');
    render(<ToolCalls calls={[call('t1', 'Write', { file_path: '/w/new.md', content }, 'File created successfully at: /w/new.md')]} />);
    const card = screen.getByTestId('diff-card');
    expect(card.textContent).toContain('새 파일');
    expect(card.querySelectorAll('.diff-line.del').length).toBe(0);
    expect(card.querySelectorAll('.diff-line.add').length).toBe(30);
    expect(card.querySelector('.diff-no:nth-child(2)')!.textContent).toBe('1');
    fireEvent.click(screen.getByText('더 보기 (15줄)'));
    expect(card.querySelectorAll('.diff-line.add').length).toBe(45);
    fireEvent.click(screen.getByText('접기'));
    expect(card.querySelectorAll('.diff-line.add').length).toBe(30);
  });

  it('edits stand apart from grouped non-edit calls, in order', () => {
    const { container } = render(<ToolCalls calls={[
      call('b1', 'Bash', { command: 'ls' }), call('b2', 'Bash', { command: 'pwd' }),
      call('e1', 'Edit', { file_path: '/w/x', old_string: 'a', new_string: 'b' }),
      call('r1', 'Read', { file_path: '/w/x' }),
    ]} />);
    const kids = [...container.children].map((e) => e.getAttribute('data-testid'));
    expect(kids).toEqual(['tool-group', 'tool-call', 'tool-call']);
    expect(container.children[1]!.classList.contains('diff-call')).toBe(true);
  });

  it('Codex file changes without content list the files with a note', () => {
    render(<ToolCalls cwd="/w" calls={[call('c1', 'Edit', { changes: [{ path: '/w/a.ts', kind: 'update' }, { path: '/w/b.ts', kind: 'add' }] }, 'completed')]} />);
    const cards = screen.getAllByTestId('diff-card');
    expect(cards.map((c) => c.querySelector('.diff-path')!.textContent)).toEqual(['a.ts', 'b.ts']);
  });

  it('a permission card for Edit shows the diff instead of raw JSON', () => {
    render(<PermissionCard onDecide={() => {}} req={{ requestId: 'r', toolName: 'Edit', input: { file_path: '/w/p/a.ts', old_string: 'x', new_string: 'y' }, title: null, decisionReason: null, blockedPath: null, defaultToNo: false, allowSession: false, sessionLabel: null, turnId: 't', sessionId: 's', cwd: '/w/p' }} />);
    expect(screen.getByTestId('diff-card').querySelector('.diff-path')!.textContent).toBe('a.ts');
    expect(screen.getByText('원본 입력 보기')).toBeTruthy();
  });
});

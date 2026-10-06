// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QuestionCard } from './QuestionCard';
import type { PendingQuestion } from '../state';

const req: PendingQuestion = {
  turnId: 't', sessionId: 's1', cwd: '/w/proj', requestId: 'q1',
  questions: [
    { question: 'Which color?', header: 'Color', options: [{ label: 'red', description: 'warm' }, { label: 'blue', description: 'cool' }], multiSelect: false },
    { question: 'Which features?', header: 'Features', options: [{ label: 'a', description: '' }, { label: 'b', description: '' }, { label: 'c', description: '' }], multiSelect: true },
  ],
};

describe('QuestionCard (D8)', () => {
  afterEach(cleanup);

  it('shows headers, questions, options with descriptions and the session scope; submit is disabled until every question is answered', () => {
    const onAnswer = vi.fn();
    render(<QuestionCard req={req} onAnswer={onAnswer} />);
    expect(screen.getByText('Color')).toBeTruthy();
    expect(screen.getByText('Which color?')).toBeTruthy();
    expect(screen.getByText('cool')).toBeTruthy();
    expect(screen.getByTestId('question-scope').textContent).toContain('/w/proj');
    const submit = screen.getByText('답변 보내기') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.click(screen.getByText('blue'));
    expect(submit.disabled).toBe(true);
    fireEvent.click(screen.getByText('a'));
    fireEvent.click(screen.getByText('c'));
    fireEvent.click(screen.getByText('a')); // toggles off
    fireEvent.click(screen.getByText('b'));
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    expect(onAnswer).toHaveBeenCalledWith('q1', { 'Which color?': 'blue', 'Which features?': 'c, b' });
  });

  it('single-select replaces the pick; free text overrides the options', () => {
    const onAnswer = vi.fn();
    render(<QuestionCard req={{ ...req, questions: [req.questions[0]!] }} onAnswer={onAnswer} />);
    fireEvent.click(screen.getByText('red'));
    fireEvent.click(screen.getByText('blue'));
    fireEvent.change(screen.getByPlaceholderText('기타 (직접 입력)'), { target: { value: 'green' } });
    fireEvent.click(screen.getByText('답변 보내기'));
    expect(onAnswer).toHaveBeenCalledWith('q1', { 'Which color?': 'green' });
  });

  it('keys the submitted answers by the exact question text via answersFor, verbatim including trailing whitespace', () => {
    const onAnswer = vi.fn();
    const trailing: PendingQuestion = {
      turnId: 't', sessionId: null, cwd: '/w', requestId: 'q2',
      questions: [{ question: 'Which DB?  ', header: '', options: [{ label: 'pg', description: '' }], multiSelect: false }],
    };
    render(<QuestionCard req={trailing} onAnswer={onAnswer} />);
    fireEvent.click(screen.getByText('pg'));
    fireEvent.click(screen.getByText('답변 보내기'));
    expect(onAnswer).toHaveBeenCalledWith('q2', { 'Which DB?  ': 'pg' });
    expect(Object.keys(onAnswer.mock.calls[0]![1] as object)).toEqual(['Which DB?  ']);
  });

  it('typing free text then clicking an option submits the option, and unpicks the free text visually', () => {
    const onAnswer = vi.fn();
    render(<QuestionCard req={{ ...req, questions: [req.questions[0]!] }} onAnswer={onAnswer} />);
    const free = screen.getByPlaceholderText('기타 (직접 입력)') as HTMLInputElement;
    fireEvent.change(free, { target: { value: 'green' } });
    fireEvent.click(screen.getByText('blue'));
    expect(free.value).toBe('');
    expect((screen.getByText('blue').closest('button') as HTMLButtonElement).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByText('답변 보내기'));
    expect(onAnswer).toHaveBeenCalledWith('q1', { 'Which color?': 'blue' });
  });

  it('clicking an option then typing free text submits the text, and unpicks the option visually', () => {
    const onAnswer = vi.fn();
    render(<QuestionCard req={{ ...req, questions: [req.questions[0]!] }} onAnswer={onAnswer} />);
    const blueBtn = screen.getByText('blue').closest('button') as HTMLButtonElement;
    fireEvent.click(blueBtn);
    expect(blueBtn.getAttribute('aria-pressed')).toBe('true');
    fireEvent.change(screen.getByPlaceholderText('기타 (직접 입력)'), { target: { value: 'green' } });
    expect(blueBtn.className).not.toContain('picked');
    expect(blueBtn.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(screen.getByText('답변 보내기'));
    expect(onAnswer).toHaveBeenCalledWith('q1', { 'Which color?': 'green' });
  });

  it('sets aria-pressed on option buttons and an aria-label on the free-text input', () => {
    render(<QuestionCard req={{ ...req, questions: [req.questions[0]!] }} onAnswer={vi.fn()} />);
    expect((screen.getByText('red').closest('button') as HTMLButtonElement).getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByLabelText('Color 직접 입력')).toBeTruthy();
  });
});

/**
 * "새 세션으로 이어가기": one turn in the current session (warm cache) writes a handoff note, then a new session
 * in the same folder opens with the note prefilled in the composer. The server runs that turn with every tool call
 * denied (the tool list itself is left unchanged so the prompt cache still hits).
 */
export const HANDOFF_PROMPT = [
  '이 대화를 새 세션으로 넘기려고 합니다. 새 세션의 Claude 가 이 대화를 전혀 보지 못한 채 바로 이어서 작업할 수 있도록 간결한 인계 메모를 한국어 마크다운으로 써 주세요.',
  '',
  '다음 항목을 이 순서로, 제목(##)과 짧은 목록으로:',
  '1. 목표 — 이 작업이 이루려는 것',
  '2. 내린 결정 — 무엇을 왜 그렇게 정했는지',
  '3. 현재 상태 — 건드린 파일·브랜치·커밋, 실행 중이거나 남아 있는 것',
  '4. 남은 문제 — 아직 풀리지 않은 것, 알려진 위험',
  '5. 다음 단계 — 바로 실행할 수 있게 구체적으로',
  '6. 지켜야 할 제약·사용자 선호',
  '',
  '도구는 쓰지 말고(파일을 읽거나 명령을 실행하지 말고) 지금까지의 대화만으로 쓰세요. 메모 본문만 답하고 앞뒤 인사말은 빼 주세요.',
].join('\n');

export const HANDOFF_COMMAND = 'handoff';

/** The new session's title: "<old title> (이어서)". */
export function handoffTitle(oldTitle: string): string {
  return `${oldTitle.trim() || '세션'} (이어서)`;
}

/** The new session's first user message (prefilled, never sent without the user pressing Enter). */
export function handoffFirstMessage(oldTitle: string, oldSessionId: string, note: string): string {
  return `이전 세션(${oldTitle}, ${oldSessionId})에서 이어서 작업합니다. 인계 메모:\n\n${note.trim()}\n\n이어서 진행할 준비가 되면 짧게 확인만 해 주세요.`;
}

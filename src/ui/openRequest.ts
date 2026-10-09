/**
 * How long a notification's session may be missing from the index before the tap is given up. A notification can come
 * for a session the server has not indexed yet (a new session's first turn); the next `index` usually lists it.
 */
export const OPEN_REQUEST_WAIT_MS = 10_000;

export const OPEN_REQUEST_MISSING = '알림의 세션을 찾을 수 없습니다';

/**
 * What a pending open request (App: openReq) does with the index as it is now: 'done' = opened; 'wait' = no index yet,
 * or still the index it was missing from; 'miss' = missing from this index — wait for the next (at most
 * OPEN_REQUEST_WAIT_MS); 'fail' = missing from the next index too — say so.
 */
export function openRequestStep({ found, projects, missedIn }: { found: boolean; projects: readonly unknown[]; missedIn: readonly unknown[] | null }): 'done' | 'wait' | 'miss' | 'fail' {
  if (found) return 'done';
  if (!projects.length) return 'wait';
  if (missedIn === null) return 'miss';
  return projects === missedIn ? 'wait' : 'fail';
}

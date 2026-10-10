/**
 * macOS now and then revokes a process tree's access to the user's Documents (also Desktop, Downloads, external
 * volumes) — TCC, 시스템 설정 › 개인정보 보호 및 보안. Every open/readdir under the folder then fails with EPERM, hooks
 * living there cannot start, `getcwd` fails. The CLI reports nothing but the failed tool calls, so a device sees a turn
 * that reads nothing and no reason. This tells such a failed tool result apart from other errors, so the turn can say why.
 */
const EPERM = 'Operation not permitted';
/** A line saying EPERM about a path under a TCC-protected root, or the shell failing to even find its cwd. */
const SIGNS: RegExp[] = [
  /getcwd: cannot access parent directories: Operation not permitted/,
  /\/(?:Users|Volumes)\/[^\n]*Operation not permitted/,
  /Operation not permitted[^\n]*\/(?:Users|Volumes)\//,
];

/** True for a failed tool result whose text shows the denial (a successful result quoting the words is not one). */
export const isTccDenial = (content: string, isError: boolean): boolean =>
  isError && content.includes(EPERM) && SIGNS.some((re) => re.test(content));

export const TCC_DENIAL_NOTICE =
  '맥이 이 세션 프로세스의 문서 폴더 접근을 막았습니다(Operation not permitted) — 파일 읽기와 훅이 실패합니다. ' +
  '시스템 설정 › 개인정보 보호 및 보안 › 전체 디스크 접근에서 deck 의 claude 와 node 를 허용하세요.';

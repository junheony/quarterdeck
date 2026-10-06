import { MODEL_LABEL } from '../../shared/models';
import type { TurnBadge as Badge } from '../../shared/protocol';
import { useAccounts } from '../accounts';
import { has } from '../features';
import { PinIcon } from './AccountPicker';

function k(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** The server's text for an interrupted turn (TurnRunner ABORTED). */
const ABORTED = '중단됨';
/** An older server (no 'abortLabel') passed the SDK's own text through for a user interrupt. */
const OLD_SERVER_ABORT = /aborted by user/i;

/**
 * The turn was stopped by the user, not failed: the server says exactly '중단됨', this client sent an interrupt for it
 * (중단, 지금 전송), or an older server's raw SDK "aborted by user". Other abort/cancel texts (timeouts, API or MCP
 * cancellations) are real failures and keep their "오류:" line.
 */
export function isAbortError(error: string | null | undefined, interrupted = false): boolean {
  return !!error && (interrupted || error.trim() === ABORTED || (!has('abortLabel') && OLD_SERVER_ABORT.test(error)));
}

/**
 * A turn that never really ran: interrupted, or finished with no input and no output tokens, or
 * failed before producing any text. Its footer says "중단됨" instead of a row of zeros.
 */
export function isStoppedTurn(t: { badge: Badge; error?: string | null; text?: string; interrupted?: boolean }): boolean {
  const u = t.badge.usage;
  if (isAbortError(t.error, t.interrupted)) return true;
  if (u.inputTokens === 0 && u.outputTokens === 0) return true;
  return !!t.error && !(t.text ?? '').trim() && u.outputTokens === 0;
}

/** A stopped turn that ended on a real error (not an interrupt): its footer says "실패" rather than "중단됨". */
export function isFailedTurn(t: { error?: string | null; interrupted?: boolean }): boolean {
  return !!t.error && !isAbortError(t.error, t.interrupted);
}

/** Turn footer: account tile, model pill, token counts (or "중단됨" / "실패"), then the routing reason — one muted line. */
export function TurnBadge({ badge, stopped = false, failed = false, cacheNote = null }: { badge: Badge; stopped?: boolean; /** stopped by an error, not an interrupt */ failed?: boolean; /** "캐시 새로 씀 · <reason>" when the turn rewrote the prompt cache. */ cacheNote?: string | null }) {
  const u = badge.usage;
  const names = useAccounts();
  const label = names.label(badge.account);
  const look = names.look(badge.account);
  const tokens = `입력 ${k(u.inputTokens)} · 출력 ${k(u.outputTokens)} · 캐시 읽기 ${k(u.cacheReadTokens)} · 캐시 쓰기 ${k(u.cacheCreationTokens)}`;
  return (
    <div className={`turn-badge${stopped ? ' stopped' : ''}`}>
      <span className={`acct ${look.kind === 'other' ? `acct-${badge.account}` : `acct-${look.kind}`}`} {...(look.slot !== null ? { 'data-acct-idx': look.slot } : {})} title={`계정 ${label}${look.kind === 'unknown' ? ' · 설정에 없는 계정' : look.kind === 'retired' ? ' · 뺀 계정' : ''}${badge.pinned ? ' · 고정' : ''}`}><span className="acct-name">{label}</span></span>
      {badge.pinned && <span className="tb-pin" data-testid="badge-pin"><PinIcon title="고정 계정" /></span>}
      <span className="tb-model">{MODEL_LABEL[badge.model]}</span>
      {stopped ? (
        <span className="tb-stopped" title={tokens}>{failed ? '실패' : '중단됨'}</span>
      ) : (
        <span className="tb-tokens">
          <span>입력 <b>{k(u.inputTokens)}</b></span>
          <span>출력 <b>{k(u.outputTokens)}</b></span>
          <span>캐시 읽기 <b>{k(u.cacheReadTokens)}</b></span>
          {cacheNote
            ? <span className="tb-cold" title={cacheNote}>캐시 쓰기 <b>{k(u.cacheCreationTokens)}</b></span>
            : <span>캐시 쓰기 <b>{k(u.cacheCreationTokens)}</b></span>}
        </span>
      )}
      <span className="reason" title={badge.reason}>{badge.reason}</span>
      {badge.modelNote && <span className="note">{badge.modelNote}</span>}
    </div>
  );
}

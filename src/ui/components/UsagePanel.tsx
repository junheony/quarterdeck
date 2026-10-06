import { useEffect, useState, type CSSProperties } from 'react';
import type { Seat } from '../../shared/accounts';
import { useAccounts } from '../accounts';
import { ClaudeMark, OpenAIMark } from './EngineMark';
import { emptyAccountUsage, parseIsoUtc, remainingPct, usageOf, type AccountUsage, type GptCredits, type UsageSnapshot, type UsageWindow } from '../../shared/usage-types';

type WindowKey = 'fiveHour' | 'weekly' | 'fable';
const WINDOWS: { key: WindowKey; name: string }[] = [
  { key: 'fiveHour', name: '5h' },
  { key: 'weekly', name: '주간' },
  { key: 'fable', name: 'Fable' },
];
const GPT_WINDOWS: { key: WindowKey; name: string }[] = [
  { key: 'weekly', name: '주간' },
  { key: 'fiveHour', name: '5h' },
];

export function countdown(resetsAt: string | null, now: number): string {
  if (!resetsAt) return '';
  const ms = parseIsoUtc(resetsAt) - now; // zone-less stamps are UTC (review M9)
  if (Number.isNaN(ms) || ms <= 0) return '리셋됨';
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h >= 24 ? `${Math.floor(h / 24)}일 ${h % 24}시간 후 리셋` : `${h}시간 ${m}분 후 리셋`;
}

/** Absolute local reset time, e.g. "10/3 09:00" (an exhausted window needs a when, not a countdown). */
export function resetStamp(resetsAt: string | null): string {
  if (!resetsAt) return '';
  const t = parseIsoUtc(resetsAt);
  if (Number.isNaN(t)) return '';
  const d = new Date(t);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Whole credits with thousands separators ("49,563"); null when there is nothing to spend. */
export function creditsText(c: GptCredits | null | undefined): string | null {
  if (!c || !c.hasCredits) return null;
  if (c.unlimited) return '무제한';
  if (c.balance === null || !Number.isFinite(c.balance)) return null;
  return Math.floor(c.balance).toLocaleString('en-US');
}

/** Colour by what is left: green, amber at ≤20%, red at ≤5%. */
function levelClass(w: UsageWindow | null): string {
  if (!w) return 'none';
  if (w.usedPct >= 95) return 'danger';
  if (w.usedPct >= 80) return 'warn';
  return 'ok';
}

/** Review M9: the countdowns re-render every 30 s instead of freezing at the last snapshot. */
function useClock(fixed: number | undefined, periodMs = 30_000): number {
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    if (fixed !== undefined) return;
    const id = setInterval(() => setTick(Date.now()), periodMs);
    return () => clearInterval(id);
  }, [fixed, periodMs]);
  return fixed ?? tick;
}

type Pop = { seat: Seat; x: number; y: number; pinned: boolean };

/** One window row: label · rounded bar · remaining %; a spent window collapses into a muted "소진 · reset" pill. */
function WindowRow({ seat, name, k, w, now }: { seat: Seat; name: string; k: WindowKey; w: UsageWindow | null; now: number }) {
  const rem = remainingPct(w);
  const reset = w ? countdown(w.resetsAt, now) : '';
  const title = rem === null ? `${name} · 알 수 없음` : rem === 0 ? `${name} · 소진${w?.resetsAt ? ` · ${resetStamp(w.resetsAt)} 리셋` : ''}` : `${name} · ${rem}% 남음${reset ? ` · ${reset}` : ''}`;
  if (rem === 0) {
    const at = resetStamp(w?.resetsAt ?? null);
    return (
      <div data-testid={`${seat}-${k}`} className="usage-row spent danger" title={title}>
        <span className="usage-label">{name}</span>
        <span className="usage-pill">소진{at && <span className="usage-pill-at">{` · ${at}`}</span>}</span>
      </div>
    );
  }
  return (
    <div data-testid={`${seat}-${k}`} className={`usage-row ${levelClass(w)}`} title={title}>
      <span className="usage-label">{name}</span>
      <span className="usage-bar" aria-hidden="true"><i style={{ width: `${rem ?? 0}%` }} /></span>
      <span className="usage-value">{rem === null ? '—' : <>{rem}<small>%</small></>}</span>
      {reset && <span className="usage-reset">{reset}</span>}
    </div>
  );
}

/** One seat as a small card: mark + letter, then aligned rows; reset times on hover (title) and in a tap popover. */
function SeatCard({ seat, u, windows, current, now, pop, onPop, hint, onOpenHistory }: {
  seat: Seat; u: AccountUsage; windows: { key: WindowKey; name: string }[]; current: boolean; now: number;
  pop: Pop | null; onPop: (p: Pop | null) => void; hint?: string; onOpenHistory?: () => void;
}) {
  const label = useAccounts().label(seat);
  const at = (el: HTMLElement, pinned: boolean): Pop => {
    const r = el.getBoundingClientRect();
    return { seat, x: Math.max(8, Math.min(r.left, window.innerWidth - 236)), y: r.bottom + 6, pinned };
  };
  const open = pop?.seat === seat;
  const credits = seat === 'gpt' ? creditsText(u.credits) : null;
  // Compact layouts (phone, tablet) show one number per seat: the least left of 5h / 주간, the windows that gate every model.
  // Fable only gates Fable (a spent Fable must not read "소진" for the whole seat); its bar still shows.
  let worst: { name: string; w: UsageWindow; rem: number } | null = null;
  for (const { key, name } of windows) {
    if (key === 'fable') continue;
    const w = u[key];
    const rem = remainingPct(w);
    if (w && rem !== null && (!worst || rem < worst.rem)) worst = { name, w, rem };
  }
  return (
    <div
      data-testid={`account-${seat}`}
      className={`usage-card ${seat === 'gpt' ? 'gpt' : 'claude'} ${current ? 'current' : ''} ${u.status} ${open ? 'open' : ''}`}
      title={hint ?? ''}
      role="button"
      tabIndex={0}
      aria-expanded={open}
      aria-label={`${label} 잔여량${current ? ' (현재)' : ''}`}
      onMouseEnter={(e) => { if (!pop?.pinned) onPop(at(e.currentTarget, false)); }}
      onMouseLeave={() => { if (!pop?.pinned) onPop(null); }}
      onClick={(e) => { e.stopPropagation(); onPop(open && pop?.pinned ? null : at(e.currentTarget, true)); }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onPop(null);
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPop(open ? null : at(e.currentTarget, true)); }
      }}
    >
      {current && <span className="usage-dot" aria-hidden="true" />}
      <div className="usage-id">
        {seat === 'gpt' ? <OpenAIMark className="usage-mark gpt" /> : <ClaudeMark className="usage-mark claude" />}
        <span className="usage-letter" title={label}>{label}</span>
      </div>
      <span className={`usage-sum ${worst ? levelClass(worst.w) : 'none'}`} aria-hidden="true" title={worst ? `가장 적게 남은 한도 · ${worst.name} ${worst.rem}%` : '잔여량 알 수 없음'}>
        {!worst ? '—' : worst.rem === 0 ? '소진' : <>{worst.rem}<small>%</small></>}
      </span>
      <div className="usage-rows">
        {windows.map(({ key, name }) => <WindowRow key={key} seat={seat} name={name} k={key} w={u[key]} now={now} />)}
        {credits && (
          <div data-testid="gpt-credits" className="usage-row credits" title="ChatGPT 크레딧 잔액 — 주간 한도가 끝난 뒤 쓰는 유료 크레딧">
            <span className="usage-label">크레딧</span>
            <span className="usage-credits">{credits}</span>
          </div>
        )}
      </div>
      {open && (
        <div className="usage-pop" role="tooltip" style={{ left: pop.x, top: pop.y }}>
          <div className="usage-pop-title">{label} 계정{current ? ' · 현재' : ''}</div>
          {hint && <div className="usage-pop-row hint">{hint}</div>}
          {windows.map(({ key, name }) => {
            const w = u[key];
            const rem = remainingPct(w);
            return (
              <div key={key} className="usage-pop-row">
                <span>{name} {rem === null ? '—' : rem === 0 ? '한도 소진' : `${rem}% 남음`}</span>
                <b>{w?.resetsAt ? (rem === 0 ? `${resetStamp(w.resetsAt)} 리셋` : countdown(w.resetsAt, now)) : '리셋 시각 없음'}</b>
              </div>
            );
          })}
          {credits && <div className="usage-pop-row"><span>크레딧</span><b>{credits}</b></div>}
          {onOpenHistory && pop.pinned && (
            <div className="usage-pop-row link">
              <button type="button" onClick={(e) => { e.stopPropagation(); onPop(null); onOpenHistory(); }}>토큰 사용량 기록 보기 ›</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function UsagePanel({ usage, current, now: fixedNow, onOpenHistory }: { usage: UsageSnapshot | null; current: Seat | null; now?: number; onOpenHistory?: () => void }) {
  const now = useClock(fixedNow);
  const { active } = useAccounts();
  const [pop, setPop] = useState<Pop | null>(null);
  useEffect(() => {
    if (!pop?.pinned) return;
    const close = () => setPop(null);
    window.addEventListener('click', close);
    window.addEventListener('scroll', close, true);
    return () => { window.removeEventListener('click', close); window.removeEventListener('scroll', close, true); };
  }, [pop?.pinned]);
  if (!usage) return <div className="usage-panel"><span className="usage-loading">잔여량 불러오는 중…</span></div>;
  const gpt = usage.gpt ?? emptyAccountUsage();
  // One card per active account and one for GPT: the grid's column count. Past four cards there is no room for the rows
  // of numbers: the compact card (label over the lowest remaining %) at every width. From seven cards a phone shows two rows.
  const cards = active.length + 1;
  return (
    <div className="usage-panel" {...(cards > 4 ? { 'data-dense': '' } : {})} {...(cards > 6 ? { 'data-wrap': '' } : {})} style={{ '--usage-cards': cards, ...(cards > 6 ? { '--usage-cols-wrap': Math.ceil(cards / 2) } : {}) } as CSSProperties}>
      {active.map(({ id: a }) => (
        <SeatCard key={a} seat={a} u={usageOf(usage, a)} windows={WINDOWS} current={a === current} now={now} pop={pop} onPop={setPop} onOpenHistory={onOpenHistory} />
      ))}
      <SeatCard
        seat="gpt" u={gpt} windows={GPT_WINDOWS} current={current === 'gpt'} now={now} pop={pop} onPop={setPop} onOpenHistory={onOpenHistory}
        {...(gpt.status === 'down' ? { hint: 'GPT 잔여량 불명 — usage-deck 의 codex 카드가 setup_needed 상태입니다' } : {})}
      />
      {!usage.deckReachable && <span className="usage-stale" title="usage-deck 에 닿지 않아 마지막 값을 보여 줍니다">오래된 값</span>}
    </div>
  );
}

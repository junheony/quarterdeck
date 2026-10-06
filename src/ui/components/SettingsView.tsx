import { useEffect } from 'react';
import { usePrefs } from '../usePrefs';
import type { ChatWidth, FontSize, Prefs, SendKey, Theme } from '../prefs';
import { PERM_MODES, PERM_MODE_HINT, PERM_MODE_LABEL, type PermMode } from '../../shared/permission';
import type { RoutingPolicy } from '../../shared/protocol';
import { NotifyMenu } from './NotifyMenu';
import { describeShell } from '../shellFit';

/** Injected by vite.config.ts (package.json version); absent under vitest. */
declare const __DECK_VERSION__: string | undefined;

function Seg<T extends string>({ label, value, options, onPick }: { label: string; value: T; options: [T, string][]; onPick: (v: T) => void }) {
  return (
    <div className="settings-row">
      <span id={`seg-${label}`}>{label}</span>
      <div className="seg" role="group" aria-labelledby={`seg-${label}`}>
        {options.map(([v, text]) => <button type="button" key={v} aria-pressed={value === v} onClick={() => onPick(v)}>{text}</button>)}
      </div>
    </div>
  );
}

export function SettingsView({ build, defaultPermMode = null, onDefaultPermMode, routingPolicy = null, onRoutingPolicy, onOpenUsage, onClose }: {
  build: string | null;
  /** The mode new sessions start in (null = not known yet); per-session modes live in the composer (Shift+Tab). */
  defaultPermMode?: PermMode | null;
  onDefaultPermMode?: (m: PermMode) => void;
  /** How 자동 picks an account (server setting; null = not known yet). */
  routingPolicy?: RoutingPolicy | null;
  onRoutingPolicy?: (p: RoutingPolicy) => void;
  onOpenUsage: () => void;
  onClose: () => void;
}) {
  const [prefs, dispatch] = usePrefs();
  const set = <K extends keyof Prefs>(key: K, value: Prefs[K]) => dispatch({ type: 'set', key, value });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="settings-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="settings" role="dialog" aria-modal="true" aria-label="설정">
        <div className="settings-head">
          <h2>설정</h2>
          <button type="button" className="btn ghost" onClick={onClose}>닫기</button>
        </div>
        <section aria-label="일반">
          <h3>일반</h3>
          <Seg<Theme> label="테마" value={prefs.theme} onPick={(v) => set('theme', v)} options={[['system', '시스템'], ['light', '라이트'], ['dark', '다크']]} />
          <Seg<FontSize> label="글자 크기" value={prefs.fontSize} onPick={(v) => set('fontSize', v)} options={[['small', '작게'], ['normal', '보통'], ['large', '크게'], ['xlarge', '아주 크게']]} />
          <Seg<ChatWidth> label="채팅 폭" value={prefs.chatWidth} onPick={(v) => set('chatWidth', v)} options={[['narrow', '좁게'], ['wide', '넓게']]} />
          <Seg<SendKey> label="Enter 동작" value={prefs.sendKey} onPick={(v) => set('sendKey', v)} options={[['enter', 'Enter 전송'], ['mod-enter', '⌘Enter 전송']]} />
          <p className="muted">이 기기에만 저장됩니다 (폰과 맥이 따로).</p>
        </section>
        <section aria-label="권한">
          <h3>권한</h3>
          {onDefaultPermMode && defaultPermMode !== null ? (
            <label className="settings-row default-perm" title={`새 세션이 시작할 권한 모드 — ${PERM_MODE_HINT[defaultPermMode]}. 모두 자동 승인이면 새 GPT 세션은 작업폴더 쓰기`}>
              <span>새 세션 기본 권한</span>
              <span className={`pick perm perm-${defaultPermMode}`}>
                <select value={defaultPermMode} onChange={(e) => onDefaultPermMode(e.target.value as PermMode)} aria-label="새 세션 기본 권한" data-testid="default-perm-select">
                  {PERM_MODES.map((m) => <option key={m} value={m}>{PERM_MODE_LABEL[m]}</option>)}
                </select>
              </span>
            </label>
          ) : <p className="muted">서버 연결 후 표시됩니다.</p>}
          <p className="muted">세션별 모드는 입력창의 권한 선택(Shift+Tab)으로 바꿉니다.</p>
        </section>
        <section aria-label="알림">
          <h3>알림</h3>
          <div className="settings-row"><span>이 기기 푸시 알림</span><NotifyMenu /></div>
        </section>
        <section aria-label="계정·사용량">
          <h3>계정 · 사용량</h3>
          {onRoutingPolicy && routingPolicy !== null && (
            <>
              <Seg<RoutingPolicy> label="자동 계정 선택" value={routingPolicy} onPick={onRoutingPolicy} options={[['balance', '고르게 분산'], ['drain', '리셋 임박 먼저 소진']]} />
              <p className="muted">고르게 분산: 5시간 사용량이 가장 낮은 계정으로 (비슷하면 주간이 낮은 쪽). 리셋 임박 먼저 소진: 주간 한도가 곧 리셋되는 계정부터. 대화 중인 세션은 캐시 때문에 그대로 두고, 새 세션, 오래 쉰 세션, 한도 문턱(5시간 80% · 주간 85%)을 넘어 옮길 때 적용됩니다.</p>
            </>
          )}
          <div className="settings-row"><span>토큰 사용량 기록 (주별·일별)</span><button type="button" className="btn ghost" onClick={() => { onClose(); onOpenUsage(); }}>사용량 보기</button></div>
          <p className="muted">계정별 5시간·주간 한도는 화면 상단 사용량 표시에서 확인합니다 (읽기 전용).</p>
        </section>
        <section aria-label="정보">
          <h3>정보</h3>
          <dl className="settings-info">
            <dt>빌드</dt><dd>{build ?? '개발 모드'}</dd>
            <dt>화면</dt><dd>{describeShell()}</dd>
            <dt>서버 버전</dt><dd>deck {typeof __DECK_VERSION__ === 'string' ? __DECK_VERSION__ : '—'}</dd>
          </dl>
        </section>
      </div>
    </div>
  );
}

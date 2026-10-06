import { useEffect, useState } from 'react';
import { copyText } from '../clipboard';
import { CheckIcon, CopyIcon } from './icons';

/**
 * Copy button. `icon`: a square icon button (message action row, tool output) that turns into ✓ 복사됨
 * for ~1.5s; otherwise the code-block header's text button.
 */
export function CopyButton({ text, label = '복사', icon = false, className, caption = '복사' }: { text: string | (() => string); label?: string; icon?: boolean; className?: string; /** Text button's resting caption. */ caption?: string }) {
  const [state, setState] = useState<'idle' | 'ok' | 'fail'>('idle');
  useEffect(() => {
    if (state === 'idle') return;
    const id = setTimeout(() => setState('idle'), 1500);
    return () => clearTimeout(id);
  }, [state]);
  const run = () => void copyText(typeof text === 'function' ? text() : text).then((ok) => setState(ok ? 'ok' : 'fail'));
  const said = state === 'ok' ? '복사됨' : state === 'fail' ? '복사 실패' : null;
  if (!icon) {
    return <button type="button" className={className ?? 'code-copy'} onClick={run} aria-label={label}>{said ?? caption}</button>;
  }
  return (
    <button type="button" className={`msg-act${state === 'ok' ? ' ok' : ''}${className ? ` ${className}` : ''}`} onClick={run} aria-label={said ?? label} title={said ?? label}>
      {state === 'ok' ? <CheckIcon /> : <CopyIcon />}
      {said && <span className="msg-act-said">{said}</span>}
    </button>
  );
}

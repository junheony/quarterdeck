import { useId } from 'react';

/**
 * deck's own mark — the app icon's chip (terracotta, cream `>_`) as inline SVG, for the brand in the top bar and on the
 * login. Same 24-unit box as the engine marks, sized by its class / 1em. Sessions keep their engine marks (EngineMark).
 */
export function DeckMark({ className }: { className: string }) {
  const grad = useId();
  return (
    <svg className={`deck-mark ${className}`} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={grad} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#E27A50" />
          <stop offset="1" stopColor="#C85230" />
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="22" height="22" rx="6.3" fill={`url(#${grad})`} />
      <path d="M7 7.9 11.3 12.1 7 16.3M13.8 16.3h3.8" fill="none" stroke="#EDE3D5" strokeWidth="2.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

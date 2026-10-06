/** Small line icons for message actions (Desktop style: 16px, currentColor stroke). */
const svg = { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const;

export const CopyIcon = () => <svg {...svg}><rect x="5.5" y="5.5" width="8" height="8" rx="1.6" /><path d="M10.5 5.5V3.6c0-.6-.5-1.1-1.1-1.1H3.6c-.6 0-1.1.5-1.1 1.1v5.8c0 .6.5 1.1 1.1 1.1h1.9" /></svg>;
export const CheckIcon = () => <svg {...svg}><path d="M3.5 8.5l3 3 6-7" /></svg>;
export const RetryIcon = () => <svg {...svg}><path d="M13 8a5 5 0 1 1-1.5-3.6" /><path d="M13 2.8v2.6h-2.6" /></svg>;
export const EditIcon = () => <svg {...svg}><path d="M10.6 2.9l2.5 2.5L6 12.5l-3 .5.5-3z" /></svg>;
export const ShareIcon = () => <svg {...svg}><path d="M8 10V2.5" /><path d="M5.2 5.2L8 2.4l2.8 2.8" /><path d="M5 7.5H4c-.6 0-1 .4-1 1v4c0 .6.4 1 1 1h8c.6 0 1-.4 1-1v-4c0-.6-.4-1-1-1h-1" /></svg>;

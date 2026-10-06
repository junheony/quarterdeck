import { useEffect, useState } from 'react';

/** D10: below this width the sidebar is a drawer and one pane is shown. */
export const PHONE_QUERY = '(max-width: 720px)';

export function useIsPhone(): boolean {
  const read = () => (typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(PHONE_QUERY).matches : false);
  const [phone, setPhone] = useState(read);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(PHONE_QUERY);
    const on = () => setPhone(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return phone;
}

import { useState, type FormEvent } from 'react';
import { DeckMark } from './DeckMark';

export function Login({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [token, setToken] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const res = await fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
    if (res.ok) onLoggedIn();
    else setErr('토큰이 올바르지 않습니다');
  };
  return (
    <form className="login" onSubmit={submit}>
      <h1><DeckMark className="spark" />deck</h1>
      <p>~/.config/deck/token 의 내용을 입력하세요.</p>
      <input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="로그인 토큰" autoFocus />
      <button type="submit" className="btn primary">로그인</button>
      {err && <div className="error">{err}</div>}
    </form>
  );
}

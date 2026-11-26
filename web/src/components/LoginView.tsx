import { useState, type FormEvent } from 'react';
import { ApiError, post } from '../api';

export function LoginView({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await post('/api/login', { password });
      onLoggedIn();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '로그인하지 못했어요');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login fade-in">
      <img className="logo" src="/icons/icon-192.png" alt="" />
      <h1>투자 비서</h1>
      <p className="muted" style={{ margin: 0 }}>혼자 쓰는 앱이에요. 서버에 설정한 비밀번호로 들어가세요.</p>
      <form onSubmit={submit}>
        <label htmlFor="pw" className="field" style={{ margin: 0 }}>비밀번호</label>
        <input id="pw" className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        {error && <p className="error" role="alert">{error}</p>}
        <button className="btn btn-primary btn-block" type="submit" disabled={busy || !password}>로그인</button>
      </form>
    </main>
  );
}

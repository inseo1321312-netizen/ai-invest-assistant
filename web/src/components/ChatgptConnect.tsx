import { useState, type FormEvent } from 'react';
import { ApiError, post } from '../api';

/**
 * 아이폰에서 ChatGPT 연결:
 * 1) 연결 → OpenAI 로그인 주소를 받아 링크로 보여준다(누르면 사파리가 연다)
 * 2) 로그인·허용 뒤 "페이지를 열 수 없음"의 주소를 복사
 * 3) 붙여넣기 → 서버가 토큰으로 바꿔 저장
 */
export function ChatgptConnect({ onConnected }: { onConnected: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [manual, setManual] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function start() {
    setMsg(null);
    setBusy(true);
    try {
      setUrl((await post<{ url: string }>('/api/admin/siwc-login/start', {})).url);
    } catch (e) {
      setMsg({ ok: false, text: e instanceof ApiError ? e.message : '로그인 주소를 받지 못했어요' });
    } finally {
      setBusy(false);
    }
  }

  async function finish(address: string) {
    setBusy(true);
    setMsg(null);
    try {
      await post('/api/admin/siwc-login/finish', { url: address });
      setMsg({ ok: true, text: 'ChatGPT와 연결됐어요' });
      setUrl(null);
      setManual(false);
      onConnected();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof ApiError ? e.message : '연결하지 못했어요' });
    } finally {
      setBusy(false);
    }
  }

  async function paste() {
    try {
      const text = await navigator.clipboard.readText();
      if (!text.trim()) throw new Error('empty');
      await finish(text.trim());
    } catch {
      setManual(true);
    }
  }

  function submitTyped(e: FormEvent) {
    e.preventDefault();
    if (typed.trim()) void finish(typed.trim());
  }

  return (
    <div className="connect">
      {!url && <button type="button" className="btn btn-primary btn-block" disabled={busy} onClick={start}>ChatGPT 연결</button>}
      {url && (
        <>
          <ol className="steps">
            <li>아래 버튼을 눌러 OpenAI에 로그인하고 <b>허용</b>을 눌러요.</li>
            <li>"페이지를 열 수 없음"이 나오면 정상이에요. <b>주소창의 주소를 길게 눌러 복사</b>해요.</li>
            <li>이 화면으로 돌아와 <b>붙여넣기</b>를 눌러요.</li>
          </ol>
          <a className="btn btn-block" href={url} target="_blank" rel="noreferrer noopener">OpenAI 로그인 열기</a>
          <button type="button" className="btn btn-ai btn-block" style={{ marginTop: 8 }} disabled={busy} onClick={paste}>붙여넣기</button>
          {manual && (
            <form onSubmit={submitTyped} style={{ marginTop: 8 }}>
              <label className="field">복사한 주소
                <input className="input" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="http://127.0.0.1:1455/auth/callback?..." autoCapitalize="none" autoCorrect="off" spellCheck={false} />
              </label>
              <button type="submit" className="btn btn-primary btn-block" disabled={busy || !typed.trim()}>연결하기</button>
            </form>
          )}
        </>
      )}
      {msg && <p className={msg.ok ? 'ok-text' : 'error'} role={msg.ok ? 'status' : 'alert'}>{msg.text}</p>}
    </div>
  );
}

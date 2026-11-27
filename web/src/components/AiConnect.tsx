import { useState, type FormEvent } from 'react';
import { api, ApiError } from '../api';
import { Segmented } from '../ui';
import { ChatgptConnect } from './ChatgptConnect';

export interface KeyInfo { set: boolean; source: 'app' | 'server' | null; tail: string | null }
export interface AiSettings {
  gptMode: 'siwc' | 'apikey';
  apiKeys?: { claude: KeyInfo; openai: KeyInfo };
}

type Choice = 'claude' | 'siwc' | 'apikey';
const CHOICES: { value: Choice; label: string }[] = [
  { value: 'claude', label: 'Claude API' },
  { value: 'siwc', label: 'ChatGPT 구독' },
  { value: 'apikey', label: 'ChatGPT API' },
];

function Status({ on, text }: { on: boolean; text: string }) {
  return <p className="ai-status"><span className={`status-dot${on ? ' on' : ''}`} />{text}</p>;
}

/** API 키 입력: 비밀번호 칸, 저장하면 비우고 끝 4자리만 보여 준다 */
function KeyForm({ provider, info, onSaved }: { provider: 'claude' | 'openai'; info: KeyInfo | undefined; onSaved: (s: AiSettings) => void }) {
  const name = provider === 'claude' ? 'Claude' : 'ChatGPT';
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!key.trim()) return;
    setBusy(true);
    setError(null);
    try {
      onSaved(await api<AiSettings>('/api/settings/api-key', { method: 'PUT', body: JSON.stringify({ provider, key: key.trim() }) }));
      setKey('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '연결하지 못했어요');
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    try {
      onSaved(await api<AiSettings>(`/api/settings/api-key?provider=${provider}`, { method: 'DELETE' }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '지우지 못했어요');
    }
  }

  return (
    <form onSubmit={submit} className="key-form">
      <Status on={!!info?.set} text={info?.set ? `연결됨 · 키 …${info.tail}${info.source === 'server' ? ' (서버 설정)' : ''}` : '연결 안 됨'} />
      <label className="field">{name} API 키
        <input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={provider === 'claude' ? 'sk-ant-…' : 'sk-…'}
          autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} />
      </label>
      <div className="actions">
        <button type="submit" className="btn btn-primary" disabled={busy || !key.trim()}>{busy ? '확인 중…' : info?.set ? '키 바꾸기' : '연결'}</button>
        {info?.source === 'app' && <button type="button" className="btn" onClick={remove}>키 지우기</button>}
      </div>
      {error && <p className="error" role="alert">{error}</p>}
    </form>
  );
}

/** 설정 → AI 연결: 하나의 선택(Claude API / ChatGPT 구독 / ChatGPT API)에서 고른 것만 보여 준다 */
export function AiConnect({ settings, siwc, onSettings, onSiwcChange }: {
  settings: AiSettings;
  siwc: { connected: boolean } | null;
  onSettings: (s: AiSettings) => void;
  onSiwcChange: () => void;
}) {
  const [choice, setChoice] = useState<Choice>('claude');

  async function useGpt(mode: 'siwc' | 'apikey') {
    try { onSettings(await api<AiSettings>('/api/settings', { method: 'PUT', body: JSON.stringify({ gptMode: mode }) })); } catch { /* 그대로 둔다 */ }
  }

  async function disconnect() {
    await api('/api/admin/siwc-tokens', { method: 'DELETE' }).catch(() => undefined);
    onSiwcChange();
  }

  const gptReady = choice === 'siwc' ? !!siwc?.connected : choice === 'apikey' ? !!settings.apiKeys?.openai.set : false;
  const inUse = settings.gptMode === choice;

  return (
    <section className="panel" aria-label="AI 연결">
      <h2>AI 연결</h2>
      <Segmented small label="AI 연결" options={CHOICES} value={choice} onChange={setChoice} />
      <div className="ai-pane" key={choice}>
        {choice === 'claude' && <KeyForm provider="claude" info={settings.apiKeys?.claude} onSaved={onSettings} />}
        {choice === 'siwc' && (
          <>
            <Status on={!!siwc?.connected} text={siwc?.connected ? '연결됨' : '연결 안 됨'} />
            {!siwc?.connected && <ChatgptConnect onConnected={() => { onSiwcChange(); void useGpt('siwc'); }} />}
            {siwc?.connected && <button type="button" className="btn" onClick={disconnect}>연결 끊기</button>}
          </>
        )}
        {choice === 'apikey' && <KeyForm provider="openai" info={settings.apiKeys?.openai} onSaved={onSettings} />}
        {gptReady && (inUse
          ? <p className="chip ai in-use">GPT는 이 방식으로 써요</p>
          : <button type="button" className="btn btn-block" onClick={() => useGpt(choice as 'siwc' | 'apikey')}>GPT를 이 방식으로 쓰기</button>)}
      </div>
    </section>
  );
}

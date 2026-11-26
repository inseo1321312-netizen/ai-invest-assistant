import type { FastifyInstance } from 'fastify';
import type { SiwcTokenStore } from '../ai/siwcTokens.js';
import type { MarketService } from '../market/service.js';
import { parseInstrumentKey } from '../market/types.js';
import type { Persistence } from '../persist.js';

type State = 'ok' | 'warn' | 'fail' | 'off';
interface Check { id: string; label: string; state: State; detail: string }

const TIMEOUT_MS = 12_000;

function withTimeout<T>(p: Promise<T>): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('timeout')), TIMEOUT_MS))]);
}

/** 설정 화면의 "연결 점검": 각 연결이 되는지 한국어로 알려준다. 비밀값은 돌려주지 않는다. */
export function registerDiagnoseRoutes(app: FastifyInstance, deps: {
  market: MarketService;
  connected: { kis: boolean };
  siwc: SiwcTokenStore;
  persistence?: Persistence | null;
  checkClaude?: (() => Promise<void>) | null;
}) {
  app.get('/api/admin/diagnose', async () => {
    const checks: Check[] = await Promise.all([
      (async (): Promise<Check> => {
        try {
          const q = await withTimeout(deps.market.getQuote(parseInstrumentKey('coin:BTC-USDT')));
          return { id: 'okx', label: 'OKX 시세', state: 'ok', detail: `비트코인 ${q.price.toLocaleString('en-US')} USDT` };
        } catch {
          return { id: 'okx', label: 'OKX 시세', state: 'fail', detail: '연결 실패. 서버 지역에서 OKX 접속이 막혔을 수 있어요' };
        }
      })(),
      (async (): Promise<Check> => {
        if (!deps.connected.kis) return { id: 'kis', label: '한국투자증권', state: 'off', detail: '한국투자증권 앱키가 없어요(주식 시세·순위 꺼짐)' };
        try {
          const q = await withTimeout(deps.market.getQuote(parseInstrumentKey('kr:005930')));
          return { id: 'kis', label: '한국투자증권', state: q.price > 0 ? 'ok' : 'warn', detail: q.price > 0 ? `삼성전자 ${Math.round(q.price).toLocaleString('ko-KR')}원` : '연결은 됐지만 가격이 0으로 와요(응답 형식 확인 필요)' };
        } catch {
          return { id: 'kis', label: '한국투자증권', state: 'fail', detail: '앱키·앱시크릿을 확인하세요' };
        }
      })(),
      (async (): Promise<Check> => {
        if (!deps.checkClaude) return { id: 'claude', label: 'Claude', state: 'off', detail: 'Claude 키가 없어요' };
        try {
          await withTimeout(deps.checkClaude());
          return { id: 'claude', label: 'Claude', state: 'ok', detail: '키가 정상이에요' };
        } catch {
          return { id: 'claude', label: 'Claude', state: 'fail', detail: 'Claude 키를 확인하세요' };
        }
      })(),
      (async (): Promise<Check> => {
        if (!deps.siwc.has()) return { id: 'chatgpt', label: 'ChatGPT Plus', state: 'off', detail: '아직 연결 안 됨. PC에서 로그인 명령을 한 번 실행하세요' };
        try {
          await withTimeout(deps.siwc.getAccessToken());
          return { id: 'chatgpt', label: 'ChatGPT Plus', state: 'ok', detail: '연결됨' };
        } catch {
          return { id: 'chatgpt', label: 'ChatGPT Plus', state: 'fail', detail: '다시 로그인이 필요해요' };
        }
      })(),
      (async (): Promise<Check> => {
        const p = deps.persistence;
        if (!p) return { id: 'storage', label: '데이터 저장', state: 'warn', detail: '바깥 저장소(DATABASE_URL)가 없어요. 서버가 잠들면 데이터가 지워져요' };
        const s = p.status();
        if (s.lastError) return { id: 'storage', label: '데이터 저장', state: 'fail', detail: s.lastError };
        return { id: 'storage', label: '데이터 저장', state: 'ok', detail: '서버가 잠들어도 데이터가 유지돼요' };
      })(),
    ]);
    return { checks };
  });
}

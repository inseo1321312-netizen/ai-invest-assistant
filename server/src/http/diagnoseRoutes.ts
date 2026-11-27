import type { FastifyInstance } from 'fastify';
import type { SiwcTokenStore } from '../ai/siwcTokens.js';
import type { MarketService } from '../market/service.js';
import { parseInstrumentKey } from '../market/types.js';
import type { Persistence } from '../persist.js';
import type { InstrumentCatalog } from '../market/catalog.js';
import type { News } from '../market/news.js';
import type { UpbitClient } from '../market/upbit.js';
import type { KisClient } from '../market/kis.js';

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
  checkClaude?: (() => Promise<boolean | void>) | null;
  instruments?: InstrumentCatalog | null;
  upbit?: Pick<UpbitClient, 'markets'> | null;
  news?: Pick<News, 'search'> | null;
  /** 네이버 증권(주식 시세 기본 출처) */
  naver?: Pick<KisClient, 'getQuote'> | null;
  /** 한투 클라이언트 자체(대체 출처를 거치지 않고 확인) */
  kis?: Pick<KisClient, 'getQuote'> | null;
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
        if (!deps.upbit) return { id: 'upbit', label: '업비트', state: 'off', detail: '업비트 연결이 꺼져 있어요' };
        try {
          const m = await withTimeout(deps.upbit.markets());
          return { id: 'upbit', label: '업비트', state: m.length ? 'ok' : 'warn', detail: m.length ? `코인 한글 이름 ${m.length}개를 불러왔어요` : '업비트 목록이 비어 있어요' };
        } catch {
          return { id: 'upbit', label: '업비트', state: 'fail', detail: '연결 실패. 서버 지역에서 막혔을 수 있어요(김치 프리미엄·코인 한글 이름에 영향)' };
        }
      })(),
      (async (): Promise<Check> => {
        if (!deps.naver) return { id: 'naver', label: '네이버 증권', state: 'off', detail: '네이버 증권 연결이 꺼져 있어요' };
        try {
          const [kr, us] = await withTimeout(Promise.all([
            deps.naver.getQuote(parseInstrumentKey('kr:005930')),
            deps.naver.getQuote(parseInstrumentKey('us:NAS:AAPL')).catch(() => null),
          ]));
          return { id: 'naver', label: '네이버 증권', state: us ? 'ok' : 'warn', detail: `삼성전자 ${Math.round(kr.price).toLocaleString('ko-KR')}원${us ? `, 애플 ${us.price}` : ' (미국 시세는 못 받았어요)'}` };
        } catch {
          return { id: 'naver', label: '네이버 증권', state: 'fail', detail: '연결 실패. 서버 지역에서 막혔을 수 있어요(한투 앱키를 넣으면 한투로 받아요)' };
        }
      })(),
      (async (): Promise<Check> => {
        if (!deps.connected.kis) return { id: 'kis', label: '한국투자증권', state: 'off', detail: '앱키 없음. 주식 시세는 네이버 증권으로 받아요' };
        try {
          const q = await withTimeout((deps.kis ?? deps.market).getQuote(parseInstrumentKey('kr:005930')));
          return { id: 'kis', label: '한국투자증권', state: q.price > 0 ? 'ok' : 'warn', detail: q.price > 0 ? `삼성전자 ${Math.round(q.price).toLocaleString('ko-KR')}원` : '연결은 됐지만 가격이 0으로 와요(응답 형식 확인 필요)' };
        } catch {
          return { id: 'kis', label: '한국투자증권', state: 'fail', detail: '앱키·앱시크릿을 확인하세요' };
        }
      })(),
      (async (): Promise<Check> => {
        if (!deps.instruments) return { id: 'catalog', label: '종목 검색', state: 'off', detail: '종목 목록이 없어요' };
        try {
          const [kr, us] = await withTimeout(Promise.all([deps.instruments.search('삼성전자'), deps.instruments.search('AAPL')]));
          const hasKr = kr.some((h) => h.key === 'kr:005930');
          const hasUs = us.some((h) => h.key.endsWith(':AAPL'));
          if (hasKr && hasUs) return { id: 'catalog', label: '종목 검색', state: 'ok', detail: '삼성전자와 애플을 이름으로 찾을 수 있어요' };
          const missing = [!hasKr && '한국', !hasUs && '미국'].filter(Boolean).join('·');
          return { id: 'catalog', label: '종목 검색', state: 'warn', detail: `${missing} 종목 목록을 받지 못했어요(코인 검색은 돼요). 잠시 뒤 다시 점검해 보세요` };
        } catch {
          return { id: 'catalog', label: '종목 검색', state: 'fail', detail: '종목 목록을 불러오지 못했어요' };
        }
      })(),
      (async (): Promise<Check> => {
        if (!deps.news) return { id: 'news', label: '뉴스', state: 'off', detail: '뉴스 연결이 꺼져 있어요' };
        try {
          const items = await withTimeout(deps.news.search('비트코인'));
          return items.length
            ? { id: 'news', label: '뉴스', state: 'ok', detail: `기사 ${items.length}개를 가져왔어요` }
            : { id: 'news', label: '뉴스', state: 'warn', detail: '뉴스를 가져오지 못했어요. 잠시 뒤 다시 점검해 보세요' };
        } catch {
          return { id: 'news', label: '뉴스', state: 'warn', detail: '뉴스를 가져오지 못했어요. 잠시 뒤 다시 점검해 보세요' };
        }
      })(),
      (async (): Promise<Check> => {
        if (!deps.checkClaude) return { id: 'claude', label: 'Claude', state: 'off', detail: '키 없음 · 설정 → AI 연결' };
        try {
          if ((await withTimeout(deps.checkClaude())) === false) return { id: 'claude', label: 'Claude', state: 'off', detail: '키 없음 · 설정 → AI 연결' };
          return { id: 'claude', label: 'Claude', state: 'ok', detail: '키가 정상이에요' };
        } catch {
          return { id: 'claude', label: 'Claude', state: 'fail', detail: 'Claude 키를 확인하세요' };
        }
      })(),
      (async (): Promise<Check> => {
        if (!deps.siwc.has()) return { id: 'chatgpt', label: 'ChatGPT 구독', state: 'off', detail: '연결 안 됨 · 설정 → AI 연결' };
        try {
          await withTimeout(deps.siwc.getAccessToken());
          return { id: 'chatgpt', label: 'ChatGPT 구독', state: 'ok', detail: '연결됨' };
        } catch {
          return { id: 'chatgpt', label: 'ChatGPT 구독', state: 'fail', detail: '다시 로그인이 필요해요' };
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

import { z } from 'zod';

export interface Config {
  port: number;
  dataDir: string;
  production: boolean;
  appPassword: string;
  sessionSecret: string;
  anthropicApiKey: string | null;
  openaiApiKey: string | null;
  /** 한국투자증권 시세 조회용 앱키. 계좌번호는 쓰지 않는다(보기 전용) */
  kis: { appKey: string; appSecret: string } | null;
  vapid: { publicKey: string; privateKey: string; subject: string } | null;
  /** 스냅샷을 저장할 Postgres(Neon) 주소. 없으면 디스크에만 저장 */
  databaseUrl: string | null;
  /** 앱의 공개 주소(푸시 알림 발신자 표시용) */
  publicUrl: string | null;
}

const opt = z.string().optional().transform((v) => (v && v.trim() !== '' ? v.trim() : null));

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(8080),
  DATA_DIR: z.string().default('/data'),
  NODE_ENV: z.string().optional(),
  APP_PASSWORD: z.string({ error: 'APP_PASSWORD가 필요합니다' }).min(12, 'APP_PASSWORD는 12자 이상이어야 합니다'),
  SESSION_SECRET: z.string({ error: 'SESSION_SECRET이 필요합니다' }).min(32, 'SESSION_SECRET은 32자 이상이어야 합니다'),
  ANTHROPIC_API_KEY: opt,
  OPENAI_API_KEY: opt,
  KIS_APP_KEY: opt,
  KIS_APP_SECRET: opt,
  VAPID_PUBLIC_KEY: opt,
  VAPID_PRIVATE_KEY: opt,
  VAPID_SUBJECT: opt,
  DATABASE_URL: opt,
  PUBLIC_URL: opt,
  RENDER_EXTERNAL_URL: opt,
});

export function loadConfig(env: NodeJS.ProcessEnv | Record<string, string | undefined>): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`설정 오류 — ${msg}`);
  }
  const e = parsed.data;
  return {
    port: e.PORT,
    dataDir: e.DATA_DIR,
    production: e.NODE_ENV === 'production',
    appPassword: e.APP_PASSWORD,
    sessionSecret: e.SESSION_SECRET,
    anthropicApiKey: e.ANTHROPIC_API_KEY,
    openaiApiKey: e.OPENAI_API_KEY,
    kis: e.KIS_APP_KEY && e.KIS_APP_SECRET ? { appKey: e.KIS_APP_KEY, appSecret: e.KIS_APP_SECRET } : null,
    vapid: e.VAPID_PUBLIC_KEY && e.VAPID_PRIVATE_KEY && e.VAPID_SUBJECT
      ? { publicKey: e.VAPID_PUBLIC_KEY, privateKey: e.VAPID_PRIVATE_KEY, subject: e.VAPID_SUBJECT }
      : null,
    databaseUrl: e.DATABASE_URL,
    publicUrl: e.PUBLIC_URL ?? e.RENDER_EXTERNAL_URL,
  };
}

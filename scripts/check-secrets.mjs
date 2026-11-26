#!/usr/bin/env node
/**
 * 커밋될 파일에 비밀값(API 키, 토큰, 개인키)이 섞였는지 검사한다.
 *   node scripts/check-secrets.mjs        # 스테이징된 파일
 *   node scripts/check-secrets.mjs --all  # 저장소의 모든 파일
 * 찾으면 파일:줄을 출력하고 종료 코드 1로 끝난다.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PATTERNS = [
  [/sk-ant-[A-Za-z0-9_-]{16,}/, 'Anthropic API 키'],
  [/sk-proj-[A-Za-z0-9_-]{16,}/, 'OpenAI API 키'],
  [/\bsk-[A-Za-z0-9]{32,}/, 'API 키로 보이는 값'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, '개인키'],
  [/"(refreshToken|accessToken|refresh_token|access_token)"\s*:\s*"[^"]{20,}"/, '로그인 토큰'],
  [/(KEY|SECRET|TOKEN|PASSPHRASE|PASSWORD)["']?\s*[=:]\s*["']?[A-Za-z0-9+/_.-]{24,}/i, '이름 옆의 긴 비밀값'],
];

const SKIP = [/(^|\/)node_modules\//, /(^|\/)dist\//, /package-lock\.json$/, /\.(png|jpe?g|gif|ico|woff2?|ttf|pdf)$/i];

export function scanFileName(file) {
  const base = path.basename(file);
  if (base === '.env.example') return false;
  return base === '.env' || base.startsWith('.env.') || /^siwc-tokens.*\.json$/.test(base);
}

export function scanText(file, text) {
  const found = [];
  text.split(/\r?\n/).forEach((line, i) => {
    for (const [re, reason] of PATTERNS) {
      if (re.test(line)) { found.push({ file, line: i + 1, reason }); break; }
    }
  });
  return found;
}

function listFiles(all) {
  const args = all ? ['ls-files'] : ['diff', '--cached', '--name-only', '--diff-filter=ACMR'];
  return execFileSync('git', args, { encoding: 'utf8' }).split('\n').map((s) => s.trim()).filter(Boolean);
}

function main() {
  const files = listFiles(process.argv.includes('--all'));
  const problems = [];
  for (const f of files) {
    if (scanFileName(f)) { problems.push({ file: f, line: 0, reason: '환경변수·토큰 파일' }); continue; }
    if (SKIP.some((re) => re.test(f.replace(/\\/g, '/'))) || !existsSync(f)) continue;
    problems.push(...scanText(f, readFileSync(f, 'utf8')));
  }
  if (problems.length) {
    console.error('비밀값으로 보이는 내용이 있어 커밋을 멈췄습니다:');
    for (const p of problems) console.error(`  ${p.file}${p.line ? `:${p.line}` : ''}  (${p.reason})`);
    process.exit(1);
  }
  console.log(`비밀값 검사 통과 (${files.length}개 파일)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

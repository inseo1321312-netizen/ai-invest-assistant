import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanText, scanFileName } from './check-secrets.mjs';

test('flags an Anthropic key', () => {
  const found = scanText('server/src/x.ts', `const k = "sk-ant-api03-${'a'.repeat(40)}";`);
  assert.equal(found.length, 1);
  assert.equal(found[0].line, 1);
});

test('flags private keys and long secrets next to names', () => {
  assert.equal(scanText('a', '-----BEGIN ' + 'PRIVATE KEY-----').length, 1);
  assert.equal(scanText('a', `OKX_API_SECRET=${'Z'.repeat(32)}`).length, 1);
  assert.equal(scanText('a', `"refreshToken": "${'r'.repeat(40)}"`).length, 1);
});

test('passes clean files and empty example values', () => {
  assert.equal(scanText('.env.example', 'ANTHROPIC_API_KEY=\nOKX_API_SECRET=\n').length, 0);
  assert.equal(scanText('a.ts', "const appSecret = 'APPSECRET';\nconst t = 'sk-test';").length, 0);
});

test('flags real env files but not the example', () => {
  assert.equal(scanFileName('.env'), true);
  assert.equal(scanFileName('server/.env.local'), true);
  assert.equal(scanFileName('.env.example'), false);
  assert.equal(scanFileName('siwc-tokens.json'), true);
});

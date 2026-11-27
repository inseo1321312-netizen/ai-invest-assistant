import { afterEach, expect, test, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PriceAlertSheet } from '../src/components/PriceAlertSheet';
import { AlertSettings } from '../src/components/AlertSettings';
import { Holdings } from '../src/components/Holdings';
import { mockServer, quote } from './fakeServer';

afterEach(() => vi.unstubAllGlobals());

test('the sheet starts at the current price, says which way it will watch, and sets the alert', async () => {
  const s = mockServer({
    '/api/price-alerts': () => ({ alerts: [] }),
    'POST /api/price-alerts': () => ({ alert: { id: 3, key: 'kr:005930', name: null, op: 'above', price: 180000, createdAt: 1 } }),
  });
  render(<PriceAlertSheet keyId="kr:005930" name="삼성전자" price={178200} currency="KRW" onClose={() => {}} />);
  const box = screen.getByLabelText('목표가(원)') as HTMLInputElement;
  expect(box.value).toBe('178200');
  await userEvent.clear(box);
  await userEvent.type(box, '180000');
  expect(screen.getByText(/180,000원 이상이 되면 알려 드려요/)).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: '알림 걸기' }));
  await waitFor(() => expect(s.calls.find((c) => c.method === 'POST')?.body).toEqual({ key: 'kr:005930', price: 180000 }));
  expect(await screen.findByText('180,000원 이상')).toBeTruthy();
});

test('alerts already set for the stock are listed and can be removed', async () => {
  const s = mockServer({
    '/api/price-alerts': () => ({ alerts: [{ id: 1, key: 'kr:005930', name: '삼성전자', op: 'below', price: 170000, createdAt: 1 }, { id: 2, key: 'coin:BTC-USDT', name: '비트코인', op: 'above', price: 70000, createdAt: 1 }] }),
    'DELETE /api/price-alerts/1': () => ({ ok: true }),
  });
  render(<PriceAlertSheet keyId="kr:005930" name="삼성전자" price={178200} currency="KRW" onClose={() => {}} />);
  expect(await screen.findByText('170,000원 이하')).toBeTruthy();
  expect(screen.queryByText(/70,000 USDT/)).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: '170,000원 이하 알림 지우기' }));
  await waitFor(() => expect(s.calls.some((c) => c.method === 'DELETE')).toBe(true));
  expect(screen.queryByText('170,000원 이하')).toBeNull();
});

test('settings lists every price alert', async () => {
  mockServer({
    '/api/alerts': () => ({ coins: [], settings: { m5: 2, m15: 3, h1: 5, events: true } }),
    '/api/price-alerts': () => ({ alerts: [{ id: 1, key: 'kr:005930', name: '삼성전자', op: 'below', price: 170000, createdAt: 1 }] }),
  });
  render(<AlertSettings />);
  const section = await screen.findByRole('region', { name: '목표가 알림' });
  expect(await within(section).findByText(/삼성전자/)).toBeTruthy();
  expect(within(section).getByText(/170,000원 이하/)).toBeTruthy();
});

test('holdings show what you hold, not profit', async () => {
  mockServer({ '/api/holdings': () => ({ items: [{
    key: 'kr:005930', market: 'kr', name: '삼성전자', quantity: 10, avgPrice: 160000, addedAt: 1,
    instrument: { market: 'kr', symbol: '005930', kind: 'stock', exchange: null, name: '삼성전자' }, quote: quote(171500, 0.5, 'KRW'), plPct: 7.19,
  }] }) });
  render(<Holdings market="kr" onOpen={() => {}} />);
  const section = await screen.findByRole('region', { name: '보유 종목' });
  expect(within(section).getByText(/10주/)).toBeTruthy();
  expect(within(section).queryByText(/수익|평단/)).toBeNull();
});

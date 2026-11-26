import { expect, test } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { Avatar } from '../src/components/rows';

test('stocks and coins ask the server for their logo', () => {
  const { container } = render(<Avatar inst={{ market: 'kr', symbol: '005930', name: '삼성전자', exchange: null }} />);
  expect(container.querySelector('img')?.getAttribute('src')).toBe('/api/logo?key=kr%3A005930');
  const coin = render(<Avatar inst={{ market: 'coin', symbol: 'BTC-USDT-SWAP', name: '비트코인', exchange: null }} />);
  expect(coin.container.querySelector('img')?.getAttribute('src')).toBe('/api/logo?key=coin%3ABTC-USDT-SWAP');
  const us = render(<Avatar inst={{ market: 'us', symbol: 'AAPL', name: '애플', exchange: 'NAS' }} />);
  expect(us.container.querySelector('img')?.getAttribute('src')).toBe('/api/logo?key=us%3ANAS%3AAAPL');
});

test('when the logo fails the letters stay', () => {
  const { container } = render(<Avatar inst={{ market: 'kr', symbol: '999999', name: '없는회사', exchange: null }} />);
  fireEvent.error(container.querySelector('img')!);
  expect(container.querySelector('img')).toBeNull();
  expect(container.textContent).toBe('없는');
});

test('a loaded logo hides the letters', () => {
  const { container } = render(<Avatar inst={{ market: 'kr', symbol: '005930', name: '삼성전자', exchange: null }} />);
  fireEvent.load(container.querySelector('img')!);
  expect(container.querySelector('.avatar')!.classList.contains('has-logo')).toBe(true);
});

test('an explicit key is used as is; US without an exchange has no logo', () => {
  const t = render(<Avatar inst={{ market: 'coin', symbol: 'SSV', name: 'SSV' }} logoKey="coin:SSV-USDT" />);
  expect(t.container.querySelector('img')?.getAttribute('src')).toBe('/api/logo?key=coin%3ASSV-USDT');
  const u = render(<Avatar inst={{ market: 'us', symbol: 'AAPL', name: '애플' }} />);
  expect(u.container.querySelector('img')).toBeNull();
});

import { expect, test } from 'vitest';
import { render } from '@testing-library/react';
import { Markdown } from '../src/markdown';

test('renders bold, lists and headings instead of raw markdown marks', () => {
  const { container } = render(<Markdown text={'## 결론\n**관망**이 좋아요.\n\n- 첫째\n- 둘째\n\n1. 하나\n2. 둘'} />);
  expect(container.querySelector('h4')?.textContent).toBe('결론');
  expect(container.querySelector('strong')?.textContent).toBe('관망');
  expect(container.querySelectorAll('ul > li')).toHaveLength(2);
  expect(container.querySelectorAll('ol > li')).toHaveLength(2);
  expect(container.textContent).not.toContain('**');
});

test('only http links become links', () => {
  const { container } = render(<Markdown text={'[좋은](https://example.com) [나쁜](javascript:alert(1))'} />);
  const links = container.querySelectorAll('a');
  expect(links).toHaveLength(1);
  expect(links[0]!.getAttribute('href')).toBe('https://example.com');
  expect(links[0]!.getAttribute('rel')).toContain('noopener');
});

test('html in the text stays as text', () => {
  const { container } = render(<Markdown text={'<img src=x onerror=alert(1)>'} />);
  expect(container.querySelector('img')).toBeNull();
  expect(container.textContent).toContain('<img');
});

test('inline code and partial bold while streaming do not break', () => {
  const { container } = render(<Markdown text={'`RSI` 값이 **높'} />);
  expect(container.querySelector('code')?.textContent).toBe('RSI');
  expect(container.textContent).toContain('**높');
});

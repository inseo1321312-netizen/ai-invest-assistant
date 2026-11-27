import { expect, test, vi } from 'vitest';
import { watchForUpdates } from '../src/swUpdate';

function fakeEnv(hasController: boolean) {
  const sw = new EventTarget() as EventTarget & { controller: object | null; getRegistration: () => Promise<{ update: () => Promise<void> } | undefined> };
  sw.controller = hasController ? {} : null;
  const update = vi.fn(async () => {});
  sw.getRegistration = async () => ({ update });
  const doc = new EventTarget() as EventTarget & { visibilityState: string };
  doc.visibilityState = 'visible';
  return { nav: { serviceWorker: sw } as unknown as Navigator, doc: doc as unknown as Document, sw, update };
}

test('when a new version takes over, the screen reloads once so the old one never lingers', () => {
  const { nav, doc, sw } = fakeEnv(true);
  const reload = vi.fn();
  watchForUpdates(nav, doc, reload);
  sw.dispatchEvent(new Event('controllerchange'));
  sw.dispatchEvent(new Event('controllerchange'));
  expect(reload).toHaveBeenCalledTimes(1);
});

test('the very first install does not reload', () => {
  const { nav, doc, sw } = fakeEnv(false);
  const reload = vi.fn();
  watchForUpdates(nav, doc, reload);
  sw.dispatchEvent(new Event('controllerchange'));
  expect(reload).not.toHaveBeenCalled();
});

test('coming back to the app checks for a new version', async () => {
  const { nav, doc, update } = fakeEnv(true);
  watchForUpdates(nav, doc, vi.fn());
  doc.dispatchEvent(new Event('visibilitychange'));
  await vi.waitFor(() => expect(update).toHaveBeenCalled());
});

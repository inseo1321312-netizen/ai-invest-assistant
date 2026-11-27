/// <reference lib="webworker" />
import { cleanupOutdatedCaches, precacheAndRoute } from 'workbox-precaching';

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: (string | { url: string; revision: string | null })[] };

// 화면 파일만 미리 저장한다. /api 응답은 저장하지 않는다.
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

self.addEventListener('install', () => { void self.skipWaiting(); });
self.addEventListener('activate', (event) => { event.waitUntil(self.clients.claim()); });

self.addEventListener('push', (event) => {
  let data: { title?: string; body?: string; url?: string } = {};
  try { data = event.data?.json() ?? {}; } catch { data = { title: event.data?.text() }; }
  event.waitUntil(self.registration.showNotification(data.title ?? 'inzu', {
    body: data.body ?? '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: { url: data.url ?? '/' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data as { url?: string } | undefined)?.url ?? '/';
  event.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const client = list[0];
    if (client) {
      await client.focus();
      return;
    }
    await self.clients.openWindow(url);
  })());
});

/**
 * 배포 뒤 첫 실행에서 예전 화면이 남지 않게:
 * 새 버전이 깔려 자리를 넘겨받으면(controllerchange) 화면을 한 번 새로 고친다.
 * 앱으로 돌아올 때마다 새 버전이 있는지도 확인한다.
 */
export function watchForUpdates(nav: Navigator = navigator, doc: Document = document, reload: () => void = () => window.location.reload()): void {
  const sw = nav.serviceWorker;
  if (!sw) return;
  // 처음 설치될 때는 새로 고칠 필요가 없다(이미 새 화면)
  const hadController = Boolean(sw.controller);
  let reloading = false;
  sw.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return;
    reloading = true;
    reload();
  });
  doc.addEventListener('visibilitychange', () => {
    if (doc.visibilityState !== 'visible') return;
    void sw.getRegistration().then((r) => r?.update()).catch(() => undefined);
  });
}

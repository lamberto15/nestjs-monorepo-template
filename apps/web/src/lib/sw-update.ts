// The existing PWA update prompt and build-information menu share one action.
// A normal reload alone can keep the old shell while a new service worker waits.
let activateWaitingWorker: (() => Promise<void>) | undefined;

export function setPendingPwaUpdate(activate?: () => Promise<void>) {
  activateWaitingWorker = activate;
}

export function reloadForBuildUpdate(): void {
  if (activateWaitingWorker) {
    void activateWaitingWorker();
  } else {
    globalThis.location.reload();
  }
}

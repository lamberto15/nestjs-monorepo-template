import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { toast } from 'sonner';
import { registerSW } from 'virtual:pwa-register';
import '@nestjs-monorepo-template/ui/globals.css';
import { App, createApp } from '@/app';
import { initI18n } from '@/i18n';
import { listenForPreloadErrors } from '@/lib/preload-error';
import { listenForUncaughtErrors, rootErrorHandlers } from '@/lib/report-error';
import { reloadForBuildUpdate, setPendingPwaUpdate } from '@/lib/sw-update';
// For its side effect: it must hear `beforeinstallprompt` from the first page
// load, not when the signed-in layout (the user menu) is loaded.
import '@/lib/pwa';

// From the first moment: an error before the app renders is reported too.
listenForUncaughtErrors();
listenForPreloadErrors();

const { queryClient, router } = createApp();
const i18n = await initI18n();

createRoot(document.getElementById('root')!, rootErrorHandlers).render(
  <StrictMode>
    <App router={router} queryClient={queryClient} i18n={i18n} />
  </StrictMode>,
);

// The service worker (vite-plugin-pwa, `registerType: 'prompt'`): a new
// version waits until the user reloads, so no page is swapped under them.
const updateSW = registerSW({
  onNeedRefresh() {
    setPendingPwaUpdate(() => updateSW(true));
    toast(i18n.t('pwa:updateAvailable'), {
      duration: Infinity,
      action: {
        label: i18n.t('pwa:reload'),
        onClick: reloadForBuildUpdate,
      },
    });
  },
});

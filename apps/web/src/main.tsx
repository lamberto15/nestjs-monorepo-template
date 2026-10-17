import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { z } from 'zod';
import '@nestjs-monorepo-template/ui/globals.css';
import { App, createApp } from '@/app';
import { initI18n } from '@/i18n';

// Zod probes `new Function('')` to compile faster parsers; the Content-Security-Policy
// (caddy/Caddyfile) has no 'unsafe-eval', so the probe would be reported as a violation.
z.config({ jitless: true });

const { queryClient, router } = createApp();
const i18n = await initI18n();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App router={router} queryClient={queryClient} i18n={i18n} />
  </StrictMode>,
);

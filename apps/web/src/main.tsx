import { QueryClient } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@nestjs-monorepo-template/ui/globals.css';
import { App, createAppRouter } from '@/app';
import { initI18n } from '@/i18n';

const queryClient = new QueryClient();
const router = createAppRouter(queryClient);
const i18n = await initI18n();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App router={router} queryClient={queryClient} i18n={i18n} />
  </StrictMode>,
);

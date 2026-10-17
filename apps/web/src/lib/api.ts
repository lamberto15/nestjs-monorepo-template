import { createApiClient } from '@nestjs-monorepo-template/api-client';
import { i18n } from '@/i18n';

// Same-origin (dev proxy, Caddy): the __Host-sid cookie rides on every call.
// Accept-Language follows the UI language, read at each request.
export const api = createApiClient({
  baseUrl: '',
  credentials: 'include',
  get language() {
    return i18n.language;
  },
});

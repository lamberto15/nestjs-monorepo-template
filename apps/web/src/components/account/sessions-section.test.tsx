import { screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw/http';
import { describe, expect, it } from 'vitest';
import { renderComponent } from '@/test/render-component';
import { server } from '@/test/server';
import { SessionsSection } from './sessions-section';

const session = (extra: object) => ({
  id: 's1',
  createdAt: '2026-10-17T08:00:00.000Z',
  lastActiveAt: '2026-10-17T09:00:00.000Z',
  userAgent: null,
  device: null,
  method: null,
  provider: null,
  mfa: false,
  authenticatedAt: null,
  current: false,
  ...extra,
});

describe('the sessions list', () => {
  it('names the device, with the raw user agent only as a hint', async () => {
    const agent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605';
    server.use(
      http.get('/v1/auth/sessions', () =>
        HttpResponse.json({
          items: [
            session({ id: 's1', userAgent: agent, device: 'Safari on macOS' }),
            session({ id: 's2' }),
          ],
        }),
      ),
    );
    await renderComponent(<SessionsSection />);

    expect(await screen.findByText('Safari on macOS')).toHaveAttribute(
      'title',
      agent,
    );
    expect(screen.queryByText(agent)).not.toBeInTheDocument();
    expect(screen.getByText('Unknown device')).toBeVisible();
  });
});

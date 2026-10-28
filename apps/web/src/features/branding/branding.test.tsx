import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw/http';
import { afterEach, describe, expect, it } from 'vitest';
import { nav, visibleGroups } from '@/nav';
import type { Branding } from '@/lib/branding';
import { problem, server } from '@/test/server';
import { renderApp } from '@/test/render-app';
import { useSignedIn } from '@/test/signed-in';
import { findToast } from '@/test/toast';

const ADMIN = ['Access.manageSettings'];

const branding = (over: Partial<Branding> = {}): Branding => ({
  primaryColor: null,
  darkPrimaryColor: null,
  mailFromName: null,
  logoUrl: null,
  darkLogoUrl: null,
  locked: false,
  canEdit: true,
  ...over,
});

/** The branding API in memory: what the page sent is recorded. */
function useBrandingApi(initial: Branding) {
  const state = { current: initial };
  const calls = {
    put: [] as Record<string, unknown>[],
    uploaded: [] as { name: string; type: string }[],
    removed: 0,
  };
  useSignedIn(ADMIN);
  server.use(
    http.get('/v1/branding', () => HttpResponse.json(state.current)),
    http.put('/v1/branding', async ({ request }) => {
      const body = (await request.json()) as Record<string, string | null>;
      calls.put.push(body);
      state.current = { ...state.current, ...body };
      return HttpResponse.json(state.current);
    }),
    http.post('/v1/branding/logo', async ({ request }) => {
      const raw = await request.text();
      calls.uploaded.push({
        name: /filename="([^"]+)"/.exec(raw)?.[1] ?? '',
        type: /Content-Type: ([^\r\n]+)/i.exec(raw)?.[1] ?? '',
      });
      state.current = { ...state.current, logoUrl: '/v1/branding/t1/logo' };
      return HttpResponse.json(state.current, { status: 201 });
    }),
    http.delete('/v1/branding/logo', () => {
      calls.removed += 1;
      state.current = { ...state.current, logoUrl: null };
      return new HttpResponse(null, { status: 204 });
    }),
  );
  return calls;
}

describe('gating', () => {
  it('has a menu entry only with the permission', () => {
    const entries = (can: Record<string, boolean>) =>
      visibleGroups(nav, undefined, can).flatMap((g) =>
        g.items.map((i) => i.to),
      );
    expect(entries({})).not.toContain('/branding');
    expect(entries({ 'Access.manageSettings': true })).toContain('/branding');
  });

  it('sends a user without the permission away', async () => {
    useSignedIn(['Note.read']);
    const { router } = await renderApp('/branding');
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
  });
});

describe('the theme', () => {
  it('puts the tenant’s colour on the app, with a readable text colour', async () => {
    useBrandingApi(branding({ primaryColor: '#1d4ed8' }));
    await renderApp('/');
    await waitFor(() =>
      expect(document.documentElement.style.getPropertyValue('--primary')).toBe(
        '#1d4ed8',
      ),
    );
    expect(
      document.documentElement.style.getPropertyValue('--primary-foreground'),
    ).toBe('#ffffff');
  });

  it('shows the tenant’s logo in the menu', async () => {
    useBrandingApi(branding({ logoUrl: '/v1/branding/t1/logo' }));
    await renderApp('/');
    await waitFor(() =>
      expect(
        document.querySelector('img[src="/v1/branding/t1/logo"]'),
      ).not.toBeNull(),
    );
  });
});

describe('the dark theme', () => {
  afterEach(() => localStorage.clear());

  it('uses the dark-mode colour and logo there, and the plain ones in the light theme', async () => {
    useBrandingApi(
      branding({
        primaryColor: '#1d4ed8',
        darkPrimaryColor: '#93c5fd',
        logoUrl: '/v1/branding/t1/logo',
        darkLogoUrl: '/v1/branding/t1/logo/dark',
      }),
    );
    localStorage.setItem('theme', 'dark');
    await renderApp('/');
    await waitFor(() =>
      expect(document.documentElement.style.getPropertyValue('--primary')).toBe(
        '#93c5fd',
      ),
    );
    expect(
      document.querySelector('img[src="/v1/branding/t1/logo/dark"]'),
    ).not.toBeNull();
    expect(
      document.querySelector('img[src="/v1/branding/t1/logo"]'),
    ).toBeNull();
  });

  it('keeps the colour and the logo when there are no dark-mode ones', async () => {
    useBrandingApi(
      branding({ primaryColor: '#1d4ed8', logoUrl: '/v1/branding/t1/logo' }),
    );
    localStorage.setItem('theme', 'dark');
    await renderApp('/');
    await waitFor(() =>
      expect(document.documentElement.style.getPropertyValue('--primary')).toBe(
        '#1d4ed8',
      ),
    );
    expect(
      document.querySelector('img[src="/v1/branding/t1/logo"]'),
    ).not.toBeNull();
  });
});

describe('the page', () => {
  it('says a failed read, with a retry that loads the page', async () => {
    useBrandingApi(branding());
    let fail = true;
    server.use(
      http.get('/v1/branding', () =>
        fail ? problem(500, 'internal') : HttpResponse.json(branding()),
      ),
    );
    const user = userEvent.setup();
    await renderApp('/branding');
    expect(
      await screen.findByText('The branding could not be loaded'),
    ).toBeVisible();
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(
      await screen.findByRole('button', { name: 'Choose a colour' }),
    ).toBeVisible();
  });

  it('saves the colour and the sender name', async () => {
    const calls = useBrandingApi(branding());
    const user = userEvent.setup();
    await renderApp('/branding');
    await user.click(
      await screen.findByRole('button', { name: 'Choose a colour' }),
    );
    await user.type(screen.getByLabelText('Mail sender name'), 'Acme Support');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await findToast('Branding saved.');
    expect(calls.put).toEqual([
      {
        primaryColor: '#2563eb',
        darkPrimaryColor: null,
        mailFromName: 'Acme Support',
      },
    ]);
  });

  it('takes the colour off', async () => {
    const calls = useBrandingApi(
      branding({ primaryColor: '#112233', mailFromName: 'Acme' }),
    );
    const user = userEvent.setup();
    await renderApp('/branding');
    await user.click(
      await screen.findByRole('button', { name: 'Use the default colour' }),
    );
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await findToast('Branding saved.');
    expect(calls.put).toEqual([
      { primaryColor: null, darkPrimaryColor: null, mailFromName: 'Acme' },
    ]);
  });

  it('names the hue slider and the logo input for assistive technology', async () => {
    useBrandingApi(branding({ primaryColor: '#112233' }));
    await renderApp('/branding');
    expect(await screen.findByRole('slider', { name: 'Hue' })).toBeVisible();
    expect(
      screen.getByLabelText('Logo', { selector: 'input[type="file"]' }),
    ).toBeTruthy();
  });

  it('uploads a logo, and removes it', async () => {
    const calls = useBrandingApi(branding());
    const user = userEvent.setup();
    await renderApp('/branding');
    await screen.findByText('Drop the logo here');
    const input = document.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    await user.upload(
      input,
      new File(['png'], 'logo.png', { type: 'image/png' }),
    );
    await waitFor(() =>
      expect(calls.uploaded).toEqual([{ name: 'logo.png', type: 'image/png' }]),
    );
    expect(await screen.findByAltText('The current logo')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Remove the logo' }));
    await waitFor(() => expect(calls.removed).toBe(1));
    await waitFor(() =>
      expect(screen.queryByAltText('The current logo')).toBeNull(),
    );
  });

  it('shows the lock, and offers no change', async () => {
    useBrandingApi(
      branding({ locked: true, canEdit: false, primaryColor: '#112233' }),
    );
    await renderApp('/branding');
    expect(await screen.findByText(/locked the branding/)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(screen.getByLabelText('Mail sender name')).toBeDisabled();
    expect(screen.queryByText('Drop the logo here')).toBeNull();
  });

  it('shows the API’s refusal of a value', async () => {
    useBrandingApi(branding());
    server.use(
      http.put('/v1/branding', () =>
        problem(409, 'branding_locked', { detail: 'Locked by the operators.' }),
      ),
    );
    const user = userEvent.setup();
    await renderApp('/branding');
    await user.type(await screen.findByLabelText('Mail sender name'), 'Acme');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await findToast(/Locked by the operators/);
  });
});

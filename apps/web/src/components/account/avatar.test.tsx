import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw/http';
import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { personNameQuery, peopleQuery } from '@/lib/people';
import { peopleHandler } from '@/test/people';
import { renderApp } from '@/test/render-app';
import { findToast } from '@/test/toast';
import { allFeatures, problem, server, signedInUser } from '@/test/server';

/** The signed-in user, with this picture, and the routes the profile page and the nav read. */
function useAccount(state: { avatarUrl: string | null; puts: string[] }) {
  server.use(
    http.get('/v1/auth/me', () =>
      HttpResponse.json({
        ...signedInUser,
        user: { ...signedInUser.user, avatarUrl: state.avatarUrl },
      }),
    ),
    http.get('/v1/features', () =>
      HttpResponse.json({ ...allFeatures, realtime: false }),
    ),
    http.get('/v1/notifications/unread-count', () =>
      HttpResponse.json({ unread: 0 }),
    ),
    http.get('/v1/data', () => HttpResponse.json({ exports: [], imports: [] })),
    peopleHandler([]),
  );
}

describe('the account picture', () => {
  it('shows the initials without a picture, uploads one with PUT and removes it', async () => {
    const state = { avatarUrl: null as string | null, puts: [] as string[] };
    useAccount(state);
    server.use(
      http.put('/v1/account/avatar', async ({ request }) => {
        // `request.formData()` cannot read what the page sent: read the part's header.
        const raw = await request.text();
        state.puts.push(/filename="([^"]*)"/.exec(raw)?.[1] ?? '');
        state.avatarUrl = `/v1/people/${signedInUser.user.id}/avatar?v=abc`;
        return HttpResponse.json({ avatarUrl: state.avatarUrl });
      }),
      http.delete('/v1/account/avatar', () => {
        state.avatarUrl = null;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    await renderApp('/account/profile');
    // The nav and the page show the initials (AL).
    expect((await screen.findAllByText('AL')).length).toBeGreaterThan(0);
    expect(
      screen.queryByRole('button', { name: 'Remove' }),
    ).not.toBeInTheDocument();

    const user = userEvent.setup();
    const input = document.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    await user.upload(
      input,
      new File(['png'], 'me.png', { type: 'image/png' }),
    );
    await waitFor(() => expect(state.puts).toEqual(['me.png']));
    await findToast('Picture saved.');
    // The page reads the account again and offers to change or remove it.
    await user.click(await screen.findByRole('button', { name: 'Remove' }));
    await findToast('Picture removed.');
    await waitFor(() => expect(state.avatarUrl).toBeNull());
  });

  it("shows the API's refusal of a file", async () => {
    useAccount({ avatarUrl: null, puts: [] });
    server.use(
      http.put('/v1/account/avatar', () =>
        problem(415, 'unsupported_media_type', {
          detail: 'The file is application/pdf.',
        }),
      ),
    );
    await renderApp('/account/profile');
    const user = userEvent.setup();
    await screen.findByText('Choose a picture');
    const input = document.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    await user.upload(input, new File(['x'], 'me.png', { type: 'image/png' }));
    await findToast(/application\/pdf/);
  });

  it("leaves the size to the API: AVATAR_MAX_MB is an operator's setting, so a file over the 2 MB default is sent", async () => {
    useAccount({ avatarUrl: null, puts: [] });
    let sent = 0;
    server.use(
      http.put('/v1/account/avatar', async ({ request }) => {
        sent = (await request.arrayBuffer()).byteLength;
        return HttpResponse.json({
          avatarUrl: `/v1/people/${signedInUser.user.id}/avatar?v=big`,
        });
      }),
    );
    await renderApp('/account/profile');
    const user = userEvent.setup();
    await screen.findByText('Choose a picture');
    const input = document.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    await user.upload(
      input,
      new File([new Uint8Array(3 * 1024 * 1024)], 'big.png', {
        type: 'image/png',
      }),
    );
    await findToast('Picture saved.');
    expect(sent).toBeGreaterThan(3 * 1024 * 1024);
  });

  it("shows the API's refusal of a file that is too large", async () => {
    useAccount({ avatarUrl: null, puts: [] });
    server.use(
      http.put('/v1/account/avatar', () =>
        problem(413, 'payload_too_large', {
          detail: 'The file is larger than 1 MB.',
        }),
      ),
    );
    await renderApp('/account/profile');
    const user = userEvent.setup();
    await screen.findByText('Choose a picture');
    const input = document.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    await user.upload(
      input,
      new File([new Uint8Array(2 * 1024 * 1024)], 'big.png', {
        type: 'image/png',
      }),
    );
    await findToast(/larger than 1 MB/);
  });
});

describe('saving the profile', () => {
  it('reads again the name others see: the directory and the pickers', async () => {
    useAccount({ avatarUrl: null, puts: [] });
    server.use(
      http.patch('/v1/auth/me', () =>
        HttpResponse.json({ ...signedInUser.user, name: 'Ada Byron' }),
      ),
    );
    const { queryClient } = await renderApp('/account/profile');
    const user = userEvent.setup();
    const name = await screen.findByRole('textbox', { name: 'Name' });
    // Cached with the old name: audit actors, owner cells, mention pickers.
    const cached = [
      personNameQuery(`user:${signedInUser.user.id}`).queryKey,
      peopleQuery('ada').queryKey,
    ];
    for (const queryKey of cached) queryClient.setQueryData(queryKey, []);

    await user.clear(name);
    await user.type(name, 'Ada Byron');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await findToast('Profile saved.');
    for (const queryKey of cached) {
      expect(queryClient.getQueryState(queryKey)?.isInvalidated).toBe(true);
    }
  });
});

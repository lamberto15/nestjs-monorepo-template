import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw/http';
import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
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
});

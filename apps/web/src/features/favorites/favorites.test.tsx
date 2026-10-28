import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw/http';
import { describe, expect, it } from 'vitest';
import { renderApp } from '@/test/render-app';
import { renderComponent } from '@/test/render-component';
import { server } from '@/test/server';
import { useSignedIn } from '@/test/signed-in';
import type { Favorite } from './api';
import { FavoriteButton } from './favorite-button';

/** The API's favorites, kept in memory: added and removed. */
function useFavoritesApi(start: Favorite[] = []) {
  const state = { items: [...start] };
  server.use(
    http.get('/v1/favorites', () => HttpResponse.json({ items: state.items })),
    http.post('/v1/favorites', async ({ request }) => {
      const body = (await request.json()) as Omit<Favorite, 'id' | 'createdAt'>;
      const item = {
        ...body,
        subject: body.subject ?? '',
        id: `f${state.items.length + 1}`,
        createdAt: '2026-10-28T00:00:00.000Z',
      };
      state.items.push(item);
      return HttpResponse.json(item, { status: 201 });
    }),
    http.delete('/v1/favorites/:id', ({ params }) => {
      state.items = state.items.filter((item) => item.id !== params.id);
      return new HttpResponse(null, { status: 204 });
    }),
  );
  return state;
}

const page = (id: string, target: string, label: string): Favorite => ({
  id,
  kind: 'page',
  subject: '',
  target,
  label,
  createdAt: '2026-10-28T00:00:00.000Z',
});

describe('favorites', () => {
  it('lists them in the sidebar in their order, leaving out pages the menu does not show', async () => {
    useSignedIn(['Access.manageTags']);
    useFavoritesApi([
      page('f1', '/tags', 'My tags'),
      page('f2', '/tenants', 'Not mine to see'),
    ]);
    await renderApp('/');
    const menu = within(
      await screen.findByRole('navigation', { name: 'Main menu' }),
    );
    expect(await menu.findByText('Favorites')).toBeVisible();
    expect(menu.getByRole('link', { name: 'My tags' })).toHaveAttribute(
      'href',
      '/tags',
    );
    expect(menu.queryByRole('link', { name: 'Not mine to see' })).toBeNull();
  });

  it('pins and unpins a page from its star', async () => {
    const state = useFavoritesApi();
    const user = userEvent.setup();
    await renderComponent(
      <FavoriteButton kind="page" target="/notes" label="Notes" />,
    );
    const star = await screen.findByRole('button', {
      name: 'Add Notes to favorites',
    });
    expect(star).toHaveAttribute('aria-pressed', 'false');
    await user.click(star);
    await waitFor(() =>
      expect(state.items).toEqual([
        expect.objectContaining({ kind: 'page', target: '/notes' }),
      ]),
    );
    const pinned = await screen.findByRole('button', {
      name: 'Remove Notes from favorites',
    });
    expect(pinned).toHaveAttribute('aria-pressed', 'true');
    await user.click(pinned);
    await waitFor(() => expect(state.items).toEqual([]));
  });
});

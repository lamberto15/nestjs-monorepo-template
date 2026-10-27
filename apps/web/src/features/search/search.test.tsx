import {
  act,
  render,
  renderHook,
  screen,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw/http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { signedInWith } from '@/features/access/test/fixtures';
import { useDebounced } from '@/features/search/palette';
import { dashboard } from '@/features/dashboard/registry';
import { groupBySubject } from '@/features/search/api';
import { parseSnippet, Snippet } from '@/features/search/snippet';
import { axeViolations } from '@/test/axe';
import { renderApp } from '@/test/render-app';
import { server } from '@/test/server';

/** How the API names a subject in the request's language (`subjectLabel`). */
const labels: Record<string, { singular: string; plural: string }> = {
  TestItem: { singular: 'Test item', plural: 'Test items' },
  Task: { singular: 'Aufgabe', plural: 'Aufgaben' },
};

const hit = (id: string, extra: { subject?: string; link?: string } = {}) => ({
  subject: 'TestItem',
  subjectLabel: labels[extra.subject ?? 'TestItem']!,
  id,
  title: `Title ${id}`,
  snippet: `about <b>note</b> ${id}`,
  score: 0.5,
  link: '/access/teams',
  ...extra,
});

/** Answers GET /v1/search and records each request's query string. */
function searchApi(items: object[]) {
  const urls: URL[] = [];
  server.use(
    http.get('/v1/search', ({ request }) => {
      urls.push(new URL(request.url));
      return HttpResponse.json({ items });
    }),
  );
  return urls;
}

afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
});

describe('snippets', () => {
  it('turns only <b> and </b> into marks', () => {
    expect(parseSnippet('a <b>b</b> c')).toEqual([
      { text: 'a ', bold: false },
      { text: 'b', bold: true },
      { text: ' c', bold: false },
    ]);
  });

  it('shows an <img onerror> and a <script> as text, never as elements', () => {
    const evil =
      '<b>hit</b> <img src=x onerror="alert(1)"> <script>alert(2)</script>';
    const { container } = render(
      <p>
        <Snippet value={evil} />
      </p>,
    );
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelectorAll('mark')).toHaveLength(1);
    expect(container).toHaveTextContent(
      'hit <img src=x onerror="alert(1)"> <script>alert(2)</script>',
    );
  });

  it('keeps <b> with attributes as text', () => {
    expect(parseSnippet('<b onclick="x()">no</b>')).toEqual([
      { text: '<b onclick="x()">no', bold: false },
    ]);
  });
});

describe('grouping', () => {
  it('groups hits by subject, in the order of each subject’s best hit', () => {
    const groups = groupBySubject([
      hit('1', { subject: 'TestItem' }),
      hit('2', { subject: 'Task' }),
      hit('3', { subject: 'TestItem' }),
    ]);
    expect(
      groups.map((g) => [g.subject, g.label, g.items.map((i) => i.id)]),
    ).toEqual([
      ['TestItem', 'Test items', ['1', '3']],
      ['Task', 'Aufgaben', ['2']],
    ]);
  });
});

describe('the debounce', () => {
  it('follows the value only after the delay', () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      ({ value }) => useDebounced(value, 250),
      { initialProps: { value: 'a' } },
    );
    rerender({ value: 'ab' });
    act(() => {
      vi.advanceTimersByTime(249);
    });
    expect(result.current).toBe('a');
    rerender({ value: 'abc' });
    act(() => {
      vi.advanceTimersByTime(249);
    });
    expect(result.current).toBe('a');
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe('abc');
  });
});

async function openCommands(can: Record<string, boolean>) {
  signedInWith(can);
  const rendered = await renderApp('/');
  const user = userEvent.setup();
  await user.keyboard('{Control>}k{/Control}');
  await user.type(await screen.findByRole('combobox'), '>');
  return {
    ...rendered,
    user,
    dialog: within(await screen.findByRole('dialog')),
  };
}

describe('the palette', () => {
  it('opens with Ctrl+K and closes with Escape', async () => {
    signedInWith({});
    await renderApp('/');
    const user = userEvent.setup();
    await screen.findByRole('button', { name: 'Search (Ctrl+K)' });
    expect(screen.queryByRole('dialog')).toBeNull();
    await user.keyboard('{Control>}k{/Control}');
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('keeps the listbox valid with nothing to show (axe "aria-required-children", "aria-valid-attr-value"): a disabled option stands in for the hint or a message', async () => {
    signedInWith({});
    searchApi([]);
    await renderApp('/');
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole('button', { name: 'Search (Ctrl+K)' }),
    );
    const dialog = await screen.findByRole('dialog');
    const rules = ['aria-required-children', 'aria-valid-attr-value'];
    // Just opened: no recent searches, so the hint only, as a disabled option.
    expect(within(dialog).getByRole('listbox')).toBeInTheDocument();
    expect(
      within(dialog).getByRole('option', { name: /Type to search/ }),
    ).toHaveAttribute('aria-disabled', 'true');
    expect(await axeViolations(rules, dialog)).toEqual([]);
    // No hits: the message is a disabled option too, still no empty list.
    await user.type(within(dialog).getByRole('combobox'), 'nothing');
    const message = await within(dialog).findByText(/nothing/, {
      selector: '[role="status"]',
    });
    expect(message.closest('[role="option"]')).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(await axeViolations(rules, dialog)).toEqual([]);
  });

  it('opens with the header button', async () => {
    signedInWith({});
    await renderApp('/');
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole('button', { name: 'Search (Ctrl+K)' }),
    );
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('searches once for fast typing, groups the hits and marks the match', async () => {
    signedInWith({});
    const urls = searchApi([hit('1'), hit('2', { subject: 'Task' })]);
    await renderApp('/');
    const user = userEvent.setup();
    await user.keyboard('{Control>}k{/Control}');
    await user.type(await screen.findByRole('combobox'), 'note');

    expect(await screen.findByText('Title 1')).toBeInTheDocument();
    // Each group is named as the API names its subject (`subjectLabel`), not
    // by a local translation: the subject's key never shows.
    expect(screen.getByText('Test items')).toBeInTheDocument();
    expect(screen.getByText('Aufgaben')).toBeInTheDocument();
    expect(screen.queryByText('TestItem')).toBeNull();
    expect(
      within(screen.getByRole('dialog')).getAllByText('note')[0]!.tagName,
    ).toBe('MARK');
    expect(urls).toHaveLength(1);
    expect(urls[0]!.searchParams.get('q')).toBe('note');
    expect(urls[0]!.searchParams.get('limit')).toBe('20');
  });

  it('moves with the arrow keys and opens the chosen result by its link', async () => {
    signedInWith({ 'Access.manageRoles': true });
    searchApi([hit('1'), hit('2', { link: '/access/roles' })]);
    const { router } = await renderApp('/');
    const user = userEvent.setup();
    await user.keyboard('{Control>}k{/Control}');
    await user.type(await screen.findByRole('combobox'), 'note');
    await screen.findByText('Title 2');
    await user.keyboard('{ArrowDown}{Enter}');

    await vi.waitFor(() =>
      expect(router.state.location.pathname).toBe('/access/roles'),
    );
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('never follows a link that is not a path of this app', async () => {
    signedInWith({});
    searchApi([hit('1', { link: '//evil.example/x' })]);
    const { router } = await renderApp('/');
    const user = userEvent.setup();
    await user.keyboard('{Control>}k{/Control}');
    await user.type(await screen.findByRole('combobox'), 'note');
    const option = (await screen.findByText('Title 1')).closest('[cmdk-item]')!;
    expect(option).toHaveAttribute('aria-disabled', 'true');
    await user.click(option);
    expect(router.state.location.pathname).toBe('/');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('remembers searches and offers them when opened again', async () => {
    signedInWith({});
    searchApi([hit('1')]);
    await renderApp('/');
    const user = userEvent.setup();
    await user.keyboard('{Control>}k{/Control}');
    await user.type(await screen.findByRole('combobox'), 'note');
    await user.click(await screen.findByText('Title 1'));
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(JSON.parse(localStorage.getItem('recent-searches')!)).toEqual([
      'note',
    ]);

    await user.keyboard('{Control>}k{/Control}');
    expect(await screen.findByText('Recent searches')).toBeInTheDocument();
    expect(screen.getByText('note')).toBeInTheDocument();
  });

  it('lists the commands the user may see after ">" and goes there', async () => {
    const { router, user, dialog } = await openCommands({
      'Access.manageUsers': true,
    });
    expect(await dialog.findByText('Dashboard')).toBeInTheDocument();
    expect(dialog.getByText('Users')).toBeInTheDocument();
    // Gated: this user may not read the audit log or manage roles.
    expect(dialog.queryByText('Audit log')).toBeNull();
    expect(dialog.queryByText('Roles')).toBeNull();

    await user.type(screen.getByRole('combobox'), 'use');
    await user.keyboard('{Enter}');
    await vi.waitFor(() =>
      expect(router.state.location.pathname).toBe('/access/users'),
    );
  });

  it.skipIf(!dashboard.actions.some(({ to }) => String(to) === '/notes/new'))(
    'includes feature-provided actions and keeps their permission gates',
    async () => {
      const { router, user, dialog } = await openCommands({
        'Note.create': true,
      });
      expect(await dialog.findByText('New note')).toBeInTheDocument();
      expect(dialog.getByText('Actions')).toBeInTheDocument();
      await user.type(screen.getByRole('combobox'), 'new');
      await user.keyboard('{Enter}');
      await vi.waitFor(() =>
        expect(router.state.location.pathname).toBe('/notes/new'),
      );
    },
  );

  it('hides feature actions without their permission', async () => {
    const { dialog } = await openCommands({});
    expect(dialog.queryByText('New note')).toBeNull();
  });

  it('lists the audit log for someone who may read it', async () => {
    signedInWith({ 'Access.readAudit': true });
    await renderApp('/');
    const user = userEvent.setup();
    await user.keyboard('{Control>}k{/Control}');
    await user.type(await screen.findByRole('combobox'), '>');
    expect(
      await within(await screen.findByRole('dialog')).findByText('Audit log'),
    ).toBeInTheDocument();
  });
});

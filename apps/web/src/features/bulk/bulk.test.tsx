import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw/http';
import { describe, expect, it } from 'vitest';
import { renderApp } from '@/test/render-app';
import { sampleNote, useNotesApi, type TestNote } from '@/test/notes-api';
import { problem, server } from '@/test/server';

const ALL = ['Note.read', 'Note.delete', 'Note.restore'];
const A = '0199a3f2-0000-7000-8000-000000000601';
const B = '0199a3f2-0000-7000-8000-000000000602';

const notes = (deletedAt: string | null = null): TestNote[] => [
  sampleNote({ id: A, title: 'Old plan', deletedAt }),
  sampleNote({ id: B, title: 'Older plan', deletedAt }),
];

type Answer = { status?: number; body: Record<string, unknown> };

/**
 * `POST /v1/notes/bulk` answers `answer`; `GET /v1/bulk/{id}` walks
 * through `job` (one entry per poll, the last repeated). The list says how
 * many records match (`total`) and searches, so "all matching" has a filter.
 */
function useBulkApi(options: {
  answer?: Answer;
  job?: unknown[];
  total?: number;
  can?: string[];
  deleted?: boolean;
}) {
  const api = useNotesApi({
    can: options.can ?? ALL,
    notes: notes(options.deleted ? '2026-10-17T10:00:00.000Z' : null),
  });
  const calls = {
    bulk: [] as { body: unknown; key: string | null }[],
    polls: 0,
  };
  server.use(
    http.get('/v1/lists/:subject', () =>
      HttpResponse.json({
        subject: 'Note',
        fields: [
          {
            name: 'title',
            type: 'string',
            operators: ['contains'],
            sortable: true,
            custom: false,
          },
        ],
        select: ['id', 'title', 'createdAt'],
        search: true,
        recycleBin: true,
        defaultSort: '-createdAt',
        limits: { defaultLimit: 50, maxLimit: 100 },
      }),
    ),
    http.get('/v1/notes', ({ request }) => {
      const bin = new URL(request.url).searchParams.get('deleted') === 'true';
      const items = [...api.notes.values()].filter(
        (note) => !!note.deletedAt === bin,
      );
      return HttpResponse.json({
        items,
        page: 1,
        pageCount: 1,
        total: options.total ?? items.length,
      });
    }),
    http.post('/v1/notes/bulk', async ({ request }) => {
      calls.bulk.push({
        body: await request.json(),
        key: request.headers.get('idempotency-key'),
      });
      const answer = options.answer ?? {
        body: { done: 2, failed: 0, skipped: 0, results: [] },
      };
      return HttpResponse.json(answer.body, { status: answer.status ?? 200 });
    }),
    http.get('/v1/bulk/:id', () => {
      const steps = options.job ?? [];
      const step = steps[Math.min(calls.polls, steps.length - 1)];
      calls.polls += 1;
      return step ? HttpResponse.json(step) : problem(404, 'not_found');
    }),
  );
  return calls;
}

async function choose(...titles: string[]) {
  const user = userEvent.setup();
  for (const title of titles) {
    const row = (await screen.findByText(title)).closest('tr')!;
    await user.click(within(row).getByRole('checkbox', { name: 'Select row' }));
  }
  return user;
}

const bar = () => screen.findByRole('toolbar', { name: 'Selection actions' });

describe('selecting rows', () => {
  it('shows the action bar with the count, and clears it', async () => {
    useBulkApi({});
    await renderApp('/notes');
    const user = await choose('Old plan', 'Older plan');
    const toolbar = await bar();
    expect(within(toolbar).getByText('2 selected')).toBeVisible();
    await user.click(
      within(toolbar).getByRole('button', { name: 'Clear the selection' }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole('toolbar', { name: 'Selection actions' }),
      ).not.toBeInTheDocument(),
    );
    expect(
      screen.queryAllByRole('checkbox', { name: 'Select row', checked: true }),
    ).toHaveLength(0);
  });

  it('offers no selection without a bulk permission', async () => {
    useBulkApi({ can: ['Note.read'] });
    await renderApp('/notes');
    await screen.findByText('Old plan');
    expect(
      screen.queryByRole('checkbox', { name: 'Select row' }),
    ).not.toBeInTheDocument();
  });
});

describe('bulk delete', () => {
  it('asks first, then deletes the chosen notes in one request', async () => {
    const calls = useBulkApi({
      answer: {
        body: {
          done: 2,
          failed: 0,
          skipped: 0,
          results: [
            { id: A, status: 'done' },
            { id: B, status: 'done' },
          ],
        },
      },
    });
    await renderApp('/notes');
    const user = await choose('Old plan', 'Older plan');
    await user.click(
      within(await bar()).getByRole('button', { name: 'Delete' }),
    );
    const confirm = await screen.findByRole('alertdialog', {
      name: 'Delete 2 records?',
    });
    expect(calls.bulk).toHaveLength(0);
    await user.click(within(confirm).getByRole('button', { name: 'Delete' }));

    const run = await screen.findByRole('dialog', { name: 'Deleting' });
    expect(
      await within(run).findByText('2 done, 0 failed, 0 skipped.'),
    ).toBeVisible();
    expect(calls.bulk).toEqual([
      { body: { action: 'delete', ids: [A, B] }, key: expect.any(String) },
    ]);
    // The run ended: the selection is gone.
    await waitFor(() =>
      expect(
        screen.queryByRole('toolbar', { name: 'Selection actions' }),
      ).not.toBeInTheDocument(),
    );
  });

  it('lists the records it could not do, with the reason', async () => {
    useBulkApi({
      answer: {
        body: {
          done: 1,
          failed: 1,
          skipped: 0,
          results: [
            { id: A, status: 'done' },
            {
              id: B,
              status: 'failed',
              error: { code: 'forbidden', message: 'It is locked.' },
            },
          ],
        },
      },
    });
    await renderApp('/notes');
    const user = await choose('Old plan', 'Older plan');
    await user.click(
      within(await bar()).getByRole('button', { name: 'Delete' }),
    );
    await user.click(
      within(
        await screen.findByRole('alertdialog', { name: 'Delete 2 records?' }),
      ).getByRole('button', { name: 'Delete' }),
    );
    const problems = await screen.findByRole('list', {
      name: 'Records not done',
    });
    expect(within(problems).getAllByRole('listitem')).toHaveLength(1);
    expect(within(problems).getByText(/It is locked\./)).toBeVisible();
  });

  it('follows a run the API queued, until it ends', async () => {
    useBulkApi({
      answer: { status: 202, body: { id: 'job-1', status: 'queued' } },
      job: [
        {
          id: 'job-1',
          name: 'notes',
          action: 'delete',
          status: 'running',
          progress: { processed: 100, done: 99, failed: 1 },
        },
        {
          id: 'job-1',
          name: 'notes',
          action: 'delete',
          status: 'completed',
          progress: { processed: 150, done: 149, failed: 1 },
          result: { done: 149, failed: 1, skipped: 0, results: [] },
        },
      ],
    });
    await renderApp('/notes');
    const user = await choose('Old plan');
    await user.click(
      within(await bar()).getByRole('button', { name: 'Delete' }),
    );
    await user.click(
      within(
        await screen.findByRole('alertdialog', { name: 'Delete 1 record?' }),
      ).getByRole('button', { name: 'Delete' }),
    );
    const run = await screen.findByRole('dialog', { name: 'Deleting' });
    expect(
      await within(run).findByText('100 processed: 99 done, 1 failed.'),
    ).toBeVisible();
    // Polled every second.
    expect(
      await within(run).findByText(
        '149 done, 1 failed, 0 skipped.',
        {},
        { timeout: 4000 },
      ),
    ).toBeVisible();
  });

  it("acts on every match of the list's search, as a filter", async () => {
    const calls = useBulkApi({
      total: 120,
      answer: { status: 202, body: { id: 'job-2', status: 'queued' } },
      job: [
        {
          id: 'job-2',
          name: 'notes',
          action: 'delete',
          status: 'completed',
          progress: { processed: 120, done: 120, failed: 0 },
          result: { done: 120, failed: 0, skipped: 0, results: [] },
        },
      ],
    });
    await renderApp('/notes?q=plan');
    const user = userEvent.setup();
    await screen.findByText('Old plan');
    await user.click(screen.getByRole('checkbox', { name: 'Select all' }));
    const toolbar = await bar();
    expect(within(toolbar).getByText('2 selected')).toBeVisible();
    await user.click(
      within(toolbar).getByRole('button', {
        name: 'Select all 120 matching',
      }),
    );
    expect(within(toolbar).getByText('120 selected')).toBeVisible();
    await user.click(within(toolbar).getByRole('button', { name: 'Delete' }));
    await user.click(
      within(
        await screen.findByRole('alertdialog', { name: 'Delete 120 records?' }),
      ).getByRole('button', { name: 'Delete' }),
    );
    expect(
      await screen.findByText('120 done, 0 failed, 0 skipped.'),
    ).toBeVisible();
    expect(calls.bulk.map((call) => call.body)).toEqual([
      { action: 'delete', filter: { q: 'plan' } },
    ]);
  });

  it('offers no "all matching" without a filter (a run needs one)', async () => {
    useBulkApi({ total: 120 });
    await renderApp('/notes');
    const user = userEvent.setup();
    await screen.findByText('Old plan');
    await user.click(screen.getByRole('checkbox', { name: 'Select all' }));
    const toolbar = await bar();
    expect(within(toolbar).getByText('2 selected')).toBeVisible();
    expect(
      within(toolbar).queryByRole('button', { name: /Select all 120/ }),
    ).not.toBeInTheDocument();
  });
});

describe('bulk restore', () => {
  it('restores from the recycle bin without asking', async () => {
    const calls = useBulkApi({ deleted: true });
    await renderApp('/notes?deleted=true');
    const user = await choose('Old plan', 'Older plan');
    const toolbar = await bar();
    expect(
      within(toolbar).queryByRole('button', { name: 'Delete' }),
    ).not.toBeInTheDocument();
    await user.click(within(toolbar).getByRole('button', { name: 'Restore' }));
    const run = await screen.findByRole('dialog', { name: 'Restoring' });
    expect(
      await within(run).findByText('2 done, 0 failed, 0 skipped.'),
    ).toBeVisible();
    expect(calls.bulk.map((call) => call.body)).toEqual([
      { action: 'restore', ids: [A, B] },
    ]);
  });
});

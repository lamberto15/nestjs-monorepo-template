import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw/http';
import { describe, expect, it } from 'vitest';
import { renderApp } from '@/test/render-app';
import { renderComponent } from '@/test/render-component';
import { allFeatures, problem, server } from '@/test/server';
import { useSignedIn } from '@/test/signed-in';
import { findToast } from '@/test/toast';
import { ScheduleReportButton } from './schedule-button';

const REPORT_ID = '0199a3f2-0000-7000-8000-000000000901';

const report = (over: object = {}) => ({
  id: REPORT_ID,
  name: 'Weekly drafts',
  exporter: 'test-items',
  format: 'xlsx',
  filters: { q: 'draft' },
  timezone: 'Asia/Manila',
  schedule: { every: 'weekly', weekday: 1, hour: 8 },
  recipients: ['team@example.com'],
  active: true,
  lastRunAt: '2026-10-12T00:00:00.000Z',
  lastStatus: 'completed',
  lastTransferId: 'run-0',
  nextRunAt: '2026-10-19T00:00:00.000Z',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  ...over,
});

/** The reports API in memory, for a test-only subject's export (`test-items`). */
function useReportsApi(
  options: { reports?: ReturnType<typeof report>[]; reportsOn?: boolean } = {},
) {
  useSignedIn([]);
  const store = { reports: [...(options.reports ?? [report()])] };
  const calls = {
    created: [] as unknown[],
    patched: [] as unknown[],
    deleted: [] as string[],
    ran: [] as string[],
  };
  server.use(
    http.get('/v1/features', () =>
      HttpResponse.json({
        ...allFeatures,
        realtime: false,
        reports: options.reportsOn ?? true,
      }),
    ),
    http.get('/v1/data', () =>
      HttpResponse.json({
        exports: [
          { name: 'test-items', columns: ['title'], formats: ['csv', 'xlsx'] },
        ],
        imports: [],
      }),
    ),
    http.get('/v1/reports', () =>
      HttpResponse.json({ items: store.reports, nextCursor: null }),
    ),
    http.post('/v1/reports', async ({ request }) => {
      const body = (await request.json()) as { name: string };
      calls.created.push(body);
      if (body.name === 'Taken') {
        return problem(400, 'validation_failed', {
          errors: [{ path: 'exporter', message: 'You may not run it.' }],
        });
      }
      const created = report({ ...body, id: 'new', lastStatus: null });
      store.reports = [...store.reports, created];
      return HttpResponse.json(created, { status: 201 });
    }),
    http.patch('/v1/reports/:id', async ({ request, params }) => {
      const body = (await request.json()) as object;
      calls.patched.push(body);
      store.reports = store.reports.map((r) =>
        r.id === params.id ? { ...r, ...body } : r,
      );
      return HttpResponse.json(store.reports.find((r) => r.id === params.id));
    }),
    http.delete('/v1/reports/:id', ({ params }) => {
      calls.deleted.push(params.id as string);
      store.reports = store.reports.filter((r) => r.id !== params.id);
      return new HttpResponse(null, { status: 204 });
    }),
    http.post('/v1/reports/:id/run', ({ params }) => {
      calls.ran.push(params.id as string);
      return HttpResponse.json(
        { id: 'run-1', status: 'queued' },
        { status: 202 },
      );
    }),
    http.get('/v1/data/transfers/:id', ({ params }) =>
      HttpResponse.json({
        id: params.id,
        kind: 'export',
        name: 'test-items',
        format: 'xlsx',
        status: 'completed',
        progress: { processed: 4 },
        result: {
          rows: 4,
          url: `https://files.test/${String(params.id)}.xlsx`,
        },
      }),
    ),
  );
  return calls;
}

async function rowOf(name: string) {
  const table = await screen.findByRole('table', { name: 'Scheduled reports' });
  return within(table).getByText(name).closest('tr')!;
}

describe('the scheduled reports page', () => {
  it('lists the reports with their schedule in words', async () => {
    useReportsApi();
    await renderApp('/reports');
    const row = await rowOf('Weekly drafts');
    expect(within(row).getByText('Every Monday at 8:00 AM')).toBeVisible();
    expect(within(row).getByText('Asia/Manila')).toBeVisible();
    expect(within(row).getByText('Sent')).toBeVisible();
    expect(
      within(row).getByRole('switch', { name: 'Weekly drafts is active' }),
    ).toBeChecked();
    expect(
      screen.getByRole('link', { name: 'Scheduled reports' }),
    ).toBeVisible();
  });

  it('has no page and no menu entry when reports are off', async () => {
    useReportsApi({ reportsOn: false });
    await renderApp('/reports');
    expect(await screen.findByText(/not found/i)).toBeVisible();
    expect(
      screen.queryByRole('link', { name: 'Scheduled reports' }),
    ).not.toBeInTheDocument();
  });

  it('says when there are none', async () => {
    useReportsApi({ reports: [] });
    await renderApp('/reports');
    expect(await screen.findByText(/No reports yet/)).toBeVisible();
  });
});

describe('scheduling a report', () => {
  it('sends the schedule, the format and the recipients', async () => {
    const calls = useReportsApi({ reports: [] });
    await renderApp('/reports');
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole('button', { name: 'Schedule a report' }),
    );
    const dialog = await screen.findByRole('dialog', {
      name: 'Schedule a report',
    });
    await user.type(within(dialog).getByLabelText('Name'), 'Daily items');
    await user.click(within(dialog).getByRole('combobox', { name: 'Data' }));
    await user.click(await screen.findByRole('option', { name: 'test-items' }));
    await user.click(within(dialog).getByRole('combobox', { name: 'Repeats' }));
    await user.click(await screen.findByRole('option', { name: 'Daily' }));
    await user.click(within(dialog).getByRole('combobox', { name: 'At' }));
    await user.click(await screen.findByRole('option', { name: '7:00 AM' }));
    await user.type(
      within(dialog).getByLabelText('Recipients'),
      'team@example.com{Enter}',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Schedule' }));

    await waitFor(() => expect(calls.created).toHaveLength(1));
    expect(calls.created[0]).toEqual({
      name: 'Daily items',
      exporter: 'test-items',
      format: 'csv',
      filters: {},
      schedule: { every: 'daily', hour: 7 },
      active: true,
      recipients: ['team@example.com'],
    });
    expect(await rowOf('Daily items')).toBeVisible();
  });

  it('checks the form before it sends anything', async () => {
    const calls = useReportsApi({ reports: [] });
    await renderApp('/reports');
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole('button', { name: 'Schedule a report' }),
    );
    const dialog = await screen.findByRole('dialog', {
      name: 'Schedule a report',
    });
    await user.click(within(dialog).getByRole('button', { name: 'Schedule' }));
    expect(await within(dialog).findByText('Enter a name.')).toBeVisible();
    expect(within(dialog).getByText('Choose what to export.')).toBeVisible();
    expect(calls.created).toHaveLength(0);
  });

  it('refuses a name over 200 characters before it sends anything', async () => {
    const calls = useReportsApi({ reports: [] });
    await renderApp('/reports');
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole('button', { name: 'Schedule a report' }),
    );
    const dialog = await screen.findByRole('dialog', {
      name: 'Schedule a report',
    });
    await user.click(within(dialog).getByLabelText('Name'));
    await user.paste('x'.repeat(201));
    await user.click(within(dialog).getByRole('button', { name: 'Schedule' }));
    expect(
      await within(dialog).findByText('At most 200 characters.'),
    ).toBeVisible();
    expect(calls.created).toHaveLength(0);
  });

  it("puts the server's field errors on the fields", async () => {
    useReportsApi({ reports: [] });
    await renderApp('/reports');
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole('button', { name: 'Schedule a report' }),
    );
    const dialog = await screen.findByRole('dialog', {
      name: 'Schedule a report',
    });
    await user.type(within(dialog).getByLabelText('Name'), 'Taken');
    await user.click(within(dialog).getByRole('combobox', { name: 'Data' }));
    await user.click(await screen.findByRole('option', { name: 'test-items' }));
    await user.click(within(dialog).getByRole('button', { name: 'Schedule' }));
    expect(
      await within(dialog).findByText('You may not run it.'),
    ).toBeVisible();
  });

  it("schedules a list's export with the list's search", async () => {
    const calls = useReportsApi({ reports: [] });
    // As a list searched for "Q3" renders it (exportFilters(params)).
    await renderComponent(
      <ScheduleReportButton exporter="test-items" filters={{ q: 'Q3' }} />,
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Schedule' }));
    const dialog = await screen.findByRole('dialog', {
      name: 'Schedule a report',
    });
    const filters = within(dialog).getByRole('list', { name: 'Filters' });
    expect(within(filters).getByText('q: Q3')).toBeVisible();
    await user.type(within(dialog).getByLabelText('Name'), 'Q3 items');
    await user.click(within(dialog).getByRole('button', { name: 'Schedule' }));
    await waitFor(() => expect(calls.created).toHaveLength(1));
    expect(calls.created[0]).toMatchObject({
      name: 'Q3 items',
      exporter: 'test-items',
      filters: { q: 'Q3' },
      schedule: { every: 'weekly', weekday: 1, hour: 8 },
    });
  });
});

describe("a report's actions", () => {
  it('turns a report off', async () => {
    const calls = useReportsApi();
    await renderApp('/reports');
    const user = userEvent.setup();
    const row = await rowOf('Weekly drafts');
    await user.click(
      within(row).getByRole('switch', { name: 'Weekly drafts is active' }),
    );
    await waitFor(() => expect(calls.patched).toEqual([{ active: false }]));
    await waitFor(() =>
      expect(
        within(row).getByRole('switch', { name: 'Weekly drafts is active' }),
      ).not.toBeChecked(),
    );
  });

  it('runs a report now and shows its export', async () => {
    const calls = useReportsApi();
    await renderApp('/reports');
    const user = userEvent.setup();
    await user.click(
      within(await rowOf('Weekly drafts')).getByRole('button', {
        name: 'Actions for Weekly drafts',
      }),
    );
    await user.click(await screen.findByRole('menuitem', { name: 'Run now' }));
    await findToast('Weekly drafts is running.');
    const dialog = await screen.findByRole('dialog', { name: 'Weekly drafts' });
    expect(
      await within(dialog).findByRole('link', { name: 'Download (xlsx)' }),
    ).toHaveAttribute('href', 'https://files.test/run-1.xlsx');
    expect(calls.ran).toEqual([REPORT_ID]);
  });

  it('edits a report', async () => {
    const calls = useReportsApi();
    await renderApp('/reports');
    const user = userEvent.setup();
    await user.click(
      within(await rowOf('Weekly drafts')).getByRole('button', {
        name: 'Actions for Weekly drafts',
      }),
    );
    await user.click(await screen.findByRole('menuitem', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog', {
      name: 'Edit the report',
    });
    const name = within(dialog).getByLabelText('Name');
    expect(name).toHaveValue('Weekly drafts');
    await user.clear(name);
    await user.type(name, 'Monday drafts');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.patched).toHaveLength(1));
    expect(calls.patched[0]).toMatchObject({
      name: 'Monday drafts',
      exporter: 'test-items',
      format: 'xlsx',
      filters: { q: 'draft' },
      timezone: 'Asia/Manila',
      schedule: { every: 'weekly', weekday: 1, hour: 8 },
      recipients: ['team@example.com'],
    });
    expect(await rowOf('Monday drafts')).toBeVisible();
  });

  it('deletes a report after asking', async () => {
    const calls = useReportsApi();
    await renderApp('/reports');
    const user = userEvent.setup();
    await user.click(
      within(await rowOf('Weekly drafts')).getByRole('button', {
        name: 'Actions for Weekly drafts',
      }),
    );
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    const confirm = await screen.findByRole('alertdialog', {
      name: 'Delete this report?',
    });
    await user.click(within(confirm).getByRole('button', { name: 'Delete' }));
    await findToast('Weekly drafts was deleted.');
    expect(calls.deleted).toEqual([REPORT_ID]);
    expect(await screen.findByText(/No reports yet/)).toBeVisible();
  });
});

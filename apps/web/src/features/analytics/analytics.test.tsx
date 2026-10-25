import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw/http';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderApp } from '@/test/render-app';
import { server } from '@/test/server';
import { useSignedIn } from '@/test/signed-in';

const engine = vi.hoisted(() => ({
  loadLocalFile: vi.fn(),
  queryDataset: vi.fn(),
  disposeDataset: vi.fn(),
  terminateAnalyticsEngine: vi.fn(),
}));

vi.mock('./engine', () => engine);

const dataset = {
  id: 'session-1',
  name: 'records.csv',
  rowCount: 2,
  columns: [
    {
      name: 'city',
      type: 'VARCHAR',
      nullCount: 0,
      distinctCount: 2,
      min: null,
      max: null,
    },
    {
      name: 'amount',
      type: 'DOUBLE',
      nullCount: 0,
      distinctCount: 2,
      min: 2,
      max: 8,
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  engine.loadLocalFile.mockResolvedValue(dataset);
  engine.queryDataset.mockResolvedValue({
    columns: ['city', 'amount'],
    rows: [{ city: 'Riga', amount: 2 }],
    totalRows: 1,
  });
  engine.disposeDataset.mockResolvedValue(undefined);
  server.use(
    http.get('/v1/settings', () =>
      HttpResponse.json({
        items: [
          { key: 'analytics.browser.enabled', value: true, type: 'boolean' },
        ],
      }),
    ),
  );
});

describe('browser analytics', () => {
  it('profiles and queries a local file without uploading it, and disposes it on navigation', async () => {
    useSignedIn([]);
    await renderApp('/analytics');
    const file = new File(['city,amount\nRiga,2'], 'records.csv', {
      type: 'text/csv',
    });
    fireEvent.change(screen.getByLabelText('File'), {
      target: { files: [file] },
    });

    expect(await screen.findByText('records.csv')).toBeVisible();
    expect(
      await screen.findByRole('table', { name: 'Column profile' }),
    ).toBeVisible();
    expect(await screen.findByRole('table', { name: 'Results' })).toBeVisible();
    expect(engine.loadLocalFile).toHaveBeenCalledWith(file);
    expect(engine.queryDataset).toHaveBeenCalledWith(
      dataset,
      expect.objectContaining({ limit: 100 }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Close file' }));
    await waitFor(() =>
      expect(engine.disposeDataset).toHaveBeenCalledWith(dataset),
    );
  });

  it('keeps the route inaccessible while the setting is off', async () => {
    server.use(
      http.get('/v1/settings', () => HttpResponse.json({ items: [] })),
    );
    useSignedIn([]);
    await renderApp('/analytics');
    expect(
      await screen.findByRole('heading', { name: 'Quick actions' }),
    ).toBeVisible();
    expect(
      screen.queryByRole('heading', { name: 'Analyze a local data file' }),
    ).not.toBeInTheDocument();
    expect(engine.loadLocalFile).not.toHaveBeenCalled();
  });

  it('fetches an authorized export only after the user asks to open it locally', async () => {
    const statusRequests: string[] = [];
    server.use(
      http.get('/v1/data/transfers/:id', ({ params }) => {
        statusRequests.push(String(params.id));
        return HttpResponse.json({
          id: 'export-1',
          kind: 'export',
          name: 'notes',
          format: 'csv',
          status: 'completed',
          progress: { processed: 2 },
          result: { rows: 2, url: 'https://files.test/notes.csv' },
        });
      }),
      http.get(
        'https://files.test/notes.csv',
        () =>
          new HttpResponse('title\nLaunch', {
            headers: { 'content-type': 'text/csv' },
          }),
      ),
    );
    useSignedIn([]);
    await renderApp('/analytics?transferId=export-1');
    expect(statusRequests).toEqual([]);

    await userEvent.setup().click(
      await screen.findByRole('button', {
        name: 'Load completed export into this browser',
      }),
    );
    await waitFor(() => expect(engine.loadLocalFile).toHaveBeenCalled());
    expect(statusRequests).toEqual(['export-1']);
    expect(engine.loadLocalFile.mock.calls[0]?.[0]).toMatchObject({
      name: 'notes.csv',
    });
  });
});

import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw/http';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RealtimeProvider } from '@/lib/realtime';
import { createFakeRealtime, type FakeRealtime } from '@/test/fake-realtime';
import { TEST_RECORD, usePanelsApi } from '@/test/panels-api';
import { renderComponent } from '@/test/render-component';
import { allFeatures, problem, server, signedInUser } from '@/test/server';
import { RecordPanels } from './record-panels';

const connections: FakeRealtime[] = [];
vi.mock('@nestjs-monorepo-template/api-client', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('@nestjs-monorepo-template/api-client')
  >()),
  createRealtime: vi.fn(() => {
    const fake = createFakeRealtime();
    connections.push(fake);
    return fake;
  }),
}));

beforeEach(() => {
  connections.length = 0;
});

const ID = '0199a3f2-0000-7000-8000-000000000601';
const DOC = '0199a3f2-0000-7000-8000-000000000701';
const PDF = {
  id: 'att-1',
  name: 'note-1.pdf',
  size: 2048,
  contentType: 'application/pdf',
  uploadedBy: `user:${signedInUser.user.id}`,
  locked: true,
};
const CAN = ['TestItem.read', 'TestItem.update'];

/** The documents routes: what POST /pdf answers, and the job's states in turn. */
function useDocumentsApi(
  options: {
    issue?: () => Response;
    states?: object[];
  } = {},
) {
  const issued: { id: string; lang: string | null; key: string | null }[] = [];
  const states = [...(options.states ?? [])];
  server.use(
    http.post('/v1/test-items/:id/pdf', ({ params, request }) => {
      issued.push({
        id: params.id as string,
        lang: new URL(request.url).searchParams.get('lang'),
        key: request.headers.get('idempotency-key'),
      });
      return (
        options.issue?.() ??
        HttpResponse.json({ id: DOC, status: 'queued' }, { status: 202 })
      );
    }),
    http.get('/v1/documents/:id', () => {
      const state = states.length > 1 ? states.shift()! : states[0]!;
      return HttpResponse.json({
        id: DOC,
        source: 'note',
        subject: 'TestItem',
        recordId: ID,
        locale: 'en',
        attachmentId: null,
        error: null,
        issuedAt: null,
        createdAt: '2026-10-17T09:00:00.000Z',
        updatedAt: '2026-10-17T09:00:00.000Z',
        ...state,
      });
    }),
  );
  return issued;
}

async function mount(can = CAN) {
  return renderComponent(
    <RealtimeProvider>
      <RecordPanels
        subject={TEST_RECORD.subject}
        path={TEST_RECORD.path}
        id={ID}
      />
    </RealtimeProvider>,
    { can },
  );
}

async function openTab() {
  const user = userEvent.setup({ delay: null });
  await user.click(await screen.findByRole('tab', { name: 'Documents' }));
  return user;
}

describe('documents panel', () => {
  it('lists the issued PDFs with a download link, not other files', async () => {
    usePanelsApi({
      capabilities: { pdf: true },
      attachments: [
        PDF,
        { ...PDF, id: 'att-2', name: 'scan.pdf', locked: false },
      ],
    });
    useDocumentsApi({ states: [{ status: 'queued' }] });
    await mount();
    await openTab();
    const link = await screen.findByRole('link', {
      name: 'Download note-1.pdf',
    });
    expect(link).toHaveAttribute('href', '/v1/attachments/att-1/download');
    expect(screen.queryByText('scan.pdf')).not.toBeInTheDocument();
    expect(screen.getByText('By you')).toBeInTheDocument();
  });

  it('issues a document in the chosen language, follows the job, and lists the PDF', async () => {
    const attachments: (typeof PDF)[] = [];
    usePanelsApi({ capabilities: { pdf: true } });
    // The record's files as the worker leaves them: the PDF once it is done.
    server.use(
      http.get('/v1/test-items/:id/attachments', () =>
        HttpResponse.json({
          items: attachments.map((a) => ({
            subject: 'TestItem',
            recordId: ID,
            createdAt: '2026-10-17T09:40:00.000Z',
            updatedAt: '2026-10-17T09:40:00.000Z',
            ...a,
          })),
          nextCursor: null,
        }),
      ),
    );
    const issued = useDocumentsApi({
      states: [
        { status: 'queued' },
        { status: 'completed', attachmentId: 'att-1' },
      ],
    });
    await mount();
    const user = await openTab();
    expect(await screen.findByText('No documents issued yet.')).toBeVisible();

    // Arabic is written right to left by the API: the panel only passes it.
    await user.click(screen.getByRole('combobox', { name: 'Language' }));
    await user.click(await screen.findByRole('option', { name: 'العربية' }));
    await user.click(screen.getByRole('button', { name: 'Issue PDF' }));

    expect(await screen.findByRole('status')).toHaveTextContent(
      'Waiting to be made…',
    );
    expect(issued).toHaveLength(1);
    expect(issued[0]).toMatchObject({ id: ID, lang: 'ar' });
    expect(issued[0]!.key).toBeTruthy();

    // The worker is done: the socket says so, and the PDF joins the files.
    attachments.push(PDF);
    await waitFor(() => expect(connections).toHaveLength(1));
    act(() =>
      connections[0]!.emit('document.ready', {
        id: DOC,
        subject: 'TestItem',
        recordId: ID,
        attachmentId: 'att-1',
      }),
    );
    expect(
      await screen.findByRole('link', { name: 'Download note-1.pdf' }),
    ).toBeVisible();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('polls the job when there is no socket', async () => {
    server.use(
      http.get('/v1/features', () =>
        HttpResponse.json({ ...allFeatures, realtime: false }),
      ),
    );
    usePanelsApi({ capabilities: { pdf: true } });
    useDocumentsApi({
      states: [
        { status: 'queued' },
        { status: 'completed', attachmentId: 'att-1' },
      ],
    });
    await mount();
    const user = await openTab();
    await user.click(await screen.findByRole('button', { name: 'Issue PDF' }));
    expect(await screen.findByText('Waiting to be made…')).toBeVisible();
    await waitFor(
      () => expect(screen.queryByRole('status')).not.toBeInTheDocument(),
      { timeout: 4000 },
    );
  }, 8000);

  it('sends the UI language by default', async () => {
    usePanelsApi({ capabilities: { pdf: true } });
    const issued = useDocumentsApi({ states: [{ status: 'queued' }] });
    await mount();
    const user = await openTab();
    await user.click(await screen.findByRole('button', { name: 'Issue PDF' }));
    await waitFor(() => expect(issued[0]?.lang).toBe('en'));
  });

  it('shows why a document failed, and lets it go', async () => {
    usePanelsApi({ capabilities: { pdf: true } });
    useDocumentsApi({
      states: [
        { status: 'failed', error: 'The PDF service refused the page.' },
      ],
    });
    await mount();
    const user = await openTab();
    await user.click(await screen.findByRole('button', { name: 'Issue PDF' }));
    expect(
      await screen.findByText('The PDF service refused the page.'),
    ).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(
      screen.queryByText('The PDF service refused the page.'),
    ).not.toBeInTheDocument();
  });

  it('hears document.ready from the socket', async () => {
    usePanelsApi({ capabilities: { pdf: true } });
    useDocumentsApi({
      states: [
        { status: 'rendering' },
        { status: 'completed', attachmentId: 'att-1' },
      ],
    });
    await mount();
    const user = await openTab();
    await user.click(await screen.findByRole('button', { name: 'Issue PDF' }));
    expect(await screen.findByText('Making the PDF…')).toBeVisible();
    await waitFor(() => expect(connections).toHaveLength(1));
    act(() =>
      connections[0]!.emit('document.ready', {
        id: DOC,
        subject: 'TestItem',
        recordId: ID,
        attachmentId: 'att-1',
      }),
    );
    await waitFor(() =>
      expect(screen.queryByRole('status')).not.toBeInTheDocument(),
    );
  });

  it('on 503 documents_unavailable says so and hides the issue button', async () => {
    usePanelsApi({ capabilities: { pdf: true }, attachments: [PDF] });
    useDocumentsApi({
      issue: () => problem(503, 'documents_unavailable'),
    });
    await mount();
    const user = await openTab();
    await user.click(await screen.findByRole('button', { name: 'Issue PDF' }));
    expect(
      await screen.findByText(/PDF documents are not available right now/),
    ).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'Issue PDF' }),
    ).not.toBeInTheDocument();
    // What was issued before stays downloadable.
    expect(
      screen.getByRole('link', { name: 'Download note-1.pdf' }),
    ).toBeVisible();
  });

  it('follows the document already being made on 409 document_pending', async () => {
    usePanelsApi({ capabilities: { pdf: true } });
    useDocumentsApi({
      issue: () => problem(409, 'document_pending', { id: DOC }),
      states: [{ status: 'rendering' }],
    });
    await mount();
    const user = await openTab();
    await user.click(await screen.findByRole('button', { name: 'Issue PDF' }));
    expect(await screen.findByText('Making the PDF…')).toBeVisible();
  });
});

describe('documents panel gating', () => {
  it('has no tab when the subject takes no PDF', async () => {
    usePanelsApi({ capabilities: { pdf: false } });
    await mount();
    await screen.findByRole('tab', { name: 'Comments' });
    expect(
      screen.queryByRole('tab', { name: 'Documents' }),
    ).not.toBeInTheDocument();
  });

  it('has no tab when the documents feature is off', async () => {
    server.use(
      http.get('/v1/features', () =>
        HttpResponse.json({ ...allFeatures, documents: false }),
      ),
    );
    usePanelsApi({ capabilities: { pdf: true } });
    await mount();
    await screen.findByRole('tab', { name: 'Comments' });
    expect(
      screen.queryByRole('tab', { name: 'Documents' }),
    ).not.toBeInTheDocument();
  });
});

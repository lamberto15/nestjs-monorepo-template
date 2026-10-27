import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw/http';
import { describe, expect, it } from 'vitest';
import {
  NOTE_ID,
  sampleNote,
  useNotesApi,
} from '@/features/notes/test/notes-api';
import { renderApp } from '@/test/render-app';
import { server } from '@/test/server';

// The AI helper's panel is tested on a test-only subject
// (features/ai/ai-panel.test.tsx). Here, only that the note page wires it.

describe('AI helper on the note page', () => {
  it('shows the panel and asks for a run of source "note"', async () => {
    useNotesApi({ can: ['Note.read'], notes: [sampleNote()] });
    const posted: unknown[] = [];
    server.use(
      http.post('/v1/ai/runs', async ({ request }) => {
        posted.push(await request.json());
        return HttpResponse.json(
          { id: 'run-1', status: 'queued' },
          { status: 202 },
        );
      }),
    );
    await renderApp(`/notes/${NOTE_ID}`);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Summarize' }));
    await screen.findByText('Summarizing…');
    expect(posted).toEqual([
      { source: 'note', recordId: NOTE_ID, task: 'summarize' },
    ]);
  });
});

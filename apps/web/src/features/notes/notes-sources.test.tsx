import { screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw/http';
import { describe, expect, it } from 'vitest';
import { sampleNote, useNotesApi } from '@/features/notes/test/notes-api';
import { panelsDescription } from '@/test/panels-api';
import { renderApp } from '@/test/render-app';
import { problem, server } from '@/test/server';

/**
 * The routes only some users may read, with the permission each takes
 * (docs/permissions.md). A list's reference sources must not ask for them
 * unless the user holds it: the API would answer 403 and log a warning.
 */
const GATED = [
  { path: '/v1/access/principals', permission: 'Access.manageUsers' },
  { path: '/v1/access/teams', permission: 'Access.manageTeams' },
  { path: '/v1/tenants', permission: 'Access.manageTenants' },
] as const;

const ref = (name: string, ref: string, type = 'uuid') => ({
  name,
  type,
  operators: ['eq', 'in'],
  sortable: false,
  custom: false,
  ref,
});

/** A notes list whose fields point at tags, teams and users. */
const description = {
  subject: 'Note',
  fields: [
    {
      name: 'title',
      type: 'string',
      operators: ['contains'],
      sortable: true,
      custom: false,
    },
    ref('tags', 'tag'),
    ref('teamId', 'team'),
    ref('ownerId', 'principal', 'string'),
  ],
  select: ['id', 'number', 'title', 'status', 'tags', 'createdAt'],
  search: false,
  recycleBin: true,
  defaultSort: '-createdAt',
  limits: { defaultLimit: 50, maxLimit: 100 },
  ...panelsDescription(),
};

/** Serves the notes API to a user holding `can`; returns the gated paths asked. */
function useGatedApi(can: string[]) {
  const asked: string[] = [];
  useNotesApi({ can, notes: [sampleNote()] });
  server.use(
    http.get('/v1/lists/:subject', () => HttpResponse.json(description)),
    http.get('/v1/people', () => HttpResponse.json({ items: [] })),
    http.get('/v1/teams', () =>
      HttpResponse.json({ items: [], page: 1, pageCount: 1 }),
    ),
    // Whoever asks without the permission is refused, as the API does.
    ...GATED.map(({ path, permission }) =>
      http.get(path, () => {
        asked.push(path);
        return can.includes(permission)
          ? HttpResponse.json({ items: [], page: 1, pageCount: 1 })
          : problem(403, 'forbidden');
      }),
    ),
  );
  return asked;
}

/** Opens the notes list and waits for the sidebar's and filters' queries. */
async function openList() {
  await renderApp('/notes');
  await screen.findByText('NOTE-2026-00001');
  await new Promise((resolve) => setTimeout(resolve, 100));
}

describe('the notes list requests only what the user may read', () => {
  it('asks a viewer for no route their can refuses', async () => {
    const asked = useGatedApi(['Note.read']);
    await openList();
    expect(asked).toEqual([]);
  });

  it('asks an editor for no route their can refuses', async () => {
    const editor = [
      'Note.read',
      'Note.create',
      'Note.update',
      'Note.delete',
      'Note.restore',
    ];
    const asked = useGatedApi(editor);
    await openList();
    expect(asked).toEqual([]);
  });

  it('never asks the tenants for an administrator who is no operator (/me says)', async () => {
    const asked = useGatedApi([
      'Note.read',
      'Access.manageUsers',
      'Access.manageTeams',
      'Access.manageTenants',
    ]);
    await openList();
    expect(asked).not.toContain('/v1/tenants');
  });
});

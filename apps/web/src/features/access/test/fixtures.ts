import { http, HttpResponse } from 'msw/http';
import type { Member, Role, Team } from '@/features/access/api';
import type { Catalog } from '@/features/access/permissions';
import type { Me } from '@/lib/session';
import { allFeatures, server, signedInUser } from '@/test/server';

// The access API as the tests see it: GET /v1/access/catalog's shape
// (PermissionCatalog.view), roles and members as the API lists them.

export const catalog: Catalog = {
  subjects: [
    {
      subject: 'Access',
      label: 'Access control',
      fields: [],
      actions: [
        {
          action: 'manageRoles',
          label: 'Create, edit and delete roles',
          conditions: [],
        },
        {
          action: 'manageUsers',
          label: 'Create users, assign roles',
          conditions: [],
        },
      ],
    },
    {
      subject: 'Note',
      label: 'Notes',
      fields: [
        { field: 'body', label: "The note's text", sensitive: false },
        { field: 'custom', label: 'The custom fields', sensitive: true },
      ],
      actions: [
        {
          action: 'read',
          label: 'See notes',
          conditions: [
            {
              key: 'mine',
              label: 'Created by me',
              description: 'Only my records.',
              input: null,
            },
            {
              key: 'inMyTeams',
              label: 'In my teams',
              description: 'Only my teams’.',
              input: null,
            },
          ],
        },
        { action: 'create', label: 'Write notes', conditions: [] },
        {
          action: 'update',
          label: 'Change notes',
          conditions: [
            {
              key: 'mine',
              label: 'Created by me',
              description: 'Only my records.',
              input: null,
            },
            {
              key: 'draft',
              label: 'Still a draft',
              description: 'Only drafts.',
              input: null,
            },
          ],
        },
      ],
    },
    {
      subject: 'Expense',
      label: 'Expenses',
      fields: [],
      actions: [
        {
          action: 'approve',
          label: 'Approve expenses',
          conditions: [
            {
              key: 'upTo',
              label: 'Up to an amount',
              description: 'Only expenses up to this amount.',
              input: { name: 'max', label: 'Amount', type: 'cents' },
            },
          ],
        },
      ],
    },
  ],
};

export const ids = {
  admin: '00000000-0000-7000-8000-00000000a001',
  editor: '00000000-0000-7000-8000-00000000a002',
  viewer: '00000000-0000-7000-8000-00000000a003',
  sales: '00000000-0000-7000-8000-00000000b001',
  north: '00000000-0000-7000-8000-00000000b002',
  bob: '00000000-0000-7000-8000-00000000c001',
  carol: '00000000-0000-7000-8000-00000000c002',
  invitation: '00000000-0000-7000-8000-00000000d001',
};

const at = '2026-10-01T10:00:00.000Z';

export const roles: Role[] = [
  {
    id: ids.admin,
    key: 'administrator',
    name: 'Administrator',
    description: 'Everything.',
    system: true,
    permissions: [{ subject: 'all', action: 'manage', conditions: [] }],
    members: 1,
    createdAt: at,
    updatedAt: at,
  },
  {
    id: ids.editor,
    key: 'editor',
    name: 'Editor',
    description: 'Writes records.',
    system: false,
    permissions: [
      { subject: 'Note', action: 'read', conditions: [{ key: 'mine' }] },
      { subject: 'Note', action: 'create', conditions: [] },
    ],
    members: 2,
    createdAt: at,
    updatedAt: at,
  },
  {
    id: ids.viewer,
    key: 'viewer',
    name: 'Viewer',
    description: 'Sees everything.',
    system: false,
    permissions: [{ subject: 'Note', action: 'read', conditions: [] }],
    members: 0,
    createdAt: at,
    updatedAt: at,
  },
];

export const teams: Team[] = [
  {
    id: ids.sales,
    name: 'Sales',
    parentId: null,
    depth: 0,
    members: 1,
    createdAt: at,
    updatedAt: at,
  },
  {
    id: ids.north,
    name: 'North',
    parentId: ids.sales,
    depth: 1,
    members: 0,
    createdAt: at,
    updatedAt: at,
  },
];

export const bob: Member = {
  id: ids.bob,
  email: 'bob@example.com',
  name: 'Bob Builder',
  emailVerified: true,
  active: true,
  hasPassword: true,
  createdAt: at,
  updatedAt: at,
  roleIds: [ids.editor, ids.viewer],
  // Viewer was temporary and has ended: it counts for nothing.
  roles: [
    { roleId: ids.editor, expiresAt: null },
    { roleId: ids.viewer, expiresAt: '2026-01-01T00:00:00.000Z' },
  ],
  teamIds: [ids.sales],
};

export const carol: Member = {
  ...bob,
  id: ids.carol,
  email: 'carol@example.com',
  name: 'Carol Admin',
  roleIds: [ids.admin],
  roles: [{ roleId: ids.admin, expiresAt: null }],
  teamIds: [],
};

/** Signed in, with these permissions and the impersonation switch. */
export function signedInWith(
  can: Record<string, boolean>,
  options: { impersonation?: boolean } = {},
) {
  const me: Me = { ...signedInUser, can };
  server.use(
    http.get('/v1/auth/me', () => HttpResponse.json(me)),
    http.get('/v1/features', () =>
      HttpResponse.json({
        ...allFeatures,
        // No socket in these tests.
        realtime: false,
        impersonation: options.impersonation ?? false,
      }),
    ),
    http.get('/v1/access/catalog', () =>
      HttpResponse.json({ ...catalog, systemJobs: [] }),
    ),
    http.get('/v1/access/roles', () => HttpResponse.json({ items: roles })),
    http.get('/v1/access/teams', () => HttpResponse.json({ items: teams })),
    http.get('/v1/access/users', () =>
      HttpResponse.json({
        items: [bob, carol],
        page: 1,
        nextPage: null,
        pageCount: 1,
        total: 2,
      }),
    ),
    http.get('/v1/notifications/unread-count', () =>
      HttpResponse.json({ unread: 0 }),
    ),
    http.get('/v1/access/invitations', () => HttpResponse.json({ items: [] })),
  );
  return me;
}

export const everything = {
  'Access.manageRoles': true,
  'Access.manageUsers': true,
  'Access.manageTeams': true,
  'Note.read': true,
  'Note.create': true,
  'Note.update': true,
};

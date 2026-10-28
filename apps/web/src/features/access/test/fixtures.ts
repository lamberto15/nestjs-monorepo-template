import { http, HttpResponse } from 'msw/http';
import type { Member, Role, Unit } from '@/features/access/api';
import type { Catalog } from '@/features/access/permissions';
import type { Me } from '@/lib/session';
import { allFeatures, problem, server, signedInUser } from '@/test/server';

// The access API as the tests see it, typed by the client: the catalog,
// roles, units and members as the API lists them.

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
              key: 'inMyUnits',
              label: 'In my units',
              description: 'Only my units’.',
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
  systemJobs: [],
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
  tenant: '00000000-0000-7000-8000-00000000e001',
};

const at = '2026-10-01T10:00:00.000Z';

export const roles: Role[] = [
  {
    id: ids.admin,
    tenantId: ids.tenant,
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
    tenantId: ids.tenant,
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
    tenantId: ids.tenant,
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

export const units: Unit[] = [
  {
    id: ids.sales,
    type: 'division',
    name: 'Sales',
    parentId: null,
    depth: 0,
    members: 1,
    managedByScim: false,
    createdAt: at,
    updatedAt: at,
  },
  {
    id: ids.north,
    type: 'team',
    name: 'North',
    parentId: ids.sales,
    depth: 1,
    members: 0,
    managedByScim: false,
    createdAt: at,
    updatedAt: at,
  },
];

export const bob: Member = {
  id: ids.bob,
  kind: 'user',
  email: 'bob@example.com',
  name: 'Bob Builder',
  emailVerified: true,
  locale: null,
  timezone: null,
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
  unitIds: [ids.sales],
};

export const carol: Member = {
  ...bob,
  id: ids.carol,
  email: 'carol@example.com',
  name: 'Carol Admin',
  roleIds: [ids.admin],
  roles: [{ roleId: ids.admin, expiresAt: null }],
  unitIds: [],
};

/** GET /v1/lists/User, as the API describes the members' list. */
export const userListDescription = {
  subject: 'User',
  fields: [
    {
      name: 'email',
      type: 'string',
      operators: ['eq', 'contains', 'startsWith', 'endsWith'],
      sortable: true,
      custom: false,
    },
    {
      name: 'name',
      type: 'string',
      operators: ['contains', 'startsWith'],
      sortable: true,
      custom: false,
    },
    {
      name: 'active',
      type: 'boolean',
      operators: ['eq'],
      sortable: false,
      custom: false,
    },
    {
      name: 'unitId',
      type: 'uuid',
      operators: ['eq', 'in'],
      sortable: false,
      custom: false,
      ref: 'unit',
    },
    {
      name: 'createdAt',
      type: 'datetime',
      operators: ['gt', 'gte', 'lt', 'lte', 'between'],
      sortable: true,
      custom: false,
    },
  ],
  select: ['id', 'email', 'name', 'active', 'roles', 'createdAt'],
  search: false,
  recycleBin: false,
  defaultSort: '-createdAt',
  limits: { defaultLimit: 50, maxLimit: 100 },
};

/** The units a members query asks for (flat `unitId`, or in `filter`); none: all. */
function unitIdsOf(query: URLSearchParams): string[] | undefined {
  const flat = query.get('unitId');
  if (flat) return [flat];
  const filter = query.get('filter');
  if (!filter) return undefined;
  const found: string[] = [];
  const visit = (node: Record<string, unknown>) => {
    if (node.field === 'unitId') {
      found.push(...([node.value].flat() as string[]));
    }
    for (const child of [
      ...((node.and ?? []) as []),
      ...((node.or ?? []) as []),
    ]) {
      visit(child);
    }
  };
  visit(JSON.parse(filter) as Record<string, unknown>);
  return found.length > 0 ? found : undefined;
}

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
    http.get('/v1/access/catalog', () => HttpResponse.json(catalog)),
    http.get('/v1/access/roles', () => HttpResponse.json({ items: roles })),
    http.get('/v1/access/roles/:id', ({ params }) => {
      const role = roles.find((item) => item.id === params.id);
      return role ? HttpResponse.json(role) : problem(404, 'not_found');
    }),
    http.get('/v1/access/organizational-units', () =>
      HttpResponse.json({ items: units }),
    ),
    // Nobody is in any unit unless a test says so.
    http.get('/v1/access/organizational-units/:id/members', () =>
      HttpResponse.json({ items: [] }),
    ),
    // The directory any member may read (what list filters and cells name units by).
    http.get('/v1/organizational-units', () =>
      HttpResponse.json({ items: units, nextCursor: null }),
    ),
    http.get('/v1/lists/User', () => HttpResponse.json(userListDescription)),
    // The members, as the API filters them: `?unitId=` (a unit's direct
    // members) flat or as a condition of `filter`.
    http.get('/v1/access/users', ({ request }) => {
      const query = new URL(request.url).searchParams;
      const unitIds = unitIdsOf(query);
      const items = [bob, carol].filter(
        (member) =>
          !unitIds || unitIds.some((id) => member.unitIds.includes(id)),
      );
      return HttpResponse.json({
        items,
        page: 1,
        nextPage: null,
        pageCount: 1,
        total: items.length,
      });
    }),
    http.get('/v1/access/users/:id', ({ params }) => {
      const member = [bob, carol].find((item) => item.id === params.id);
      return member ? HttpResponse.json(member) : problem(404, 'not_found');
    }),
    http.get('/v1/notifications/unread-count', () =>
      HttpResponse.json({ unread: 0 }),
    ),
    http.get('/v1/access/invitations', () => HttpResponse.json({ items: [] })),
  );
  return me;
}

/** A pending invitation as `GET /v1/access/invitations` lists it. */
export const invitation = {
  id: ids.invitation,
  email: 'new@example.com',
  name: null,
  roleIds: [ids.editor, ids.viewer],
  // Viewer ends a while after it is accepted; Editor never does.
  roleExpiresAt: { [ids.viewer]: '2026-12-31T00:00:00.000Z' },
  unitIds: [],
  invitedBy: 'ada@example.com',
  status: 'sent' as const,
  sentAt: '2026-10-17T00:00:00.000Z',
  expiresAt: '2026-10-20T00:00:00.000Z',
  createdAt: '2026-10-17T00:00:00.000Z',
};

export const everything = {
  'Access.manageRoles': true,
  'Access.manageUsers': true,
  'Access.manageOrganizationalUnits': true,
  'Note.read': true,
  'Note.create': true,
  'Note.update': true,
};

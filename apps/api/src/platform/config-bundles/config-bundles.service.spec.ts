import type { TransactionHost } from '@nestjs-cls/transactional';
import { z } from 'zod';
import type { AccessAdminService } from '../../iam/access/access-admin.service.js';
import type { PermissionCatalog } from '../../iam/access/permission-catalog.js';
import type { AuditService } from '../../iam/audit/audit.service.js';
import type { UserPrincipal } from '../../iam/auth/principal.js';
import type { SettingsService } from '../settings/settings.service.js';
import type { ConfigBundle } from './config-bundle.schemas.js';
import {
  canonicalJson,
  checksumOf,
  ConfigBundlesService,
} from './config-bundles.service.js';

const EDITORS = '11111111-1111-4111-8111-111111111111';
const declarations = [
  { key: 'notes.publishDelay', schema: z.string(), default: '10s' },
  {
    key: 'notes.richText',
    schema: z.boolean(),
    default: false,
    flag: true,
    scopes: ['tenant', 'unit', 'user'],
  },
];

/** A tenant with the Administrator role, an Editors role and two settings, held in memory. */
function setup() {
  const roles = [
    {
      id: 'admin',
      name: 'Administrator',
      description: '',
      system: true,
      permissions: [],
    },
    {
      id: EDITORS,
      name: 'Editors',
      description: 'Edit notes',
      system: false,
      permissions: [{ subject: 'Note', action: 'update', conditions: [] }],
    },
  ];
  const overrides = new Map<string, Record<string, unknown>[]>([
    [
      'notes.publishDelay',
      [{ scope: 'tenant', value: '5m', rollout: null, rules: [] }],
    ],
    [
      'notes.richText',
      [
        { scope: 'user', value: true, rollout: null, rules: [] },
        {
          scope: 'tenant',
          value: null,
          rollout: 20,
          rules: [
            {
              conditions: [{ key: 'role', params: { roleIds: [EDITORS] } }],
              outcome: { value: true },
            },
          ],
        },
      ],
    ],
  ]);
  const set = vi.fn();
  const createRole = vi.fn();
  const updateRole = vi.fn();
  const record = vi.fn();
  const service = new ConfigBundlesService(
    {} as TransactionHost<never>,
    {
      declarations: () => declarations,
      overrides: async (key: string) => overrides.get(key) ?? [],
      set,
    } as unknown as SettingsService,
    {
      listRoles: async () => roles,
      createRole,
      updateRole,
    } as unknown as AccessAdminService,
    {
      validate: (input: { subject: string }) =>
        input.subject === 'Note'
          ? { ok: true, value: input }
          : { ok: false, error: `Unknown subject ${input.subject}.` },
    } as unknown as PermissionCatalog,
    { record } as unknown as AuditService,
  );
  return { service, set, createRole, updateRole, record };
}

const resealed = (bundle: ConfigBundle): ConfigBundle => ({
  ...bundle,
  checksum: checksumOf(bundle.contents),
});

describe('ConfigBundlesService', () => {
  it('sorts keys, so the same contents give the same checksum', () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: null }] })).toBe(
      '{"a":[{"c":null,"d":2}],"b":1}',
    );
    expect(checksumOf({ a: 1, b: 2 })).toBe(checksumOf({ b: 2, a: 1 }));
  });

  it('exports tenant values and custom roles by name, never ids, users or the built-in role', async () => {
    const bundle = await setup().service.export();
    expect(bundle.checksum).toBe(checksumOf(bundle.contents));
    expect(bundle.contents.roles.map((role) => role.name)).toEqual(['Editors']);
    expect(bundle.contents.settings).toEqual([
      { key: 'notes.publishDelay', value: '5m', rollout: null, rules: [] },
      {
        key: 'notes.richText',
        value: null,
        rollout: 20,
        rules: [
          {
            conditions: [{ key: 'role', params: { roleNames: ['Editors'] } }],
            outcome: { value: true },
          },
        ],
      },
    ]);
    expect(JSON.stringify(bundle)).not.toContain(EDITORS);
  });

  it('previews its own export as unchanged', async () => {
    const { service } = setup();
    const preview = await service.preview(await service.export());
    expect(preview.valid).toBe(true);
    expect(
      preview.changes.every((change) => change.action === 'unchanged'),
    ).toBe(true);
  });

  it('refuses a damaged checksum, a newer format, an unknown setting, a bad value and a built-in role', async () => {
    const { service } = setup();
    const bundle = await service.export();
    expect(
      (
        await service.preview({
          ...bundle,
          checksum: `sha256:${'0'.repeat(64)}`,
        })
      ).errors[0].message,
    ).toContain('checksum');
    const changed = resealed({
      ...bundle,
      version: 99,
      contents: {
        settings: [
          { key: 'gone.feature', value: 1, rollout: null, rules: [] },
          { key: 'notes.publishDelay', value: 42, rollout: null, rules: [] },
        ],
        roles: [
          { name: 'Administrator', description: '', permissions: [] },
          {
            name: 'Auditors',
            description: '',
            permissions: [{ subject: 'Ghost', action: 'read', conditions: [] }],
          },
        ],
      },
    });
    const preview = await service.preview(changed);
    expect(preview.valid).toBe(false);
    expect(preview.errors.map((error) => error.ref)).toEqual([
      null,
      'Administrator',
      'Auditors',
      'gone.feature',
      'notes.publishDelay',
    ]);
  });

  it('refuses a flag rule naming a role neither side has', async () => {
    const { service } = setup();
    const preview = await service.preview(
      resealed({
        ...(await service.export()),
        contents: {
          roles: [],
          settings: [
            {
              key: 'notes.richText',
              value: true,
              rollout: null,
              rules: [
                {
                  conditions: [
                    { key: 'role', params: { roleNames: ['Nobody'] } },
                  ],
                  outcome: { value: true },
                },
              ],
            },
          ],
        },
      }),
    );
    expect(preview.errors[0]).toMatchObject({
      ref: 'notes.richText',
      message: expect.stringContaining('Nobody'),
    });
  });

  it('applies nothing when the target changed since the preview', async () => {
    const { service, set, createRole } = setup();
    // inTransaction(): the host runs the work at once.
    (service as unknown as { txHost: unknown }).txHost = {
      withTransaction: (work: () => Promise<unknown>) => work(),
      tx: {},
    };
    const bundle = await service.export();
    await expect(
      service.apply(
        { kind: 'user' } as UserPrincipal,
        bundle,
        `sha256:${'f'.repeat(64)}`,
      ),
    ).rejects.toMatchObject({ response: { code: 'config_changed' } });
    expect(set).not.toHaveBeenCalled();
    expect(createRole).not.toHaveBeenCalled();
  });
});

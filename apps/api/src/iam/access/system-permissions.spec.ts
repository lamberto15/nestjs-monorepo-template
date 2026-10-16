import { NOTE_PERMISSIONS } from '../../features/notes/note.policy.js';
import { PLATFORM_PERMISSIONS } from '../../platform/ops/ops.policy.js';
import { systemPrincipal } from '../auth/principal.js';
import { AccessService } from './access.service.js';
import { PermissionCatalog } from './permission-catalog.js';
import { ALL, definePermissions, defineSystemJob } from './permissions.js';

const catalog = new PermissionCatalog({
  permissions: [PLATFORM_PERMISSIONS, NOTE_PERMISSIONS],
});

/** Answers for the system principal come from the catalog: no database, no Redis. */
const access = new AccessService({} as never, catalog, {} as never, {
  permissions: [],
  resources: [],
});

const job = (
  permissions: Parameters<typeof defineSystemJob>[0]['permissions'],
) =>
  definePermissions({
    subjects: {},
    systemJobs: [
      defineSystemJob({
        key: 'test-job',
        label: 'Test',
        description: 'A test job.',
        permissions,
      }),
    ],
  });

describe('system jobs in the catalog', () => {
  it('lists every declared job, with what it may do', () => {
    expect([...catalog.systemJobs.keys()]).toEqual(
      expect.arrayContaining([
        'seed',
        'audit-retention',
        'soft-delete-purge',
        'account-deletion',
        'approvals',
        'note-publication',
      ]),
    );
    expect(catalog.systemJobsView()).toContainEqual({
      key: 'note-publication',
      actor: 'system:note-publication',
      label: 'Note publication',
      description: expect.any(String),
      permissions: [
        {
          subject: 'Note',
          action: 'update',
          conditions: [{ key: 'draft' }],
          fields: null,
        },
      ],
    });
    // Least privilege: the template's own jobs check no permission, so they declare none.
    for (const key of ['seed', 'account-deletion', 'approvals']) {
      expect(catalog.systemJob(key)!.permissions).toEqual([]);
    }
  });

  it('refuses all.manage: nothing implicit', () => {
    expect(() => new PermissionCatalog({ permissions: [job([ALL])] })).toThrow(
      'System job test-job declares all.manage',
    );
  });

  it('refuses a permission the catalog does not know, a key twice, a bad key', () => {
    expect(
      () =>
        new PermissionCatalog({
          permissions: [
            job([{ subject: 'Access', action: 'fly', conditions: [] }]),
          ],
        }),
    ).toThrow('System job test-job: Unknown action fly on Access.');
    expect(
      () => new PermissionCatalog({ permissions: [job([]), job([])] }),
    ).toThrow('System job test-job is declared twice.');
    const bad = definePermissions({
      subjects: {},
      systemJobs: [
        { key: 'Not A Key', label: 'x', description: 'x', permissions: [] },
      ],
    });
    expect(() => new PermissionCatalog({ permissions: [bad] })).toThrow(
      'a key is lowercase words',
    );
  });
});

describe('what the system principal may do', () => {
  const deletion = systemPrincipal(catalog.systemJob('account-deletion')!);
  const publication = systemPrincipal(catalog.systemJob('note-publication')!);
  const retention = systemPrincipal(catalog.systemJob('audit-retention')!);

  it('is what its job declares', async () => {
    expect(await access.can(publication, 'update', 'Note')).toBe(true);
    expect(await access.can(publication, 'delete', 'Note')).toBe(false);
    expect(await access.can(publication, 'manageUsers', 'Access')).toBe(false);
    expect(await access.can(deletion, 'manageUsers', 'Access')).toBe(false);
  });

  it('applies its conditions, read with the job as the principal', async () => {
    expect(
      await access.can(publication, 'update', 'Note', {
        ownerId: 'user:1',
        status: 'draft',
      }),
    ).toBe(true);
    expect(
      await access.can(publication, 'update', 'Note', {
        ownerId: 'user:1',
        status: 'published',
      }),
    ).toBe(false);
    expect(await access.sqlFilter(publication, 'Note', 'read')).toBeDefined();
  });

  it('is nothing for a job that declares nothing', async () => {
    expect(await access.permissions(retention)).toEqual([]);
    expect(await access.can(retention, 'readAudit', 'Access')).toBe(false);
  });

  it('is nothing for "system" read from data (a forged token, a queued job)', async () => {
    const forged = JSON.parse(JSON.stringify(publication));
    expect(await access.can(forged, 'update', 'Note')).toBe(false);
    expect(await access.permissions(forged)).toEqual([]);
  });
});

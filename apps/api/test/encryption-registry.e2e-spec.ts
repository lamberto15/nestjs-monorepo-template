import { eq } from 'drizzle-orm';
import { DataTransferRegistry } from '../src/platform/data-transfer/data-transfer.registry.js';
import { AuditService } from '../src/iam/audit/audit.service.js';
import { systemPrincipal } from '../src/iam/auth/principal.js';
import { auditLog } from '../src/iam/iam.tables.js';
import { defineResource } from '../src/iam/resources/resource.js';
import { RevisionsService } from '../src/platform/revisions/revisions.service.js';
import { revisions } from '../src/platform/revisions/revisions.tables.js';
import { loadMfaEncryptionKeys } from '../src/core/database/drizzle.js';
import { appSecrets } from '../src/schema.js';
import './fixtures/encrypted/encrypted-fixture.tables.js';
import { bootApp, type TestApp } from './support.js';

vi.hoisted(() => {
  const make = () =>
    Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');
  process.env.DATA_ENCRYPTION_KEYS = make();
  process.env.BLIND_INDEX_KEYS = make();
});

const SECRET = 'v1.abc123.iv.CIPHERTEXT-OF-A-TAX-NUMBER.tag';
const by = systemPrincipal({ key: 'system:test', label: 'Test' });

/**
 * Encrypted columns never reach a revision, an audit entry, an export or a
 * production database as a key (docs/encryption.md, "Where plaintext never goes").
 */
describe('the encrypted-column registry in revisions, audit and exports (e2e)', () => {
  let node: TestApp;
  beforeAll(async () => {
    node = await bootApp();
  });
  afterAll(async () => {
    await node.close();
  });

  it('keeps an encrypted property out of a revision snapshot and its changes', async () => {
    const revs = node.app.get(RevisionsService);
    const recordId = crypto.randomUUID();
    await node.inTenant(() =>
      node.db.transaction(async (tx) => {
        await revs.record(tx, 'Spec', recordId, {
          snapshot: { title: 'a', taxNumber: SECRET },
          by,
        });
        await revs.record(tx, 'Spec', recordId, {
          snapshot: { title: 'b', taxNumber: `${SECRET}-2` },
          by,
        });
      }),
    );
    const rows = await node.acrossTenants(() =>
      node.db.select().from(revisions).where(eq(revisions.recordId, recordId)),
    );
    expect(rows).toHaveLength(2);
    const stored = JSON.stringify(rows);
    expect(stored).not.toContain('taxNumber');
    expect(stored).not.toContain('CIPHERTEXT');
    expect(rows.find((r) => r.number === 2)?.changes).toEqual({
      title: { from: 'a', to: 'b' },
    });
  });

  it('redacts an encrypted property in the audit entry of a change', async () => {
    const audit = node.app.get(AuditService);
    const resource = defineResource({ subject: 'Spec', audit: {} });
    const id = crypto.randomUUID();
    await node.inTenant(async () => {
      await audit.recordChange(by, resource, {
        id,
        action: 'created',
        after: { title: 'a', taxNumber: SECRET },
      });
      await audit.recordChange(by, resource, {
        id,
        action: 'updated',
        before: { title: 'a', taxNumber: SECRET },
        after: { title: 'a', taxNumber: `${SECRET}-2` },
      });
    });
    const rows = await node.acrossTenants(() =>
      node.db.select().from(auditLog).where(eq(auditLog.targetId, id)),
    );
    expect(rows).toHaveLength(2);
    expect(JSON.stringify(rows)).not.toContain('CIPHERTEXT');
    const created = rows.find((r) => r.action === 'spec.created');
    expect(created?.details).toEqual({
      values: { title: 'a', taxNumber: '[redacted]' },
    });
  });

  it('refuses an exporter that would write an encrypted column as stored', () => {
    const registry = node.app.get(DataTransferRegistry);
    expect(() =>
      registry.registerExporter({
        name: 'spec-leaky',
        subject: 'Spec',
        columns: [{ key: 'taxNumber' }],
        // eslint-disable-next-line require-yield
        async *batches() {
          return;
        },
      }),
    ).toThrow(/encrypted column/);
    expect(registry.exporter('spec-leaky')).toBeUndefined();
  });

  it('never creates the two-factor key in the database in production', async () => {
    const saved = { ...process.env };
    try {
      delete process.env.MFA_ENCRYPTION_KEYS;
      process.env.NODE_ENV = 'production';
      await node.db
        .delete(appSecrets)
        .where(eq(appSecrets.name, 'MFA_ENCRYPTION_KEYS'));
      await expect(
        loadMfaEncryptionKeys(node.db, () => 'generated'),
      ).rejects.toThrow(/in production/);
      expect(
        await node.db
          .select()
          .from(appSecrets)
          .where(eq(appSecrets.name, 'MFA_ENCRYPTION_KEYS')),
      ).toHaveLength(0);
      // A deployment that already holds it there keeps working.
      await node.db
        .insert(appSecrets)
        .values({ name: 'MFA_ENCRYPTION_KEYS', value: 'legacy-key' });
      expect(await loadMfaEncryptionKeys(node.db, () => 'generated')).toBe(
        'legacy-key',
      );
      // Set in the environment, that wins.
      process.env.MFA_ENCRYPTION_KEYS = 'from-env';
      expect(await loadMfaEncryptionKeys(node.db, () => 'generated')).toBe(
        'from-env',
      );
    } finally {
      process.env = saved;
    }
  });
});

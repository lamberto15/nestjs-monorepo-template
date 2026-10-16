import { AsyncLocalStorage } from 'node:async_hooks';
import type { TransactionHost } from '@nestjs-cls/transactional';
import { ClsService } from 'nestjs-cls';
import type { DrizzleTransactions } from '../../core/database/transactions.js';
import { NOTE_PERMISSIONS } from '../../features/notes/note.policy.js';
import { ACCOUNT_DELETION_JOB } from '../../platform/platform.jobs.js';
import { PLATFORM_PERMISSIONS } from '../../platform/ops/ops.policy.js';
import { SEED_JOB } from '../iam.jobs.js';
import { isSystemPrincipal, principalKey } from '../auth/principal.js';
import { PermissionCatalog } from './permission-catalog.js';
import { SystemContext } from './system-context.js';

const catalog = new PermissionCatalog({
  permissions: [PLATFORM_PERMISSIONS, NOTE_PERMISSIONS],
});

/** A transaction host that records what ran in a transaction. */
function fakeTransactions() {
  const opened: string[] = [];
  let inside = false;
  const host = {
    get tx() {
      return inside ? 'the transaction' : 'the database';
    },
    async withTransaction<T>(work: () => Promise<T>) {
      opened.push('transaction');
      inside = true;
      try {
        return await work();
      } finally {
        inside = false;
      }
    },
  };
  return {
    host: host as unknown as TransactionHost<DrizzleTransactions>,
    opened,
  };
}

function context() {
  const cls = new ClsService(new AsyncLocalStorage());
  const transactions = fakeTransactions();
  return {
    system: new SystemContext(cls, transactions.host, catalog),
    cls,
    opened: transactions.opened,
  };
}

describe('SystemContext', () => {
  it('runs the work as the job, in a CLS context and one transaction', async () => {
    const { system, opened } = context();
    expect(system.current()).toBeUndefined();
    const seen = await system.run(SEED_JOB, async (principal, tx) => ({
      key: principalKey(principal),
      name: principal.name,
      current: system.current(),
      tx,
    }));
    expect(seen).toMatchObject({
      key: 'system:seed',
      name: 'System: First-boot seed',
      tx: 'the transaction',
    });
    expect(isSystemPrincipal(seen.current)).toBe(true);
    expect(opened).toEqual(['transaction']);
    // The context ends with the work.
    expect(system.current()).toBeUndefined();
  });

  it('opens no transaction with { transaction: false }', async () => {
    const { system, opened } = context();
    const key = await system.run(
      ACCOUNT_DELETION_JOB,
      async (principal) => principalKey(principal),
      { transaction: false },
    );
    expect(key).toBe('system:account-deletion');
    expect(opened).toEqual([]);
  });

  it('gives a nested run its own job and leaves the outer one as it was', async () => {
    const { system } = context();
    const keys = await system.run(
      ACCOUNT_DELETION_JOB,
      async () => {
        const inner = await system.run(
          'approvals',
          async () => principalKey(system.current()!),
          { transaction: false },
        );
        return [inner, principalKey(system.current()!)];
      },
      { transaction: false },
    );
    expect(keys).toEqual(['system:approvals', 'system:account-deletion']);
  });

  it('keeps the outer CLS values it inherits', async () => {
    const { system, cls } = context();
    await cls.run(async () => {
      cls.set('request', 'outer');
      await system.run(
        SEED_JOB,
        async () => expect(cls.get('request')).toBe('outer'),
        { transaction: false },
      );
      expect(system.current()).toBeUndefined();
    });
  });

  it('refuses a job no declaration lists', async () => {
    const { system } = context();
    expect(() => system.principal('not-declared')).toThrow(
      'System job "not-declared" isn\'t declared',
    );
    await expect(
      system.run('not-declared', async () => 'ran', { transaction: false }),
    ).rejects.toThrow("isn't declared");
  });
});

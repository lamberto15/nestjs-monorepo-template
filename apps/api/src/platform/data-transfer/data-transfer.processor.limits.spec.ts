import { Readable } from 'node:stream';
import { z } from 'zod';
import type { Principal } from '../../iam/auth/principal.js';
import type { TransferJob } from './data-transfer.types.js';
import { DataTransferProcessor } from './data-transfer.processor.js';

const tenantId = '00000000-0000-4000-8000-000000000001';
const principal = {
  kind: 'client',
  id: 'client-1',
  tenantId,
  name: 'client',
} as Principal;

function processor(input: string, importer: Record<string, unknown>) {
  const write = vi.fn(async () => undefined);
  const disk = {
    get: async () => ({ body: Readable.from([Buffer.from(input)]) }),
    delete: vi.fn(async () => undefined),
    put: async (_key: string, body: AsyncIterable<unknown>) => {
      for await (const _chunk of body) {
        // Drain generated error reports, as the private disk does.
      }
    },
  };
  const forbiddenFields = vi.fn(async (..._args: unknown[]) => []);
  const instance = Reflect.construct(DataTransferProcessor, [
    {
      importer: () => ({ name: 'notes', subject: 'Note', ...importer, write }),
    },
    { forbiddenFields },
    { record: async () => undefined },
    disk,
    { toPrincipal: () => undefined },
    {},
    {},
    {},
  ]) as DataTransferProcessor;
  const runImport = (
    limits: { maxBytes: number; maxRows: number },
    data: Partial<Extract<TransferJob, { kind: 'import' }>> = {},
  ) =>
    (
      instance as unknown as {
        import: (job: unknown, user: Principal) => Promise<unknown>;
      }
    ).import(
      {
        id: 'job-1',
        data: {
          kind: 'import',
          name: 'notes',
          tenantId,
          principal,
          format: 'csv',
          key: `tenants/${tenantId}/transfers/uploads/input.csv`,
          dryRun: false,
          ...data,
          limits,
        },
        updateProgress: async () => undefined,
      },
      principal,
    );
  return { runImport, write, disk, forbiddenFields };
}

const schema = z.object({ title: z.string() });

describe('DataTransferProcessor import limits', () => {
  it('rejects row overflow while reading, before the pending group is written', async () => {
    const { runImport, write } = processor('title\none\ntwo\n', { schema });

    await expect(runImport({ maxBytes: 1000, maxRows: 1 })).rejects.toThrow(
      'row limit',
    );
    expect(write).not.toHaveBeenCalled();
  });

  it('rejects byte overflow while reading, before any row is written', async () => {
    const { runImport, write, disk } = processor('title\none\n', { schema });

    await expect(runImport({ maxBytes: 4, maxRows: 10 })).rejects.toThrow(
      'byte limit',
    );
    expect(write).not.toHaveBeenCalled();
    expect(disk.delete).toHaveBeenCalled();
  });

  it('imports a file within both limits', async () => {
    const { runImport, write } = processor('title\none\ntwo\n', { schema });

    await expect(
      runImport({ maxBytes: 1000, maxRows: 2 }),
    ).resolves.toMatchObject({ rows: 2, imported: 2, failed: 0 });
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('tracks matched keys and refuses duplicate keys in the same file', async () => {
    const writeMany = vi.fn(async (..._args: unknown[]) => undefined);
    const { runImport } = processor('id,title\n1,first\n1,duplicate\n', {
      schema: z.object({ id: z.string(), title: z.string() }),
      matchKeys: ['id'],
      writeMany,
    });

    await expect(
      runImport({ maxBytes: 1000, maxRows: 10 }, { matchOn: 'id' }),
    ).resolves.toMatchObject({ rows: 2, imported: 1, failed: 1 });
    expect(writeMany).toHaveBeenCalledTimes(1);
    expect(writeMany.mock.calls[0]?.[0]).toEqual(principal);
  });
});

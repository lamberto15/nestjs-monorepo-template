import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    {
      get: () =>
        join(tmpdir(), 'data-transfer-import-tests', String(process.pid)),
    },
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
  it('does not write valid earlier rows if later CSV syntax is malformed', async () => {
    const { runImport, write, disk } = processor(
      'title\nvalid\n"unterminated',
      { schema },
    );

    await expect(runImport({ maxBytes: 1000, maxRows: 10 })).rejects.toThrow();
    expect(write).not.toHaveBeenCalled();
    expect(disk.delete).toHaveBeenCalled();
  });

  it('rejects row overflow before writing any rows', async () => {
    const { runImport, write } = processor('title\none\ntwo\n', { schema });

    await expect(runImport({ maxBytes: 1000, maxRows: 1 })).rejects.toThrow(
      'row limit',
    );
    expect(write).not.toHaveBeenCalled();
  });

  it('rejects byte overflow while staging, before reading or writing rows', async () => {
    const { runImport, write } = processor('title\none\n', { schema });

    await expect(runImport({ maxBytes: 4, maxRows: 10 })).rejects.toThrow(
      'byte limit',
    );
    expect(write).not.toHaveBeenCalled();
  });

  it('tracks matched keys on disk and refuses duplicate keys in the same file', async () => {
    const writeMany = vi.fn(async () => undefined);
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

  it('preserves normalized own undefined values through the private spool', async () => {
    const schema = {
      safeParse: (record: Record<string, unknown>) => ({
        success: true as const,
        data: record,
      }),
    };
    const { runImport, forbiddenFields } = processor('dueAt (UTC)\n""\n', {
      schema,
      templateColumns: async () => [
        { name: 'dueAt', type: 'datetime', required: false },
      ],
    });

    await expect(
      runImport({ maxBytes: 1000, maxRows: 10 }),
    ).resolves.toMatchObject({ rows: 1, imported: 1, failed: 0 });
    const setFields = forbiddenFields.mock.calls[0]?.[3] as Record<
      string,
      unknown
    >;
    expect(Object.hasOwn(setFields, 'dueAt')).toBe(true);
    expect(setFields.dueAt).toBeUndefined();
  });

  it('preserves nonfinite JSON numbers so row validation still refuses them', async () => {
    const schema = {
      safeParse: (record: Record<string, unknown>) =>
        record.value === Infinity
          ? {
              success: false as const,
              error: {
                issues: [{ path: ['value'], message: 'Must be finite.' }],
              },
            }
          : { success: true as const, data: record },
    };
    const { runImport, write } = processor('[{"value":1e400},{"value":2}]', {
      schema,
      templateColumns: async () => [],
    });

    await expect(
      runImport({ maxBytes: 1000, maxRows: 10 }, { format: 'json' }),
    ).resolves.toMatchObject({ rows: 2, imported: 1, failed: 1 });
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]?.[1]).toEqual({ value: 2 });
  });
});

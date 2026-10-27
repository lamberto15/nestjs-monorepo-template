import { BadRequestException, type Type } from '@nestjs/common';
import { field } from '../fields/field.js';
import type { Principal } from '../../iam/auth/principal.js';
import { defineRecord } from './record.js';
import { IncludePipe, withIncluded } from './record-can.js';
import { RecordPresenter } from './record-contract.js';
import { recordSchemas } from './record.schemas.js';

const declare = (capabilities: ('watch' | 'tags')[]) =>
  defineRecord({
    subject: 'Invoice',
    path: 'invoice-lines',
    apiTag: 'invoice-lines',
    className: 'InvoiceIncludeSpec',
    noun: 'invoice line',
    table: 'invoice_lines',
    softDelete: false,
    unit: false,
    fields: { title: field.string() },
    capabilities,
  });

/** `?include=watching` (record-can.ts, record-contract.ts). */
describe('?include=watching', () => {
  const user = { kind: 'user', id: 'u1' } as Principal;

  it('is read beside can, and another value is a 400', () => {
    const pipe = new IncludePipe();
    expect(pipe.transform(undefined)).toEqual({ can: false, watching: false });
    expect(pipe.transform('watching')).toEqual({ can: false, watching: true });
    expect(pipe.transform('can,watching')).toEqual({
      can: true,
      watching: true,
    });
    expect(pipe.transform(['can', 'watching'])).toEqual({
      can: true,
      watching: true,
    });
    expect(() => pipe.transform('watchers')).toThrow(BadRequestException);
  });

  it('adds watching to the response schema only with the watch capability', () => {
    expect(recordSchemas(declare(['watch'])).response.shape).toHaveProperty(
      'watching',
    );
    expect(recordSchemas(declare(['tags'])).response.shape).not.toHaveProperty(
      'watching',
    );
  });

  it('is a 400 on a record that cannot be watched, before any work', async () => {
    // No collaborator is reached: the include is refused first.
    const presenter = new RecordPresenter(
      declare(['tags']),
      class Policy {} as Type,
      null as never,
      null as never,
      null as never,
      null as never,
      null as never,
      null as never,
    );
    await expect(
      presenter.one(user, { id: 'a' }, { can: false, watching: true }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      presenter.page(
        user,
        { items: [{ id: 'a' }] },
        {
          list: null as never,
          query: null as never,
          include: { can: false, watching: true },
        },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('marks each record by the ids the reader watches', () => {
    const watching = new Set(['a']);
    expect(withIncluded({ id: 'a' }, { watching })).toEqual({
      id: 'a',
      watching: true,
    });
    expect(withIncluded({ id: 'b' }, { watching })).toEqual({
      id: 'b',
      watching: false,
    });
    const both = withIncluded(
      { id: 'a' },
      { watching, can: new Map([['a', { update: true }]]) },
    );
    expect(both).toEqual({ id: 'a', watching: true, can: { update: true } });
    // Neither asked for: the record as it is.
    const plain = { id: 'a' };
    expect(withIncluded(plain, {})).toBe(plain);
  });
});

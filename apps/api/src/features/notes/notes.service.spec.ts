import { sql, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { Principal } from '../../iam/auth/principal.js';
import { NotesService } from './notes.service.js';

const user = { kind: 'user', id: 'u1' } as Principal;

/** A NotesService whose note query finds `rows`, recording its `where`. */
function setup(rows: unknown[]) {
  const wheres: (SQL | undefined)[] = [];
  const db = {
    select: () => ({
      from: () => ({
        where: (condition: SQL | undefined) => {
          wheres.push(condition);
          return Promise.resolve(rows);
        },
      }),
    }),
  };
  const access = { sqlFilter: vi.fn(async () => sql`read_filter`) };
  const registers = { register: vi.fn(), count: vi.fn() };
  const notes = new NotesService(
    { tx: db } as never,
    {} as never, // workflows
    {} as never, // webhooks
    {} as never, // publisher
    {} as never, // custom fields
    access as never,
    {} as never, // audit
    {} as never, // units
    {} as never, // notifications
    {} as never, // subscriptions
    registers as never, // naming series
    {} as never, // tags
    {} as never, // revisions
    {} as never, // approvals
    {} as never, // tenancy
    {} as never, // holds
    {} as never, // system
    registers as never, // quotas
    registers as never, // incoming events
    registers as never, // retention
  );
  const render = (condition: SQL | undefined) =>
    new PgDialect().sqlToQuery(condition!).sql;
  return { notes, access, wheres, render };
}

/** A note the caller may not read is the 404 of a missing one (issue #772). */
describe('NotesService.findOne', () => {
  it('filters by the read permission in the query with visibleTo', async () => {
    const { notes, access, wheres, render } = setup([{ id: 'n1' }]);

    await expect(
      notes.findOne('n1', undefined, { visibleTo: user }),
    ).resolves.toEqual({ id: 'n1' });

    expect(access.sqlFilter).toHaveBeenCalledWith(user, 'Note', 'read', {
      deleted: false,
    });
    expect(render(wheres[0])).toContain('read_filter');
  });

  it('looks in the recycle bin with the restore permission', async () => {
    const { notes, access } = setup([{ id: 'n1' }]);

    await notes.findOne('n1', undefined, { deleted: true, visibleTo: user });

    expect(access.sqlFilter).toHaveBeenCalledWith(user, 'Note', 'restore', {
      deleted: true,
    });
  });

  it('answers an unreadable note with the 404 of a missing one', async () => {
    const { notes } = setup([]);

    await expect(
      notes.findOne('n1', undefined, { visibleTo: user }),
    ).rejects.toMatchObject({ status: 404, message: 'Note n1 not found.' });
  });

  it('applies no permission filter without visibleTo (system work)', async () => {
    const { notes, access, wheres, render } = setup([{ id: 'n1' }]);

    await notes.findOne('n1');

    expect(access.sqlFilter).not.toHaveBeenCalled();
    expect(render(wheres[0])).not.toContain('read_filter');
  });
});

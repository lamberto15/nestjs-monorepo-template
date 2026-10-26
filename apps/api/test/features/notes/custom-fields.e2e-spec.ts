import { bootApp, type TestApp } from '../../support.js';
import { writeNote } from './notes-support.js';
import { NotesService } from '../../../src/features/notes/notes.service.js';
import { revisions } from '../../../src/platform/revisions/revisions.tables.js';
import { and, desc, eq } from 'drizzle-orm';

/**
 * Notes' hand-written custom fields (note.resource.ts, NotesService,
 * NotesController, NoteTransfer, NoteRevisions): the wiring a feature that
 * writes its own does. The behaviour itself, on any record that takes the
 * capability, is tested on test items (test/custom-fields.e2e-spec.ts).
 */
describe('notes: custom fields (e2e)', () => {
  let node: TestApp;

  beforeEach(async () => {
    node = await bootApp();
  });
  afterEach(async () => {
    await node.close();
  });

  it('validates values on create and update, lists and audits them by key', async () => {
    await node
      .admin()
      .post('/v1/custom-fields')
      .send({
        subject: 'Note',
        key: 'region',
        label: 'Region',
        type: 'select',
        options: [
          { value: 'eu', label: 'Europe' },
          { value: 'us', label: 'Americas' },
        ],
        filterable: true,
        sortable: true,
      })
      .expect(201);
    const editor = await node.user(['editor']);

    const refused = await writeNote(node, editor.agent, {
      title: 'Bad',
      body: '',
      custom: { region: 'asia' },
    }).expect(400);
    expect(refused.body.errors[0].path).toBe('custom.region');

    const id = (
      await writeNote(node, editor.agent, {
        title: 'Plan',
        body: 'x',
        custom: { region: 'eu' },
      }).expect(201)
    ).body.id as string;
    await editor.agent
      .patch(`/v1/notes/${id}`)
      .send({ custom: { region: 'us' } })
      .expect(200);

    const listed = await editor.agent
      .get('/v1/notes?custom.region=us&sort=custom.region')
      .expect(200);
    expect(listed.body.items.map((n: { id: string }) => n.id)).toEqual([id]);
    expect(listed.body.items[0].custom).toEqual({ region: 'us' });

    const audit = await node.auditEntries({ targetId: id });
    expect(
      JSON.stringify(audit.find((e) => e.action === 'note.updated')),
    ).toContain('custom.region');
  });

  it('exports the custom columns after the notes own', async () => {
    await node
      .admin()
      .post('/v1/custom-fields')
      .send({ subject: 'Note', key: 'amount', label: 'Amount', type: 'number' })
      .expect(201);
    const catalog = await node.admin().get('/v1/data').expect(200);
    const notes = catalog.body.exports.find(
      (e: { name: string }) => e.name === 'notes',
    );
    expect(notes.columns.slice(0, 3)).toEqual(['id', 'number', 'title']);
    expect(notes.columns).toContain('custom.amount');
  });

  it('restores custom fields using the row locked after an intervening edit', async () => {
    await node
      .admin()
      .post('/v1/custom-fields')
      .send({
        subject: 'Note',
        key: 'region',
        label: 'Region',
        type: 'select',
        options: [
          { value: 'eu', label: 'Europe' },
          { value: 'us', label: 'Americas' },
        ],
      })
      .expect(201);
    const editor = await node.user(['editor']);
    const id = (
      await writeNote(node, editor.agent, {
        title: 'Plan',
        body: 'x',
        custom: { region: 'eu' },
      }).expect(201)
    ).body.id as string;
    await editor.agent
      .patch(`/v1/notes/${id}`)
      .send({ custom: { region: 'us' } })
      .expect(200);
    await editor.agent
      .patch(`/v1/notes/${id}`)
      .send({ custom: { region: 'eu' } })
      .expect(200);

    const service = node.app.get(NotesService);
    const originalUpdate = service.update.bind(service);
    let interposed = false;
    vi.spyOn(service, 'update').mockImplementation(async (...args) => {
      const [by, note, _dto, ip, options] = args;
      if (options?.restoredFrom === 1 && !interposed) {
        interposed = true;
        await originalUpdate(by, note, { custom: { region: 'us' } }, ip);
      }
      return originalUpdate(...args);
    });

    const restored = await editor.agent
      .post(`/v1/notes/${id}/revisions/1/restore`)
      .expect(200);
    expect(interposed).toBe(true);
    expect(restored.body.custom).toEqual({ region: 'eu' });
    const history = await node.inTenant(() =>
      node.db
        .select()
        .from(revisions)
        .where(and(eq(revisions.subject, 'Note'), eq(revisions.recordId, id)))
        .orderBy(desc(revisions.number)),
    );
    expect(history[0]).toMatchObject({
      restoredFrom: 1,
      snapshot: { custom: { region: 'eu' } },
    });
  });
});

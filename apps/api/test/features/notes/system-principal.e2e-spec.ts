import { writeNote } from './notes-support.js';
import { bootApp, type TestApp } from '../../support.js';

describe('the system principal: the notes workflow', () => {
  let node: TestApp;

  beforeEach(async () => {
    node = await bootApp();
  });

  afterEach(async () => {
    await node.close();
  });

  it("is a workflow step's audit actor: the publication of a note", async () => {
    const client = await node.client();
    const note = (await writeNote(node, client.auth).expect(201)).body;
    await node.worker.drain();
    node.clock.advance('10s');
    await node.worker.drain();
    const updated = await node
      .admin()
      .get(`/v1/access/audit?action=note.updated&targetId=${note.id}`)
      .expect(200);
    expect(updated.body.items[0]).toMatchObject({
      actor: 'system:note-publication',
      actorLabel: 'System: Note publication',
      details: { changes: { status: { from: 'draft', to: 'published' } } },
    });
  });

  it('lists the note publication job in the catalog with what it may do', async () => {
    const catalog = await node.admin().get('/v1/access/catalog').expect(200);
    const jobs = catalog.body.systemJobs as {
      key: string;
      actor: string;
      permissions: { subject: string; action: string }[];
    }[];
    expect(jobs.map((job) => job.key)).toContain('note-publication');
    expect(jobs.find((job) => job.key === 'note-publication')).toMatchObject({
      actor: 'system:note-publication',
      permissions: [{ subject: 'Note', action: 'update' }],
    });
  });
});

import { randomUUID } from 'node:crypto';
import { bootApp, type TestApp } from '../../support.js';
import { writeNote } from './notes-support.js';

const local = (url: string) => {
  const parsed = new URL(url, 'http://files.test');
  return parsed.pathname + parsed.search;
};

describe('notes matched imports (e2e)', () => {
  let node: TestApp;

  beforeEach(async () => {
    node = await bootApp();
  });
  afterEach(async () => {
    await node.close();
  });

  async function finished(auth: string, id: string) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const result = await node
        .http()
        .get(`/v1/data/transfers/${id}`)
        .set('Authorization', auth)
        .expect(200);
      if (result.body.status === 'completed' || result.body.status === 'failed')
        return result.body;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('The transfer did not finish.');
  }

  const upload = (auth: string, text: string, matchOn = 'id') =>
    node
      .http()
      .post('/v1/data/imports')
      .set('Authorization', auth)
      .field('name', 'notes')
      .field('matchOn', matchOn)
      .attach('file', Buffer.from(text), {
        filename: 'notes.csv',
        contentType: 'text/csv',
      });

  it('updates a chosen key and refuses repeated and unmatched keys without inserting', async () => {
    const client = await node.client();
    const existing = (
      await writeNote(node, client.auth, {
        title: 'Original',
        body: 'kept',
      }).expect(201)
    ).body;
    await node
      .http()
      .post('/v1/data/imports')
      .set('Authorization', client.auth)
      .field('name', 'notes')
      .field('matchOn', 'externalId')
      .attach('file', Buffer.from('externalId,title\nx,Nope\n'), 'notes.csv')
      .expect(400);

    const unmatchedId = randomUUID();
    const done = await finished(
      client.auth,
      (
        await upload(
          client.auth,
          `id,title\n${existing.id},Updated\n${existing.id},Repeated\n${unmatchedId},Missing\n`,
        ).expect(202)
      ).body.id,
    );
    expect(done).toMatchObject({
      status: 'completed',
      result: { rows: 3, imported: 1, failed: 2 },
    });
    const report = await node
      .http()
      .get(local(done.result.errorsUrl))
      .expect(200);
    expect(report.text).toContain('3,,No note with this id.');
    expect(report.text).toContain('2,id,The id is repeated in this file.');
    const note = await node
      .http()
      .get(`/v1/notes/${existing.id}`)
      .set('Authorization', client.auth)
      .expect(200);
    expect(note.body).toMatchObject({ title: 'Updated', body: 'kept' });
  });

  it('refuses a selected key missing from the file before writing rows', async () => {
    const client = await node.client();
    const note = (
      await writeNote(node, client.auth, {
        title: 'Still original',
        body: 'text',
      }).expect(201)
    ).body;
    const done = await finished(
      client.auth,
      (await upload(client.auth, 'title,body\nChanged,text\n').expect(202)).body
        .id,
    );
    expect(done.status).toBe('failed');
    const unchanged = await node
      .http()
      .get(`/v1/notes/${note.id}`)
      .set('Authorization', client.auth)
      .expect(200);
    expect(unchanged.body.title).toBe('Still original');
  });

  it('never matches another tenant’s id', async () => {
    const local = await node.client();
    const foreignTenant = await node.otherTenant();
    const foreign = await foreignTenant.client();
    const note = (
      await writeNote(node, foreign.auth, {
        title: 'Foreign',
        body: 'private',
      }).expect(201)
    ).body;
    const done = await finished(
      local.auth,
      (
        await upload(local.auth, `id,title\n${note.id},Cross tenant\n`).expect(
          202,
        )
      ).body.id,
    );
    expect(done.result).toMatchObject({ rows: 1, imported: 0, failed: 1 });
    const unchanged = await foreignTenant.admin
      .get(`/v1/notes/${note.id}`)
      .expect(200);
    expect(unchanged.body.title).toBe('Foreign');
  });
});

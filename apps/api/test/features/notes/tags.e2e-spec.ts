import { writeNote } from './notes-support.js';
import { bootApp, type TestApp } from '../../support.js';

/** The path and query of a signed URL: the tests reach the app on its own port. */
const local = (url: string) => {
  const { pathname, search } = new URL(url);
  return pathname + search;
};

describe('tags on notes (e2e)', () => {
  let node: TestApp;

  beforeEach(async () => {
    node = await bootApp();
  });
  afterEach(async () => {
    await node.close();
  });

  /** A Note tag, made by the administrator. */
  async function tag(name: string, color?: string) {
    const created = await node
      .admin()
      .post('/v1/tags')
      .send({ subject: 'Note', name, ...(color && { color }) })
      .expect(201);
    return created.body as { id: string; name: string; color: string | null };
  }

  it('exports the tags of each note', async () => {
    const client = await node.client();
    const urgent = await tag('Urgent');
    const later = await tag('Later');
    const id = (
      await writeNote(node, client.auth, { title: 'Tagged', body: '' })
    ).body.id as string;
    // A client lists the tags it may use, sorted by name whatever the case.
    await tag('alpha');
    const listed = await node
      .http()
      .get('/v1/tags?subject=Note&sort=name')
      .set('Authorization', client.auth)
      .expect(200);
    expect(
      listed.body.items.map((item: { name: string }) => item.name),
    ).toEqual(['alpha', 'Later', 'Urgent']);
    // The cursor pages on that order too, both ways.
    const names = async (path: string) => {
      const page = await node
        .http()
        .get(path)
        .set('Authorization', client.auth)
        .expect(200);
      return {
        names: page.body.items.map((item: { name: string }) => item.name),
        next: page.body.nextCursor as string | null,
      };
    };
    const up = await names('/v1/tags?subject=Note&sort=name&limit=1');
    expect(up.names).toEqual(['alpha']);
    expect(
      (await names(`/v1/tags?subject=Note&sort=name&limit=1&cursor=${up.next}`))
        .names,
    ).toEqual(['Later']);
    const down = await names('/v1/tags?subject=Note&sort=-name&limit=1');
    expect(down.names).toEqual(['Urgent']);
    expect(
      (
        await names(
          `/v1/tags?subject=Note&sort=-name&limit=1&cursor=${down.next}`,
        )
      ).names,
    ).toEqual(['Later']);
    await node
      .http()
      .put(`/v1/notes/${id}/tags`)
      .set('Authorization', client.auth)
      .send({ tagIds: [urgent.id, later.id] })
      .expect(200);

    const started = await node
      .http()
      .post('/v1/data/exports')
      .set('Authorization', client.auth)
      .send({ name: 'notes', format: 'csv' })
      .expect(202);
    let done: { status: string; result: { url: string } } | undefined;
    for (let tries = 0; tries < 100 && done?.status !== 'completed'; tries++) {
      done = (
        await node
          .http()
          .get(`/v1/data/transfers/${started.body.id}`)
          .set('Authorization', client.auth)
          .expect(200)
      ).body;
      expect(done!.status).not.toBe('failed');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(done?.status).toBe('completed');
    const file = await node.http().get(local(done!.result.url)).expect(200);
    const [header, row] = file.text.trim().split(/\r?\n/);
    expect(header).toContain('tags');
    expect(row).toContain('"Later, Urgent"');
  });
});

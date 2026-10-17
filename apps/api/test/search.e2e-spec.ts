import { bootApp, type TestApp } from './support.js';

describe('full-text search (e2e)', () => {
  let node: TestApp;

  beforeEach(async () => {
    node = await bootApp();
  });
  afterEach(async () => {
    await node.close();
  });

  it('filters a list by ?q= with web search syntax, ranks matches, and searches across kinds', async () => {
    // An editor: may read the text of their notes (an API client may not, by default).
    const editor = await node.user(['editor']);
    const write = (title: string, body: string) =>
      node.writeItem(editor.agent, { title, body }).expect(201);
    const dark = (
      await write('Dark mode', 'A dark theme for the dark hours of the night.')
    ).body;
    const legacy = (
      await write(
        'Legacy dark theme',
        'The old dark theme, kept for legacy screens.',
      )
    ).body;
    const light = (await write('Light mode', 'Bright and plain.')).body;
    const ids = (items: { id: string }[]) =>
      items.map((item) => item.id).toSorted((a, b) => a.localeCompare(b));
    const list = (query: string) =>
      editor.agent.get(`/v1/test-items?${query}`).expect(200);

    // Words anywhere; a phrase; an exclusion; "or".
    expect(ids((await list('q=dark')).body.items)).toEqual(ids([dark, legacy]));
    expect(ids((await list('q=%22dark%20hours%22')).body.items)).toEqual([
      dark.id,
    ]);
    expect(ids((await list('q=dark%20-legacy')).body.items)).toEqual([dark.id]);
    expect(ids((await list('q=bright%20or%20legacy')).body.items)).toEqual(
      ids([legacy, light]),
    );
    expect((await list('q=nothing-like-this')).body.items).toEqual([]);

    // The best match first: "dark" three times beats twice.
    const ranked = await list('q=dark&sort=-rank');
    expect(ranked.body.items.map((n: { id: string }) => n.id)).toEqual([
      dark.id,
      legacy.id,
    ]);
    // The rank is not in the items; the cursor pages through a ranked list.
    expect(ranked.body.items[0]).not.toHaveProperty('rank');
    const first = await list('q=dark&sort=-rank&limit=1');
    expect(first.body.items.map((n: { id: string }) => n.id)).toEqual([
      dark.id,
    ]);
    expect(first.body.nextCursor).toBeTruthy();
    const second = await list(
      `q=dark&sort=-rank&limit=1&cursor=${encodeURIComponent(first.body.nextCursor)}`,
    );
    expect(second.body.items.map((n: { id: string }) => n.id)).toEqual([
      legacy.id,
    ]);
    expect(second.body.nextCursor).toBeNull();

    // Across kinds, with snippets of the text; only what the caller may read.
    const found = await editor.agent
      .get('/v1/search?q=dark%20theme')
      .expect(200);
    expect(ids(found.body.items)).toEqual(ids([dark, legacy]));
    const hit = found.body.items.find((h: { id: string }) => h.id === dark.id);
    expect(hit).toMatchObject({
      subject: 'TestItem',
      title: 'Dark mode',
      link: `/test-items/${dark.id}`,
    });
    expect(hit.snippet).toContain('<b>dark</b> <b>theme</b>');
    expect(found.body.items[0].score).toBeGreaterThanOrEqual(
      found.body.items[1].score,
    );
    const other = await node.user(['editor']);
    expect(
      (await other.agent.get('/v1/search?q=dark').expect(200)).body.items,
    ).toEqual([]);
    expect(
      (await editor.agent.get('/v1/search?q=dark&subject=Nope').expect(200))
        .body.items,
    ).toEqual([]);
    await editor.agent.get('/v1/search').expect(400);

    // A user who may read test items but not their text gets no snippet of it.
    const titlesOnly = await node
      .admin()
      .post('/v1/access/roles')
      .send({
        name: 'Search titles',
        permissions: [
          { subject: 'TestItem', action: 'read', conditions: [], fields: [] },
        ],
      })
      .expect(201);
    const reader = await node.user([titlesOnly.body.id]);
    const blind = await reader.agent.get('/v1/search?q=night').expect(200);
    expect(blind.body.items.map((h: { id: string }) => h.id)).toEqual([
      dark.id,
    ]);
    expect(blind.body.items[0].snippet).toBeNull();
    const titled = await reader.agent.get('/v1/search?q=legacy').expect(200);
    expect(titled.body.items[0].snippet).toBe('<b>Legacy</b> dark theme');
  });
});

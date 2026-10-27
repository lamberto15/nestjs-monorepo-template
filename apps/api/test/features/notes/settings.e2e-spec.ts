import { randomUUID } from 'node:crypto';
import { bootApp, type TestApp } from '../../support.js';
import { writeNote } from './notes-support.js';

/**
 * What is notes' own about settings: its keys and what the publication
 * workflow does with the delay. How settings, flags, scopes and rollouts
 * work is tested on the test-only record's keys: test/settings.e2e-spec.ts.
 */
describe('settings of notes (e2e)', () => {
  let node: TestApp;

  beforeEach(async () => {
    node = await bootApp();
  });
  afterEach(async () => {
    await node.close();
  });

  /** A role of these permissions (no conditions), by id. */
  async function role(...permissions: [string, string][]) {
    const created = await node
      .admin()
      .post('/v1/access/roles')
      .send({
        name: `role-${randomUUID().slice(0, 8)}`,
        permissions: permissions.map(([subject, action]) => ({
          subject,
          action,
          conditions: [],
        })),
      })
      .expect(201);
    return created.body.id as string;
  }
  const settingOf = (body: { items: { key: string }[] }, key: string) =>
    body.items.find((item) => item.key === key);

  it('declares its settings and flags; the publication delay it sets is the workflow’s', async () => {
    const manager = await node.user([await role(['Access', 'manageSettings'])]);
    const editor = await node.user(['editor']);

    const list = await editor.agent.get('/v1/settings').expect(200);
    expect(
      list.body.items
        .map((i: { key: string }) => i.key)
        .filter((key: string) => key.startsWith('notes.')),
    ).toEqual([
      'notes.publishDelay',
      'notes.richText',
      'notes.publishApproval',
    ]);
    expect(settingOf(list.body, 'notes.publishDelay')).toMatchObject({
      label: 'Publication delay',
      value: '10s',
      source: 'default',
      default: '10s',
      scopes: ['tenant'],
      flag: false,
      public: true,
    });
    expect(settingOf(list.body, 'notes.richText')).toMatchObject({
      value: false,
      source: 'default',
      scopes: ['tenant', 'unit', 'user'],
      flag: true,
    });

    // What is sent is checked against the declared schema.
    const bad = await manager.agent
      .put('/v1/settings/notes.publishDelay')
      .send({ value: 'soon' })
      .expect(400);
    expect(bad.body.errors.map((e: { path: string }) => e.path)).toEqual([
      'value',
    ]);

    await manager.agent
      .put('/v1/settings/notes.publishDelay')
      .send({ value: '2m' })
      .expect(200);

    // The workflow reads it: a note written now waits two minutes, not ten seconds.
    const note = (
      await writeNote(node, editor.agent, { title: 'Slow', body: '' }).expect(
        201,
      )
    ).body as { id: string };
    await node.worker.drain();
    node.clock.advance('10s');
    await node.worker.drain();
    expect(
      (await editor.agent.get(`/v1/notes/${note.id}`).expect(200)).body.status,
    ).toBe('draft');
    node.clock.advance('2m');
    await node.worker.drain();
    expect(
      (await editor.agent.get(`/v1/notes/${note.id}`).expect(200)).body.status,
    ).toBe('published');
  });
});

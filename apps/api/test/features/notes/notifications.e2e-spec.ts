import { OutboxRelay } from '@nestjs/outbox';
import type request from 'supertest';
import { bootApp, type TestApp } from '../../support.js';
import { writeNote } from './notes-support.js';

describe('notifications of notes (e2e)', () => {
  let node: TestApp;

  beforeEach(async () => {
    node = await bootApp();
  });
  afterEach(async () => {
    await node.close();
  });

  /** Hands committed outbox messages to the delivery handler (the worker's job). */
  const deliver = () => node.app.get(OutboxRelay).runOnce();
  /** The `errors` paths of a problem response. */
  const paths = (body: { errors?: { path: string }[] }) =>
    (body.errors ?? []).map((error) => error.path);

  /** Writes a note and lets its publication workflow publish it. */
  async function publish(auth: string | request.Agent) {
    const note = (
      await writeNote(node, auth, { title: 'Hello', body: '' }).expect(201)
    ).body as { id: string };
    await node.worker.drain();
    node.clock.advance('10s');
    await node.worker.drain();
    return note;
  }

  /** A user's address, for the mailbox. */
  const emailOf = async (agent: request.Agent) =>
    (await agent.get('/v1/auth/me').expect(200)).body.user.email as string;

  /** The mail a user got but their invitation: what notifications sent them. */
  const noticesTo = (email: string) =>
    node.mailbox
      .filter({ to: email })
      .filter((mail) => !/invited you to/.test(mail.message.subject));

  it('tells a user in-app, in their language, and by mail; they read and mark it', async () => {
    const editor = await node.user(['editor']);
    await editor.agent
      .patch('/v1/auth/me')
      .send({ locale: 'de', timezone: 'Europe/Berlin' })
      .expect(200);
    const email = await emailOf(editor.agent);
    const note = await publish(editor.agent);
    await deliver();

    const page = await editor.agent.get('/v1/notifications').expect(200);
    expect(page.body.items).toHaveLength(1);
    const item = page.body.items[0];
    expect(item).toMatchObject({
      type: 'note.published',
      title: 'Notiz veröffentlicht',
      body: '„Hello“ ist jetzt veröffentlicht.',
      data: { noteId: note.id, title: 'Hello' },
      link: `/notes/${note.id}`,
      key: null,
      count: 1,
      read: false,
      readAt: null,
    });
    // The texts follow the request's language, not the stored one.
    const english = await editor.agent
      .get('/v1/notifications?lang=en')
      .expect(200);
    expect(english.body.items[0].title).toBe('Note published');
    expect(english.body.items[0].body).toBe('"Hello" is now published.');
    expect(
      (await editor.agent.get('/v1/notifications/unread-count').expect(200))
        .body,
    ).toEqual({ unread: 1 });

    // The mail, in German, with the link into the web app.
    const mail = await node.waitForMail({
      to: email,
      subject: /Notiz veröffentlicht/,
    });
    expect(mail.html).toContain('„Hello“ ist jetzt veröffentlicht.');
    expect(mail.html).toContain(`https://web.example.com/notes/${note.id}`);
  });

  it('lets a user opt out of the mail of a published note, not of a deleted one', async () => {
    const editor = await node.user(['editor']);
    const email = await emailOf(editor.agent);
    const changed = await editor.agent
      .put('/v1/notifications/preferences')
      .send({ 'note.published': { email: false } })
      .expect(200);
    expect(changed.body.types['note.published']).toEqual({ email: false });

    await publish(editor.agent);
    await deliver();
    expect(
      (await editor.agent.get('/v1/notifications').expect(200)).body.items,
    ).toHaveLength(1);
    expect(noticesTo(email)).toEqual([]);

    // Invalid settings, each named.
    const invalid = async (body: object, path: string) => {
      const response = await editor.agent
        .put('/v1/notifications/preferences')
        .send(body)
        .expect(400);
      expect(response.body.code).toBe('validation_failed');
      expect(paths(response.body)).toEqual([path]);
    };
    await invalid({ 'note.deleted': { email: false } }, 'note.deleted.email');
    await invalid({ 'note.nope': { email: false } }, 'note.nope');
    await invalid({ 'note.published': { sms: true } }, 'note.published.sms');
    await invalid(
      { 'note.published': { email: 'often' } },
      'note.published.email',
    );
    // A mandatory type may change its frequency.
    await editor.agent
      .put('/v1/notifications/preferences')
      .send({ 'note.deleted': { email: 'daily' } })
      .expect(200);
    const types = await editor.agent.get('/v1/notifications/types').expect(200);
    expect(
      types.body.items.find((t: { type: string }) => t.type === 'note.deleted'),
    ).toEqual({
      type: 'note.deleted',
      label: 'Note deleted by someone else',
      mandatory: true,
      channels: { email: 'immediate' },
    });
  });

  it('sends a mandatory notification when someone else deletes a note', async () => {
    const editor = await node.user(['editor']);
    const email = await emailOf(editor.agent);
    const note = (
      await writeNote(node, editor.agent, { title: 'Mine', body: '' }).expect(
        201,
      )
    ).body as { id: string };
    await node.admin().delete(`/v1/notes/${note.id}`).expect(204);
    await deliver();
    const list = await editor.agent.get('/v1/notifications').expect(200);
    expect(list.body.items[0]).toMatchObject({
      type: 'note.deleted',
      title: 'Note deleted',
      body: '"Mine" was deleted by Administrator.',
    });
    await node.waitForMail({ to: email, subject: /Note deleted/ });
  });
});

import { OutboxRelay } from '@nestjs/outbox';
import type request from 'supertest';
import { NotePublisher } from '../../../src/features/notes/note-publisher.service.js';
import type { Principal } from '../../../src/iam/auth/principal.js';
import { NotesService } from '../../../src/features/notes/notes.service.js';
import { PeopleService } from '../../../src/platform/people/people.service.js';
import { BULK_THRESHOLD } from '../../../src/platform/notifications/notification-catalog.js';
import { NotificationDigestJob } from '../../../src/platform/notifications/notification-digest.job.js';
import { recordSubscriptions } from '../../../src/platform/subscriptions/subscriptions.tables.js';
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
    ).toEqual({ unread: 1, unreadCapped: false });

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
      urgent: false,
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

  /** Creates `count` drafts of `ownerId`'s as an import group does, and lets its workflow publish them at once. */
  async function publishGroup(ownerId: string, count: number) {
    const created = await node.inTenant(async () => {
      const owner = await node.app
        .get(PeopleService)
        .principal(`user:${ownerId}`);
      return node.app.get(NotesService).createMany(
        owner!,
        Array.from({ length: count }, (_, index) => ({
          title: `Bulk ${index}`,
          body: '',
        })),
      );
    });
    await node.worker.drain();
    node.clock.advance('10s');
    await node.worker.drain();
    await deliver();
    return created;
  }

  /** A user's notifications of published notes. */
  const published = async (agent: request.Agent) =>
    (await agent.get('/v1/notifications?type=note.published').expect(200)).body
      .items as { title: string; body: string; count: number; link: string }[];

  it('sums a bulk publication up: one notification and one digest mail per watcher, of what they may read (#618)', async () => {
    const owner = await node.user(['editor']);
    const viewer = await node.user(['viewer']);
    const outsider = await node.user(['editor']);
    const [ownerEmail, viewerEmail, outsiderEmail] = await Promise.all(
      [owner, viewer, outsider].map((user) => emailOf(user.agent)),
    );
    const count = BULK_THRESHOLD + 1;
    const created = await node.inTenant(async () => {
      const principal = await node.app
        .get(PeopleService)
        .principal(`user:${owner.id}`);
      return node.app.get(NotesService).createMany(
        principal!,
        Array.from({ length: count }, (_, index) => ({
          title: `Bulk ${index}`,
          body: '',
        })),
      );
    });
    // The viewer may read every note and watches them; the outsider (an
    // editor: their own notes only) still has subscriptions from before.
    for (const note of created) {
      await viewer.agent.post(`/v1/notes/${note.id}/watch`).expect(200);
    }
    await node.db.insert(recordSubscriptions).values(
      created.map((note) => ({
        tenantId: node.tenantId,
        subject: 'Note',
        recordId: note.id,
        subscriber: `user:${outsider.id}`,
      })),
    );
    await node.worker.drain();
    node.clock.advance('10s');
    await node.worker.drain();
    await deliver();

    for (const user of [owner, viewer]) {
      expect(await published(user.agent)).toEqual([
        expect.objectContaining({
          title: 'Notes published',
          // The first three titles, in the order the publication returned them.
          body: expect.stringMatching(
            new RegExp(
              `^${count} notes were published, among them Bulk \\d+, Bulk \\d+, Bulk \\d+\\.$`,
            ),
          ),
          count,
          link: '/notes?status=published&sort=publishedAt.desc',
        }),
      ]);
    }
    expect(await published(outsider.agent)).toEqual([]);
    // Not mailed at once, though `note.published` mails at once by default:
    // in the next hourly digest, one mail each.
    expect(noticesTo(ownerEmail)).toEqual([]);
    expect(await node.app.get(NotificationDigestJob).run()).toEqual({
      mails: 2,
      items: 2,
    });
    for (const email of [ownerEmail, viewerEmail]) {
      const mail = await node.waitForMail({
        to: email,
        subject: /1 new notification in/,
      });
      expect(mail.html).toContain(`${count} notes were published`);
    }
    expect(noticesTo(ownerEmail)).toHaveLength(1);
    expect(noticesTo(outsiderEmail)).toEqual([]);

    // The step retried after its commit publishes nothing more: no second summary.
    expect(
      await node.inTenant(() =>
        node.app.get(NotePublisher).publishMany(
          created.map((note) => note.id),
          { kind: 'system', id: 'note-publication' } as Principal,
        ),
      ),
    ).toBe(0);
    await deliver();
    expect(await published(owner.agent)).toHaveLength(1);
  });

  it('keeps one notification per note up to the threshold, and respects an opt-out above it', async () => {
    const owner = await node.user(['editor']);
    const email = await emailOf(owner.agent);
    await publishGroup(owner.id, 2);
    expect(await published(owner.agent)).toHaveLength(2);
    await node.waitForMail({ to: email, subject: /Note published/ });

    await owner.agent
      .put('/v1/notifications/preferences')
      .send({ 'note.published': { email: false } })
      .expect(200);
    await publishGroup(owner.id, BULK_THRESHOLD + 1);
    const items = await published(owner.agent);
    expect(items).toHaveLength(3);
    expect(items[0]!.count).toBe(BULK_THRESHOLD + 1);
    expect(await node.app.get(NotificationDigestJob).run()).toEqual({
      mails: 0,
      items: 0,
    });
  });
});

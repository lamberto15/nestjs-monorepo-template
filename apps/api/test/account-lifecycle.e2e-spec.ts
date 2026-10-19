import { and, eq } from 'drizzle-orm';
import { users as usersTable } from '../src/iam/iam.tables.js';
import { randomUUID } from 'node:crypto';
import { getDrizzleToken } from '@nestjs/drizzle';
import type { Database } from '../src/core/database/drizzle.js';
import { AccountDeletionJob } from '../src/platform/account/account-deletion.job.js';
import {
  accountDeletions,
  consents as consentsTable,
} from '../src/platform/account/account.tables.js';
import { bootApp, type TestApp } from './support.js';

/** The path and query of a signed URL: the tests reach the app on its own port. */
const local = (url: string) => {
  const { pathname, search } = new URL(url);
  return pathname + search;
};

describe('account lifecycle: data export, deletion, consents (e2e)', () => {
  let node: TestApp;

  beforeEach(async () => {
    node = await bootApp();
  });
  afterEach(async () => {
    await node.close();
  });

  /** An editor whose password the test knows (invited, then accepted), signed in. */
  async function person() {
    const email = `${randomUUID().slice(0, 8)}@example.com`;
    const token = await node.invite(node.admin(), {
      email,
      name: 'Ada',
      roleIds: await node.roleIds('editor'),
    });
    const password = await node.acceptAsNew(token, 'Ada');
    const agent = await node.signIn(email, password);
    const me = await agent.get('/v1/auth/me').expect(200);
    return { id: me.body.user.id as string, email, password, agent };
  }
  const paths = (body: { errors?: { path: string }[] }) =>
    (body.errors ?? []).map((error) => error.path);

  it('records consents, and exports everything held about the person', async () => {
    const ada = await person();
    const other = await person();
    const terms = await ada.agent
      .post('/v1/account/consents')
      .send({ kind: 'terms', version: '2026-01' })
      .expect(201);
    expect(terms.body).toMatchObject({ kind: 'terms', version: '2026-01' });
    await ada.agent
      .post('/v1/account/consents')
      .send({ kind: 'Terms!', version: '1' })
      .expect(400);
    const again = await ada.agent
      .post('/v1/account/consents')
      .send({ kind: 'terms', version: '2026-01' })
      .expect(201);
    expect(again.body.acceptedAt >= terms.body.acceptedAt).toBe(true);
    await ada.agent
      .post('/v1/account/consents')
      .send({ kind: 'privacy', version: '2026-01' })
      .expect(201);
    const state = await ada.agent.get('/v1/account').expect(200);
    expect(state.body.deletion).toBeNull();
    expect(
      state.body.consents.map((c: { kind: string }) => c.kind).sort(),
    ).toEqual(['privacy', 'terms']);

    const mine = (
      await node
        .writeItem(ada.agent, { title: 'My note', body: 'x' })
        .expect(201)
    ).body;
    await node
      .writeItem(other.agent, { title: 'Not mine', body: 'y' })
      .expect(201);

    // Only users have one; it is listed for them.
    const catalog = await ada.agent.get('/v1/data').expect(200);
    expect(catalog.body.exports.map((e: { name: string }) => e.name)).toContain(
      'account',
    );
    const client = await node.client();
    const forClients = await node
      .http()
      .get('/v1/data')
      .set('Authorization', client.auth)
      .expect(200);
    expect(
      forClients.body.exports.map((e: { name: string }) => e.name),
    ).not.toContain('account');
    await node
      .http()
      .post('/v1/account/export')
      .set('Authorization', client.auth)
      .send({})
      .expect(401);

    const started = await ada.agent
      .post('/v1/account/export')
      .send({})
      .expect(202);
    let status;
    for (let tries = 0; tries < 100; tries++) {
      status = (
        await ada.agent.get(`/v1/data/transfers/${started.body.id}`).expect(200)
      ).body;
      if (['completed', 'failed'].includes(status.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(status.status).toBe('completed');
    const file = (await node.http().get(local(status.result.url)).expect(200))
      .body as {
      kind: string;
      id: string | null;
      data: Record<string, unknown>;
    }[];
    const kinds = new Set(file.map((row) => row.kind));
    expect([...kinds].sort()).toEqual([
      'auditEntry',
      'consent',
      'membership',
      'profile',
      'role',
      'session',
      'subscription',
      'test-items',
    ]);
    const profile = file.find((row) => row.kind === 'profile')!;
    expect(profile.data.email).toBe(ada.email);
    expect(profile.data).not.toHaveProperty('passwordHash');
    expect(
      file
        .filter((row) => row.kind === 'test-items')
        .map((row) => row.data.title),
    ).toEqual(['My note']);
    expect(file.find((row) => row.kind === 'test-items')!.id).toBe(mine.id);
    // Every acceptance is kept: the terms twice, the privacy policy once.
    expect(file.filter((row) => row.kind === 'consent')).toHaveLength(3);
  });

  it('lists the declared consent kinds to anyone, and accepts only those, at their current version', async () => {
    // Public: a sign-up page shows them before there is an account.
    const kinds = await node
      .http()
      .get('/v1/account/consent-kinds')
      .expect(200);
    expect(kinds.body.items).toEqual([
      {
        kind: 'terms',
        version: '2026-01',
        required: true,
        label: 'Terms of service',
        description: expect.any(String),
      },
      {
        kind: 'privacy',
        version: '2026-01',
        required: true,
        label: 'Privacy policy',
        description: expect.any(String),
      },
      {
        kind: 'marketing',
        version: '2026-01',
        required: false,
        label: 'Marketing emails',
        description: expect.any(String),
      },
    ]);
    // In the request's language.
    const german = await node
      .http()
      .get('/v1/account/consent-kinds')
      .set('Accept-Language', 'de')
      .expect(200);
    expect(german.body.items[0].label).toBe('Nutzungsbedingungen');

    const ada = await person();
    const unknown = await ada.agent
      .post('/v1/account/consents')
      .send({ kind: 'newsletter', version: '2026-01' })
      .expect(400);
    expect(unknown.body).toMatchObject({ code: 'validation_failed' });
    expect(paths(unknown.body)).toEqual(['kind']);
    expect(unknown.body.errors[0].message).toContain(
      'terms, privacy, marketing',
    );
    const outdated = await ada.agent
      .post('/v1/account/consents')
      .send({ kind: 'terms', version: '2025-06' })
      .expect(400);
    expect(paths(outdated.body)).toEqual(['version']);
    expect(outdated.body.errors[0].message).toContain('2026-01');
    expect(
      (await ada.agent.get('/v1/account/consents').expect(200)).body.items,
    ).toEqual([]);
  });

  it('withdraws an optional consent as easily as it was given, keeping the history; a required one is refused', async () => {
    const ada = await person();
    const given = await ada.agent
      .post('/v1/account/consents')
      .send({ kind: 'marketing', version: '2026-01' })
      .expect(201);
    expect(given.body.withdrawnAt).toBeNull();
    await ada.agent
      .post('/v1/account/consents')
      .send({ kind: 'terms', version: '2026-01' })
      .expect(201);

    // No password, no step-up: one request.
    const withdrawn = await ada.agent
      .delete('/v1/account/consents/marketing')
      .expect(200);
    expect(withdrawn.body).toMatchObject({
      kind: 'marketing',
      version: '2026-01',
      acceptedAt: given.body.acceptedAt,
      withdrawnAt: expect.any(String),
    });
    const state = await ada.agent.get('/v1/account').expect(200);
    const byKind = Object.fromEntries(
      state.body.consents.map((c: { kind: string }) => [c.kind, c]),
    );
    expect(byKind.marketing.withdrawnAt).toBe(withdrawn.body.withdrawnAt);
    expect(byKind.terms.withdrawnAt).toBeNull();
    // Withdrawn already: nothing in force.
    await ada.agent.delete('/v1/account/consents/marketing').expect(404);
    await ada.agent.delete('/v1/account/consents/never-given').expect(404);
    // Proof: the user's own entry, account-level.
    const [entry] = await node.auditEntries({
      action: 'account.consent-withdrawn',
      targetId: ada.id,
    });
    expect(entry).toMatchObject({
      tenantId: null,
      actor: `user:${ada.id}`,
      details: { kind: 'marketing', version: '2026-01' },
    });

    // The terms are the contract, not a consent to withdraw and stay.
    const required = await ada.agent
      .delete('/v1/account/consents/terms')
      .expect(409);
    expect(required.body.code).toBe('consent_required');
    expect(
      (await ada.agent.get('/v1/account/consents').expect(200)).body.items.find(
        (c: { kind: string }) => c.kind === 'terms',
      ).withdrawnAt,
    ).toBeNull();

    // Given again: a new acceptance, the withdrawn one kept.
    const again = await ada.agent
      .post('/v1/account/consents')
      .send({ kind: 'marketing', version: '2026-01' })
      .expect(201);
    expect(again.body.withdrawnAt).toBeNull();
    const now = (await ada.agent.get('/v1/account/consents').expect(200)).body
      .items;
    expect(
      now.find((c: { kind: string }) => c.kind === 'marketing'),
    ).toMatchObject({ acceptedAt: again.body.acceptedAt, withdrawnAt: null });
    const rows = await node.db
      .select()
      .from(consentsTable)
      .where(
        and(
          eq(consentsTable.userId, ada.id),
          eq(consentsTable.kind, 'marketing'),
        ),
      )
      .orderBy(consentsTable.acceptedAt);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.acceptedAt.toISOString()).toBe(given.body.acceptedAt);
    expect(rows[0]!.withdrawnAt?.toISOString()).toBe(
      withdrawn.body.withdrawnAt,
    );
    expect(rows[1]!.withdrawnAt).toBeNull();
  });

  it('tells whether the deletion wants the password: hasPassword, as the route decides', async () => {
    const ada = await person();
    expect(
      (await ada.agent.get('/v1/auth/me').expect(200)).body.hasPassword,
    ).toBe(true);
    await ada.agent.post('/v1/account/deletion').send({}).expect(400);

    // An account that signs in without a password (a passkey, a provider).
    const bob = await person();
    await node.db
      .update(usersTable)
      .set({ passwordHash: null })
      .where(eq(usersTable.id, bob.id));
    expect(
      (await bob.agent.get('/v1/auth/me').expect(200)).body.hasPassword,
    ).toBe(false);
    await bob.agent.post('/v1/account/deletion').send({}).expect(200);
  });

  it('signs out the other sessions when the deletion is asked for, keeping this one to cancel', async () => {
    const ada = await person();
    const phone = await node.signIn(ada.email, ada.password);
    const laptop = await node.signIn(ada.email, ada.password);
    await phone.get('/v1/auth/me').expect(200);

    await ada.agent
      .post('/v1/account/deletion')
      .send({ password: ada.password })
      .expect(200);
    await phone.get('/v1/auth/me').expect(401);
    await laptop.get('/v1/auth/me').expect(401);
    await ada.agent.get('/v1/auth/me').expect(200);
    const [requested] = await node.auditEntries({
      action: 'account.deletion-requested',
      targetId: ada.id,
    });
    expect(requested.details).toMatchObject({
      signedOut: { tokens: true },
    });
    expect(
      (requested.details as { signedOut: { sessions: number } }).signedOut
        .sessions,
    ).toBeGreaterThanOrEqual(2);
    // Where you're signed in: here alone.
    const sessions = await ada.agent.get('/v1/auth/sessions').expect(200);
    expect(sessions.body.items).toMatchObject([{ current: true }]);
    // Asked again: the pending request, nothing more signed out.
    await ada.agent
      .post('/v1/account/deletion')
      .send({ password: ada.password })
      .expect(200);
    await ada.agent.get('/v1/auth/me').expect(200);

    // This session cancels.
    await ada.agent.delete('/v1/account/deletion').expect(204);
    // Signing in again works while it is pending, and so does the mail's link.
    await ada.agent
      .post('/v1/account/deletion')
      .send({ password: ada.password })
      .expect(200);
    const again = await node.signIn(ada.email, ada.password);
    await again.get('/v1/account').expect(200);
    await node
      .http()
      .post('/v1/account/deletion/cancel')
      .send({ token: await cancelToken(ada.email, 2) })
      .expect(204);
    expect(
      (await ada.agent.get('/v1/account').expect(200)).body.deletion,
    ).toBeNull();
  });

  it('limits the deletion request like signing in: 5 tries from an address in 15 minutes', async () => {
    const ada = await person();
    for (let attempt = 0; attempt < 5; attempt++) {
      await ada.agent
        .post('/v1/account/deletion')
        .set('X-Forwarded-For', '10.8.8.8')
        .send({ password: 'wrong-password' })
        .expect(403);
    }
    const limited = await ada.agent
      .post('/v1/account/deletion')
      .set('X-Forwarded-For', '10.8.8.8')
      .send({ password: ada.password })
      .expect(429);
    expect(limited.body.code).toBe('rate_limited');
    expect(await ada.agent.get('/v1/account').expect(200)).toMatchObject({
      body: { deletion: null },
    });
  });

  it('deletes an account after the grace period unless cancelled; the person is anonymized, their records stay', async () => {
    const ada = await person();
    const note = (
      await node
        .writeItem(ada.agent, { title: 'Keep me', body: '' })
        .expect(201)
    ).body;

    // The password again, on top of a recent sign-in (step-up:
    // reauthentication.e2e-spec.ts): a thief's authenticator must not do.
    const missing = await ada.agent
      .post('/v1/account/deletion')
      .send({})
      .expect(400);
    expect(paths(missing.body)).toEqual(['password']);
    const wrong = await ada.agent
      .post('/v1/account/deletion')
      .send({ password: 'wrong-password' })
      .expect(403);
    expect(wrong.body.code).toBe('forbidden');
    expect(
      await node.auditEntries({ action: 'account.deletion-refused' }),
    ).toMatchObject([{ actor: `user:${ada.id}` }]);
    const requested = await ada.agent
      .post('/v1/account/deletion')
      .send({ password: ada.password })
      .expect(200);
    const scheduledFor = new Date(requested.body.scheduledFor).getTime();
    expect(scheduledFor - Date.now()).toBeGreaterThan(13 * 86_400_000);
    expect(scheduledFor - Date.now()).toBeLessThanOrEqual(14 * 86_400_000);
    const mail = await node.waitForMail({
      to: ada.email,
      subject: /will be deleted/,
    });
    expect(mail.html).toContain('https://web.example.com/account');
    expect(
      (await ada.agent.get('/v1/account').expect(200)).body.deletion,
    ).toEqual(requested.body);
    // Asked again: the same request.
    expect(
      (
        await ada.agent
          .post('/v1/account/deletion')
          .send({ password: ada.password })
          .expect(200)
      ).body,
    ).toEqual(requested.body);

    // Changed their mind.
    await ada.agent.delete('/v1/account/deletion').expect(204);
    expect(
      (await ada.agent.get('/v1/account').expect(200)).body.deletion,
    ).toBeNull();
    await ada.agent.delete('/v1/account/deletion').expect(404);

    // Asked once more; the job waits for the grace period, then carries it out.
    await ada.agent
      .post('/v1/account/deletion')
      .send({ password: ada.password })
      .expect(200);
    const job = node.app.get(AccountDeletionJob);
    expect(await job.run(new Date())).toBe(0);
    expect(await job.run(new Date(Date.now() + 15 * 86_400_000))).toBe(1);

    await ada.agent.get('/v1/auth/me').expect(401); // signed out everywhere
    await node
      .http()
      .post('/v1/auth/sign-in')
      .send({ email: ada.email, password: ada.password })
      .expect(401);
    const users = await node
      .admin()
      .get('/v1/access/users?limit=100')
      .expect(200);
    // No longer a member of any tenant; the account row stays, anonymized.
    expect(
      users.body.items.find((u: { id: string }) => u.id === ada.id),
    ).toBeUndefined();
    const [account] = await node.db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, ada.id));
    expect(account).toMatchObject({
      name: 'Deleted user',
      active: false,
      passwordHash: null,
    });
    expect(account!.email).toMatch(/^deleted-.*@anonymized\.invalid$/);
    // The note stays, owned by nobody in particular.
    const kept = await node
      .admin()
      .get(`/v1/test-items/${note.id}`)
      .expect(200);
    expect(kept.body.ownerId).toBe(`user:${ada.id}`);
    // The audit trail keeps the actor key, not the person.
    const audit = await node
      .admin()
      .get(`/v1/access/audit?actor=user:${ada.id}`)
      .expect(200);
    expect(audit.body.items.length).toBeGreaterThan(0);
    expect(
      audit.body.items.every(
        (e: { actorLabel: string }) => e.actorLabel === 'Deleted user',
      ),
    ).toBe(true);
    // The job did it: the system principal, named after the job (the
    // account's own entry, in no tenant).
    const done = await node.auditEntries({ action: 'account.deleted' });
    expect(done[0]).toMatchObject({
      targetId: ada.id,
      actor: 'system:account-deletion',
      actorLabel: 'System: Account deletion',
    });
  });
  /** The cancel link's token of the `n`th deletion mail to `to` (1: the first), once it was sent. */
  async function cancelToken(to: string, n: number) {
    for (let tries = 0; tries < 100; tries++) {
      const mails = node.mailbox.filter({ to, subject: /will be deleted/ });
      if (mails.length >= n) {
        const link = mails[n - 1].link('/cancel-deletion');
        expect(link.origin).toBe('https://web.example.com');
        return link.searchParams.get('token')!;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`No deletion mail #${n} to ${to}`);
  }

  it("cancels with the mail's link, without a sign-in: once, for its own request, until the deletion ran", async () => {
    const ada = await person();
    const cancel = (token: string) =>
      node.http().post('/v1/account/deletion/cancel').send({ token });
    const request = () =>
      ada.agent
        .post('/v1/account/deletion')
        .send({ password: ada.password })
        .expect(200);

    await request();
    const first = await cancelToken(ada.email, 1);
    // Nobody signed in: the link is the proof.
    await cancel(first).expect(204);
    expect(
      (await ada.agent.get('/v1/account').expect(200)).body.deletion,
    ).toBeNull();
    // Account-level: in no tenant's log (tenant null), the user's own entry.
    const [cancelled] = await node.auditEntries({
      action: 'account.deletion-cancelled',
      targetId: ada.id,
    });
    expect(cancelled).toMatchObject({
      tenantId: null,
      actor: `user:${ada.id}`,
      details: { via: 'link' },
    });
    const inTenant = await node
      .admin()
      .get('/v1/access/audit?action=account.deletion-cancelled')
      .expect(200);
    expect(inTenant.body.items).toEqual([]);
    // Once: used, it is refused, as anything else is.
    const replayed = await cancel(first).expect(400);

    // A new request: the old link doesn't cancel it, its own does.
    await request();
    const second = await cancelToken(ada.email, 2);
    expect(second).not.toBe(first);
    expect((await cancel(first).expect(400)).body).toMatchObject({
      status: 400,
      code: replayed.body.code,
    });
    await cancel(second).expect(204);
    await cancel(second).expect(400);

    // Carried out: the link of the request it carried out is dead.
    await request();
    const third = await cancelToken(ada.email, 3);
    expect(
      await node.app
        .get(AccountDeletionJob)
        .run(new Date(Date.now() + 15 * 86_400_000)),
    ).toBe(1);
    await cancel(third).expect(400);
    expect(
      await node.auditEntries({ action: 'account.deleted', targetId: ada.id }),
    ).toHaveLength(1);
  });

  it('keeps a request cancelled by its link from being carried out', async () => {
    const ada = await person();
    await ada.agent
      .post('/v1/account/deletion')
      .send({ password: ada.password })
      .expect(200);
    await node
      .http()
      .post('/v1/account/deletion/cancel')
      .send({ token: await cancelToken(ada.email, 1) })
      .expect(204);
    expect(
      await node.app
        .get(AccountDeletionJob)
        .run(new Date(Date.now() + 15 * 86_400_000)),
    ).toBe(0);
    await ada.agent.get('/v1/auth/me').expect(200);
  });

  it('cancels nothing once the job started on the request (claimed under the account lock)', async () => {
    const ada = await person();
    await ada.agent
      .post('/v1/account/deletion')
      .send({ password: ada.password })
      .expect(200);
    const token = await cancelToken(ada.email, 1);
    // What the job's claim does before it erases tenant by tenant.
    await node.app
      .get<Database>(getDrizzleToken())
      .update(accountDeletions)
      .set({ startedAt: new Date() })
      .where(eq(accountDeletions.userId, ada.id));
    await node
      .http()
      .post('/v1/account/deletion/cancel')
      .send({ token })
      .expect(400);
    await ada.agent.delete('/v1/account/deletion').expect(404);
    // The job carries a claimed request on (a run that stopped part-way).
    expect(
      await node.app
        .get(AccountDeletionJob)
        .run(new Date(Date.now() + 15 * 86_400_000)),
    ).toBe(1);
  });
});

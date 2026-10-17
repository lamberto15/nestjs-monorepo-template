import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { bootApp, newPassword, type TestApp } from './support.js';

// Read when AppModule loads: accounts sign up here (one with no tenant).
vi.hoisted(() => {
  process.env.AUTH_SIGN_UP = 'on';
});

/** A signed URL's path and query, for this app (its host is APP_URL's). */
const local = (url: string) => {
  const { pathname, search } = new URL(url);
  return pathname + search;
};

/**
 * A person's data export across tenants (docs/tenancy.md): queued in no
 * tenant, so an account with no membership has one too, filed under
 * `accounts/<user id>/`, followed by its user in any tenant or none, and
 * holding each tenant's data in turn.
 */
describe('the account export (e2e)', () => {
  let node: TestApp;

  beforeEach(async () => {
    node = await bootApp();
  });
  afterEach(() => node.close());

  type Row = { kind: string; id: string | null; data: Record<string, any> };

  /** Starts an export as this browser, waits for it, and returns its status and file. */
  async function exportOf(agent: request.Agent) {
    const started = await agent.post('/v1/account/export').send({}).expect(202);
    const id = started.body.id as string;
    let status: Record<string, any> = {};
    for (let tries = 0; tries < 100; tries++) {
      status = (await agent.get(`/v1/data/transfers/${id}`).expect(200)).body;
      if (['completed', 'failed'].includes(status.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(status.status).toBe('completed');
    const file = (await node.http().get(local(status.result.url)).expect(200))
      .body as Row[];
    return { id, status, file };
  }

  it('exports an account with no tenant, under accounts/<id>/', async () => {
    const { agent: browser, email, id } = await signUp('Solo');
    const signedUp = { body: { id } };
    const me = await browser.get('/v1/auth/me').expect(200);
    expect(me.body.user.tenantId).toBeNull();

    const { status, file } = await exportOf(browser);
    expect(decodeURIComponent(status.result.url)).toContain(
      `accounts/${signedUp.body.id}/transfers/`,
    );
    expect(file.find((row) => row.kind === 'profile')?.data.email).toBe(email);
    expect(file.some((row) => row.kind === 'membership')).toBe(false);
  });

  /** A person who signed up themselves (no tenant yet), verified their address, signed in. */
  async function signUp(name: string) {
    const email = `${randomUUID().slice(0, 8)}@example.com`;
    const password = newPassword();
    const created = await node
      .http()
      .post('/v1/auth/sign-up')
      .send({ email, name, password })
      .expect(201);
    await node.verifySignUp(email, password);
    const agent = await node.signIn(email, password);
    return { agent, email, password, id: created.body.id as string };
  }

  /** `admin` invites the person into its tenant as an editor; they accept while signed in. */
  async function join(
    person: Awaited<ReturnType<typeof signUp>>,
    admin: request.Agent,
  ) {
    const editor = (
      (await admin.get('/v1/access/roles').expect(200)).body.items as {
        id: string;
        key: string | null;
      }[]
    ).find((role) => role.key === 'editor')!;
    const token = await node.invite(admin, {
      email: person.email,
      roleIds: [editor.id],
    });
    await person.agent
      .post('/v1/auth/invitations/accept')
      .send({ token })
      .expect(200);
  }

  const switchTo = (agent: request.Agent, tenantId: string) =>
    agent.post('/v1/auth/tenant').send({ tenantId }).expect(204);

  it('exports both tenants of a person in two, and the export follows them across a switch', async () => {
    const other = await node.otherTenant();
    const person = await signUp('Both');
    await join(person, node.admin());
    await switchTo(person.agent, node.tenantId);
    const inA = await node
      .writeItem(person.agent, { title: 'In A', body: '' })
      .expect(201);
    await join(person, other.admin);
    await switchTo(person.agent, other.id);
    const inB = await node
      .writeItem(person.agent, { title: 'In B', body: '' })
      .expect(201);

    const { id, status, file } = await exportOf(person.agent);
    expect(decodeURIComponent(status.result.url)).toContain(
      `accounts/${person.id}/transfers/`,
    );
    expect(
      file.filter((row) => row.kind === 'membership').map((row) => row.id),
    ).toEqual(expect.arrayContaining([node.tenantId, other.id]));
    const notes = file
      .filter((row) => row.kind === 'test-items')
      .map((row) => row.data.id ?? row.id);
    expect(notes).toEqual(expect.arrayContaining([inA.body.id, inB.body.id]));

    // Back in the first tenant, the export (no tenant's) is still theirs…
    await switchTo(person.agent, node.tenantId);
    const again = await person.agent
      .get(`/v1/data/transfers/${id}`)
      .expect(200);
    expect(again.body.status).toBe('completed');
    // …and nobody else's, whatever their tenant.
    await other.admin.get(`/v1/data/transfers/${id}`).expect(404);
    await node.admin().get(`/v1/data/transfers/${id}`).expect(404);
  });

  it('never lets an administrator acting as the person queue or follow their account export', async () => {
    const person = await signUp('Watched');
    await join(person, node.admin());
    await switchTo(person.agent, node.tenantId);
    const { id } = await exportOf(person.agent);
    // The tenant's administrator acts as them (a member of the tenant)…
    const admin = await node.signIn(
      process.env.ADMIN_EMAIL!,
      process.env.ADMIN_PASSWORD!,
    );
    await admin.post(`/v1/access/users/${person.id}/impersonate`).expect(204);
    const me = await admin.get('/v1/auth/me').expect(200);
    expect(me.body.user.impersonator).toBeDefined();
    // …and may queue the account export by no route…
    await admin.post('/v1/account/export').send({}).expect(403);
    const generic = await admin
      .post('/v1/data/exports')
      .send({ name: 'account' });
    expect(generic.status).toBe(403);
    // …nor read the person's own export, or its link.
    await admin.get(`/v1/data/transfers/${id}`).expect(404);
    // The person still can.
    await person.agent.get(`/v1/data/transfers/${id}`).expect(200);
  });

  it('exports only what is personal from a tenant the person left', async () => {
    const other = await node.otherTenant();
    const person = await signUp('Leaving');
    await join(person, other.admin);
    await switchTo(person.agent, other.id);
    const note = await node
      .writeItem(person.agent, { title: 'Theirs', body: '' })
      .expect(201);
    await other.admin
      .patch(`/v1/access/users/${person.id}`)
      .send({ active: false })
      .expect(204);
    // Their sessions in that tenant ended with the membership: a new sign-in,
    // in no tenant now.
    const browser = await node.signIn(person.email, person.password);
    const { file } = await exportOf(browser);
    const membership = file.find((row) => row.kind === 'membership');
    expect(membership?.id).toBe(other.id);
    expect(membership?.data.active).toBe(false);
    // The tenant's business records stay with the tenant.
    expect(file.some((row) => row.kind === 'test-items')).toBe(false);
    expect(JSON.stringify(file)).not.toContain(note.body.id);
    // What is about them there (their membership's change) is theirs.
    expect(
      file.some(
        (row) => row.kind === 'auditEntry' && row.data.targetId === person.id,
      ),
    ).toBe(true);
  });
});

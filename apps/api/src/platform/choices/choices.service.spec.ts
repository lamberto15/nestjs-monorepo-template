import { BadRequestException } from '@nestjs/common';
import type { RequestPrincipal } from '../../iam/auth/principal.js';
import { ChoicesRegistry, type ChoiceProvider } from './choices.registry.js';
import { ChoicesService } from './choices.service.js';

const ACME = '11111111-1111-4111-8111-111111111111';
const GLOBEX = '22222222-2222-4222-8222-222222222222';
const WEB = '33333333-3333-4333-8333-333333333333';
const principal = { kind: 'user', id: 'u1' } as RequestPrincipal;

/** Customers, and the projects each has: the child's choices depend on the parent. */
const PROJECTS: Record<string, string[]> = { [ACME]: [WEB], [GLOBEX]: [] };
const customers: ChoiceProvider = {
  key: 'customers',
  label: 'Customers',
  params: {},
  mayUse: async () => true,
  options: async () =>
    Object.keys(PROJECTS).map((value) => ({ value, label: value })),
  has: async ({ value }) => value in PROJECTS,
};
const projects: ChoiceProvider = {
  key: 'projects',
  label: 'Projects',
  params: { customerId: 'uuid' },
  mayUse: async () => true,
  options: async ({ params, limit }) =>
    (PROJECTS[params.customerId!] ?? [])
      .slice(0, limit)
      .map((value) => ({ value, label: 'Website' })),
  has: async ({ params, value }) =>
    (PROJECTS[params.customerId!] ?? []).includes(value),
};

const messages = async (run: Promise<unknown>) => {
  try {
    await run;
  } catch (error) {
    return (
      (error as BadRequestException).getResponse() as {
        errors: { path: string; message: string }[];
      }
    ).errors.map((e) => `${e.path}: ${e.message}`);
  }
  return [];
};

describe('ChoicesService', () => {
  let service: ChoicesService;
  beforeEach(() => {
    const registry = new ChoicesRegistry();
    registry.provider(customers);
    registry.provider(projects);
    registry.set({
      key: 'work',
      label: 'Work',
      fields: {
        customer: { provider: 'customers' },
        project: { provider: 'projects', params: { customerId: 'customer' } },
      },
    });
    service = new ChoicesService(registry);
  });

  it('answers a child for its parent, echoing the parent so a stale answer can be told', async () => {
    const answer = await service.options(principal, 'work', 'project', {
      'parent.customer': ACME,
    });
    expect(answer).toMatchObject({
      parents: { customer: ACME },
      items: [{ value: WEB }],
      hasMore: false,
    });
    const other = await service.options(principal, 'work', 'project', {
      'parent.customer': GLOBEX,
    });
    expect(other.items).toEqual([]);
    expect(other.parents).toEqual({ customer: GLOBEX });
  });

  it('bounds the answer and says when more match', async () => {
    const answer = await service.options(principal, 'work', 'customer', {
      limit: 1,
    });
    expect(answer.items).toHaveLength(1);
    expect(answer.hasMore).toBe(true);
  });

  it('refuses a missing, malformed or unlisted parent parameter', async () => {
    const failing = (query: Record<string, string>) =>
      messages(service.options(principal, 'work', 'project', query));
    expect(await failing({})).toEqual([
      'parent.customer: parent.customer is required.',
    ]);
    expect(await failing({ 'parent.customer': 'x; drop table' })).toEqual([
      'parent.customer: customer is not a valid uuid.',
    ]);
    expect(
      await failing({ 'parent.customer': ACME, 'parent.other': ACME }),
    ).toEqual(['parent.other: Not a parameter: use parent.customer.']);
  });

  it('validates a child against its parent on write: a changed parent invalidates the child', async () => {
    await service.assertValid(principal, 'work', {
      customer: ACME,
      project: WEB,
    });
    expect(
      await messages(
        service.assertValid(principal, 'work', {
          customer: GLOBEX,
          project: WEB,
        }),
      ),
    ).toEqual([
      `project: Not one of the choices available for project given customer.`,
    ]);
  });

  it('refuses a child without its parent, and a child of an invalid parent', async () => {
    expect(
      await messages(service.assertValid(principal, 'work', { project: WEB })),
    ).toEqual(['project: Choose customer first: project depends on it.']);
    const [first, second] = await messages(
      service.assertValid(principal, 'work', {
        customer: '44444444-4444-4444-8444-444444444444',
        project: WEB,
      }),
    );
    expect(first).toMatch(/^customer: Not one of the choices/);
    expect(second).toMatch(/^project: customer is not a valid choice/);
  });

  it('leaves absent and null values to the record, and refuses unknown fields', async () => {
    await service.assertValid(principal, 'work', { customer: null });
    expect(
      await messages(service.assertValid(principal, 'work', { stray: 'x' })),
    ).toEqual(['stray: Not a field of "work".']);
  });

  it('refuses a provider the principal may not use', async () => {
    const registry = new ChoicesRegistry();
    registry.provider({ ...customers, mayUse: async () => false });
    registry.set({
      key: 'closed',
      label: 'Closed',
      fields: { customer: { provider: 'customers' } },
    });
    const closed = new ChoicesService(registry);
    await expect(
      closed.options(principal, 'closed', 'customer', {}),
    ).rejects.toMatchObject({ status: 403 });
    expect((await closed.sets(principal)).items[0]!.fields).toEqual([]);
  });
});

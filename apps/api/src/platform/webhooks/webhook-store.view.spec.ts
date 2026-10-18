import { randomBytes } from 'node:crypto';
import { useCursorKeys } from '../../core/http/cursor-seal.js';
import { encodeCursor } from '../../core/http/list-sort.js';
import { DELIVERY_LIST } from './webhook-store.view.js';

const id = (hex = 'a') => `dlv_0192${hex.repeat(28)}`;
const parse = (query: Record<string, unknown>) =>
  DELIVERY_LIST.schema.safeParse(query);

describe('DELIVERY_LIST (the webhook delivery log query)', () => {
  beforeEach(() => useCursorKeys([randomBytes(32).toString('base64')]));

  it("takes the package's delivery ids as a cursor, not UUIDs", () => {
    expect(parse({ cursor: id() }).success).toBe(true);
    for (const cursor of [
      '0192aaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa',
      'dlv_0192aaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa',
      'msg_0192aaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'nope',
    ]) {
      expect(parse({ cursor }).success, cursor).toBe(false);
    }
  });

  it('opens a sorted cursor that carries a delivery id', () => {
    const query = parse({ sort: '-attempts' });
    expect(query.success).toBe(true);
    const sort = (query.data as { sort: Parameters<typeof encodeCursor>[0] })
      .sort;
    const cursor = encodeCursor(sort, { id: id('b'), attempts: 3 });
    const next = parse({ sort: '-attempts', cursor });
    expect(next.success).toBe(true);
    expect(next.data).toMatchObject({ cursor: id('b') });
  });

  it('filters by status, endpoint, type and an ISO creation time', () => {
    const query = parse({
      status: 'failed',
      endpointId: 'ep_1',
      'type.startsWith': 'note.',
      'createdAt.gte': '2026-01-01T00:00:00Z',
    });
    expect(query.success).toBe(true);
    expect(parse({ status: 'lost' }).success).toBe(false);
  });
});

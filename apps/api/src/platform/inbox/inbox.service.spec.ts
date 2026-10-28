import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { Principal } from '../../iam/auth/principal.js';
import { type InboxEntry, InboxRegistry } from './inbox.registry.js';
import { InboxService } from './inbox.service.js';

const me = { kind: 'user', id: 'u1' } as Principal;

/** A source over ids (UUIDv7-like strings: their order is the list's order). */
const source = (
  name: string,
  ids: string[],
  extra: Partial<InboxEntry> = {},
  dismiss?: (id: string) => void,
) => ({
  name,
  items: (_: Principal, page: { limit: number; after?: string }) =>
    Promise.resolve(
      ids
        .filter((id) => !page.after || id < page.after)
        .sort()
        .reverse()
        .slice(0, page.limit)
        .map((id) => ({
          id,
          at: new Date('2026-01-01T00:00:00Z'),
          kind: `${name}.work`,
          data: {},
          link: null,
          dueAt: null,
          ...extra,
        })),
    ),
  ...(dismiss ? { dismiss: (_: Principal, id: string) => dismiss(id) } : {}),
});

function inboxOf(...sources: ReturnType<typeof source>[]) {
  const registry = new InboxRegistry();
  sources.forEach((s) => registry.register(s));
  return new InboxService(registry);
}

describe('the work inbox', () => {
  it('merges the sources newest first and pages with a cursor that holds each source', async () => {
    const inbox = inboxOf(
      source('approval', ['5a', '3a', '1a']),
      source('mention', ['4m', '2m']),
    );
    const first = await inbox.page(me, { limit: 3 });
    expect(first.items.map((i) => i.key)).toEqual([
      'approval:5a',
      'mention:4m',
      'approval:3a',
    ]);
    expect(first.nextCursor).not.toBeNull();
    const second = await inbox.page(me, {
      limit: 3,
      cursor: first.nextCursor!,
    });
    expect(second.items.map((i) => i.key)).toEqual([
      'mention:2m',
      'approval:1a',
    ]);
    expect(second.nextCursor).toBeNull();
  });

  it('keeps one item of the entries that are the same work', async () => {
    const inbox = inboxOf(
      source('approval', ['b2'], { dedupe: 'same' }),
      source('mention', ['b1'], { dedupe: 'same' }),
    );
    const page = await inbox.page(me, { limit: 10 });
    expect(page.items.map((i) => i.key)).toEqual(['approval:b2']);
  });

  it('narrows to one source and refuses an unknown one or a bad cursor', async () => {
    const inbox = inboxOf(
      source('approval', ['a1']),
      source('mention', ['m1']),
    );
    expect(
      (await inbox.page(me, { limit: 10, source: 'mention' })).items,
    ).toHaveLength(1);
    await expect(
      inbox.page(me, { limit: 10, source: 'nope' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      inbox.page(me, { limit: 10, cursor: '!!' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('dismisses only what its source lets be dismissed', async () => {
    const dismissed: string[] = [];
    const inbox = inboxOf(
      source('approval', ['a1']),
      source('mention', ['m1'], {}, (id) => dismissed.push(id)),
    );
    const page = await inbox.page(me, { limit: 10 });
    expect(page.items.map((i) => [i.key, i.canDismiss])).toEqual([
      ['mention:m1', true],
      ['approval:a1', false],
    ]);
    await inbox.dismiss(me, 'mention:m1');
    expect(dismissed).toEqual(['m1']);
    await expect(inbox.dismiss(me, 'approval:a1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(inbox.dismiss(me, 'nowhere:1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

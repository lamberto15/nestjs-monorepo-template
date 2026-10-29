import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Principal } from '../../iam/auth/principal.js';
import { type InboxEntry, InboxRegistry } from './inbox.registry.js';
import type { InboxQuery } from './inbox.schemas.js';

/** Where each source's next page starts (the last id it gave), sealed in the cursor. */
type Positions = Record<string, string>;

const encode = (positions: Positions) =>
  Buffer.from(JSON.stringify(positions)).toString('base64url');

function decode(cursor: string | undefined): Positions {
  if (!cursor) {
    return {};
  }
  try {
    const raw = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
    if (Object.values(raw).some((id) => typeof id !== 'string')) {
      throw new Error('bad position');
    }
    return raw as Positions;
  } catch {
    throw new BadRequestException('The cursor is not valid.');
  }
}

/**
 * The personal work inbox: what is waiting on the caller, from every
 * registered source (approvals, mentions…), newest first (the sources' ids are UUIDv7: one order for all), in one list. It
 * keeps nothing of its own: each source reads its authoritative state for
 * this caller, so an item is there exactly while its source says the work is
 * open, and only what the caller may see. A page asks every source for its
 * next `limit` entries, merges them and keeps `limit`; the cursor holds where
 * each source stopped, so pages are stable whatever arrives meanwhile. Two
 * entries with the same `dedupe` are one item.
 */
@Injectable()
export class InboxService {
  constructor(private readonly registry: InboxRegistry) {}

  async page(principal: Principal, query: InboxQuery) {
    const sources = this.registry
      .all()
      .filter((source) => !query.source || source.name === query.source);
    if (query.source && sources.length === 0) {
      throw new NotFoundException(`No inbox source "${query.source}".`);
    }
    const positions = decode(query.cursor);
    const fetched = await Promise.all(
      sources.map(async (source) => ({
        source,
        entries: await source.items(principal, {
          limit: query.limit + 1,
          after: positions[source.name],
        }),
      })),
    );
    const merged = fetched
      .flatMap(({ source, entries }) =>
        entries.map((entry) => ({ source: source.name, entry })),
      )
      .sort((a, b) => (a.entry.id < b.entry.id ? 1 : -1));
    const next: Positions = { ...positions };
    const seen = new Set<string>();
    const items: ReturnType<typeof this.view>[] = [];
    let used = 0;
    for (const { source, entry } of merged) {
      if (items.length === query.limit) {
        break;
      }
      used += 1;
      next[source] = entry.id;
      const dedupe = entry.dedupe ?? `${source}:${entry.id}`;
      if (!seen.has(dedupe)) {
        seen.add(dedupe);
        items.push(this.view(source, entry));
      }
    }
    // More when entries are left over, or a source filled its window.
    const more =
      used < merged.length ||
      fetched.some(({ entries }) => entries.length >= query.limit + 1);
    return { items, nextCursor: more ? encode(next) : null };
  }

  /** Dismisses an item (marks it read at its source), or says it can't be. */
  async dismiss(principal: Principal, key: string) {
    const at = key.indexOf(':');
    const source = at > 0 ? this.registry.find(key.slice(0, at)) : undefined;
    if (!source) {
      throw new NotFoundException(`No inbox item ${key}.`);
    }
    if (!source.dismiss) {
      throw new BadRequestException(
        'This item is done where it comes from, not dismissed.',
      );
    }
    await source.dismiss(principal, key.slice(at + 1));
  }

  private view(source: string, entry: InboxEntry) {
    return {
      key: `${source}:${entry.id}`,
      source,
      kind: entry.kind,
      at: entry.at.toISOString(),
      dueAt: entry.dueAt?.toISOString() ?? null,
      link: entry.link,
      subject: entry.subject ?? null,
      recordId: entry.recordId ?? null,
      data: entry.data,
      canDismiss: !!this.registry.find(source)?.dismiss,
    };
  }
}

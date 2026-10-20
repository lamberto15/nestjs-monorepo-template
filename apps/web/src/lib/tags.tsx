import { unwrap, type GetResponse } from '@nestjs-monorepo-template/api-client';
import { Badge } from '@nestjs-monorepo-template/ui/components/badge';
import { queryOptions, useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { FilterOption } from '@/lib/data-table-types';

/**
 * A subject's tags (GET /v1/tags, docs/tags.md) for the tag filter's picker,
 * and a tag as a chip. The tenant's tags change rarely: fetched once, kept ten
 * minutes.
 */
export type Tag = GetResponse<'/v1/tags'>['items'][number];

/** Tags a list shows at most: 10 pages of 100, far past what a picker can use. */
const PAGE_SIZE = 100;
const MAX_PAGES = 10;
export const MAX_TAGS = PAGE_SIZE * MAX_PAGES;

/** The tags read, and whether more were left (the alphabetically last ones). */
export type TagsRead = { tags: Tag[]; truncated: boolean };

/** One subject's tags, or (no subject) every subject's: the management page. */
async function fetchTags(subject?: string): Promise<TagsRead> {
  const tags: Tag[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await unwrap(
      api.GET('/v1/tags', {
        params: {
          query: { subject, sort: 'name', limit: PAGE_SIZE, cursor },
        },
      }),
    );
    tags.push(...result.items);
    if (!result.nextCursor) return { tags, truncated: false };
    cursor = result.nextCursor;
  }
  return { tags, truncated: true };
}

/**
 * Every tag of every subject (`GET /v1/tags` without `?subject=`: "a management
 * screen lists every subject", docs/tags.md), for the tags admin page. Under
 * `['tags', …]`, so whatever refreshes a subject's tags refreshes it too.
 * Stops at `MAX_TAGS` (`truncated`): the page then reads a chosen subject on
 * its own (`subjectTagsQuery`).
 */
export const allTagsQuery = queryOptions({
  queryKey: ['tags', 'all-subjects'],
  queryFn: () => fetchTags(),
});

/** One subject's tags for the admin page, with whether `MAX_TAGS` cut them. */
export const subjectTagsQuery = (subject: string) =>
  queryOptions({
    queryKey: ['tags', subject, 'admin'],
    queryFn: () => fetchTags(subject),
  });

export function useTags(subject: string, enabled = true) {
  return useQuery({
    enabled,
    queryKey: ['tags', subject],
    queryFn: async () => (await fetchTags(subject)).tags,
    staleTime: 10 * 60 * 1000,
  });
}

/** Only `#rrggbb` reaches a style: the API stores no other color. */
function safeColor(color: string | null | undefined) {
  return color && /^#[0-9a-f]{6}$/i.test(color) ? color : undefined;
}

export function TagDot({ color }: { color?: string | null }) {
  const safe = safeColor(color);
  return (
    <span
      aria-hidden
      className="size-2 shrink-0 rounded-full bg-muted-foreground/40"
      style={safe ? { backgroundColor: safe } : undefined}
    />
  );
}

export function TagBadge({ tag }: { tag: Pick<Tag, 'name' | 'color'> }) {
  return (
    <Badge variant="outline">
      <TagDot color={tag.color} />
      {tag.name}
    </Badge>
  );
}

// One icon component per color: the filter's options take a component, and a
// new one on every render would remount the item.
const icons = new Map<string, FilterOption['icon']>();
function tagIcon(color: string | null | undefined): FilterOption['icon'] {
  const key = safeColor(color) ?? '';
  let icon = icons.get(key);
  if (!icon) {
    icon = () => <TagDot color={key} />;
    icons.set(key, icon);
  }
  return icon;
}

/** The tags as the picker's options: the id is the value, the color a dot. */
export function tagOptions(tags: readonly Tag[]): FilterOption[] {
  return tags.map((tag) => ({
    label: tag.name,
    value: tag.id,
    icon: tagIcon(tag.color),
  }));
}

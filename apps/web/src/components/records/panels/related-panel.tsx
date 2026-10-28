import { Skeleton } from '@nestjs-monorepo-template/ui/components/skeleton';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { recordLinkOf } from '@/features/watching/record-links';
import type { ListDescription } from '@/lib/list-query';
import { listRelated, panelKeys, RELATED_LIMIT } from './api';

type Related = ListDescription['related'][number];

/**
 * The records that refer to this one through one relation (a `ref` field of
 * theirs: docs/adding-a-feature.md, "Relationships"): the newest
 * RELATED_LIMIT, read from their own list filtered by the reference, so the
 * API shows only those the user may read. Each opens its page when its
 * feature registers one (`record-link.ts`); the count says how many there
 * are in all.
 */
export function RelatedPanel(props: {
  base: string;
  id: string;
  related: Related;
}) {
  const { t } = useTranslation('records');
  const { path, field, title, subject } = props.related;
  const page = useQuery({
    queryKey: panelKeys.related(props.base, props.id, path, field),
    queryFn: () => listRelated(path, field, props.id),
  });
  const link = recordLinkOf(subject);
  const heading = `related-${path}-${field}`;

  return (
    <section aria-labelledby={heading} className="flex flex-col gap-2">
      <h3 id={heading} className="text-sm font-medium">
        {t('related.heading', { subject, field })}
      </h3>
      {page.isPending ? (
        <Skeleton className="h-16 w-full" aria-busy />
      ) : page.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {t('related.error')}
        </p>
      ) : page.data.items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('related.empty')}</p>
      ) : (
        <>
          <ul className="flex flex-col divide-y rounded-md border">
            {page.data.items.map((item) => {
              const id = item.id as string;
              const name =
                (title ? (item[title] as string | null) : null) ??
                (item.number as string | null | undefined) ??
                id;
              return (
                <li key={id} className="p-2 text-sm">
                  {link ? (
                    <Link to={link.path(id)} className="hover:underline">
                      {name}
                    </Link>
                  ) : (
                    <span>{name}</span>
                  )}
                </li>
              );
            })}
          </ul>
          {(page.data.total ?? 0) > RELATED_LIMIT && (
            <p className="text-sm text-muted-foreground">
              {t('related.more', {
                shown: page.data.items.length,
                total: page.data.total ?? 0,
              })}
            </p>
          )}
        </>
      )}
    </section>
  );
}

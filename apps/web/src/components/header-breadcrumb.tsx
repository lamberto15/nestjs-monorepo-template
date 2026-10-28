import { Link, useRouterState } from '@tanstack/react-router';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbSeparator,
} from '@nestjs-monorepo-template/ui/components/breadcrumb';
import { useTranslation } from 'react-i18next';
import { useVisibleNav } from '@/components/nav-main';
import { activeEntry } from '@/nav';

/**
 * Where the user is, from the menu: its group, then its entry (a link back to
 * the list from a page under it). Nothing for a page off the menu. On a phone
 * only the entry, the header being narrow.
 */
export function HeaderBreadcrumb() {
  const { t } = useTranslation();
  // A folder route's index is `/api-clients/`: the same page as its entry.
  const pathname = useRouterState({
    select: (s) => s.location.pathname.replace(/(.)\/$/, '$1'),
  });
  const entry = activeEntry(useVisibleNav(), pathname);
  if (!entry) {
    return null;
  }
  const { group, item } = entry;
  const label = t(item.label);
  return (
    <Breadcrumb aria-label={t('nav.breadcrumb')} className="min-w-0">
      <BreadcrumbList className="flex-nowrap">
        {group.id !== 'home' && (
          <>
            <BreadcrumbItem className="hidden md:inline-flex">
              {t(group.label)}
            </BreadcrumbItem>
            <BreadcrumbSeparator className="hidden md:block" />
          </>
        )}
        <BreadcrumbItem className="min-w-0">
          {pathname === item.to ? (
            // The page as text, not shadcn's disabled link: the menu's
            // active entry and the page's heading already name it, and a
            // second "link" of that name is noise to a screen reader.
            <span aria-current="page" className="truncate text-foreground">
              {label}
            </span>
          ) : (
            <BreadcrumbLink className="truncate" render={<Link to={item.to} />}>
              {label}
            </BreadcrumbLink>
          )}
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  );
}

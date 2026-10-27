import { cn } from '@nestjs-monorepo-template/ui/lib/utils';
import type { ReactNode } from 'react';

/**
 * A page's outer block: one column with the same gap on every page. `wide`
 * (the default) fills the content area, for tables and lists; `narrow`
 * caps a form or a settings page at a readable width.
 */
export function Page({
  width = 'wide',
  className,
  children,
}: {
  width?: 'wide' | 'narrow';
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      className={cn(
        'flex flex-col gap-6',
        width === 'narrow' && 'w-full max-w-3xl',
        className,
      )}
    >
      {children}
    </section>
  );
}

/**
 * The heading of a page: title, a line under it, badges next to the title and
 * the page's actions. Stacked under `sm`; from `sm` the actions sit at the
 * top end. `level` is 2 when the page sits under another `h1`.
 */
export function PageHeader({
  title,
  description,
  badges,
  actions,
  level = 1,
}: {
  title: ReactNode;
  description?: ReactNode;
  badges?: ReactNode;
  actions?: ReactNode;
  level?: 1 | 2;
}) {
  const Heading = level === 2 ? 'h2' : 'h1';
  return (
    <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <Heading className="text-xl font-medium break-words">{title}</Heading>
          {badges}
        </div>
        {description && (
          <p className="text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {actions && (
        <div className="flex flex-wrap items-center gap-2">{actions}</div>
      )}
    </header>
  );
}

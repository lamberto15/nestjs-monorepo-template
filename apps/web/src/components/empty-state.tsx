import type { ReactNode } from 'react';

/** What a list or section shows when it has nothing yet. */
export function EmptyState({
  title,
  description,
  icon,
  action,
}: {
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div
      role="status"
      className="flex flex-col items-center gap-2 rounded-md border p-8 text-center text-sm text-muted-foreground"
    >
      {icon}
      <p className="font-medium text-foreground">{title}</p>
      {description && <p>{description}</p>}
      {action}
    </div>
  );
}

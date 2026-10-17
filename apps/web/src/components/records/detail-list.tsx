import type { ReactNode } from 'react';

/** A record's fields as a definition list. */
export function DetailList(props: { children: ReactNode }) {
  return (
    <dl className="grid max-w-2xl gap-x-6 gap-y-4 sm:grid-cols-[10rem_1fr]">
      {props.children}
    </dl>
  );
}

/**
 * One field. `undefined` is a field the API left out for this user
 * (field-level permissions: docs/permissions.md): nothing is shown, not even
 * the label. `null` or an empty string is a field without a value: a dash.
 */
export function DetailItem(props: { label: string; value: ReactNode }) {
  if (props.value === undefined) {
    return null;
  }
  const empty = props.value === null || props.value === '';
  return (
    <>
      <dt className="text-sm text-muted-foreground">{props.label}</dt>
      <dd className="min-w-0 text-sm break-words">
        {empty ? <span className="text-muted-foreground">—</span> : props.value}
      </dd>
    </>
  );
}

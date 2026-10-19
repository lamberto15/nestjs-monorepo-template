import type { HeaderContext, RowData } from '@tanstack/react-table';
import type { TFunction } from 'i18next';
import { DataTableColumnHeader } from '@/components/data-table/data-table-column-header';
import type { DataTableFeatures } from '@/lib/data-table-features';
import type { ListColumn, ListDescription, ListField } from '@/lib/list-query';
import { refKinds, type RefSources } from '@/lib/list-refs';

/**
 * Columns the list's own metadata asks for, so a page built on ListPage gets
 * them without declaring them: the active custom fields (`custom.<key>`,
 * docs/custom-fields.md) and the reference fields (`ref`: tags, teams,
 * users), shown by name.
 */

const NONE = '';

function header<TData extends RowData>(label: string) {
  return {
    meta: { label },
    header: ({ column }: HeaderContext<DataTableFeatures, TData, unknown>) => (
      <DataTableColumnHeader column={column} label={label} />
    ),
  };
}

/** A custom value as text; its type came with the field. */
export function customValue(
  value: unknown,
  type: ListField['type'],
  language: string,
  t: TFunction,
): string {
  if (value === null || value === undefined) return NONE;
  if (Array.isArray(value)) {
    return value.map((item) => customValue(item, type, language, t)).join(', ');
  }
  if (typeof value === 'boolean') return t(value ? 'list.yes' : 'list.no');
  if (typeof value === 'number') return value.toLocaleString(language);
  if (typeof value === 'string') {
    if (type === 'date' || type === 'datetime') {
      const date = new Date(value);
      return Number.isNaN(date.getTime())
        ? value
        : new Intl.DateTimeFormat(language, {
            dateStyle: 'medium',
            // A calendar date has no time zone: showing it in the viewer's would shift it.
            ...(type === 'date' && { timeZone: 'UTC' }),
          }).format(date);
    }
    return value;
  }
  return JSON.stringify(value);
}

/**
 * One column per active custom field, read from `row.custom[key]`. They are
 * hidden at first (the list page's view options turn them on), so the
 * `fields=` of the first page stays what it was.
 */
export function customFieldColumns<TData extends RowData>(
  description: ListDescription,
  language: string,
  t: TFunction,
): ListColumn<TData>[] {
  return description.fields
    .filter((field) => field.custom && field.name.startsWith('custom.'))
    .map((field) => {
      const key = field.name.slice('custom.'.length);
      return {
        id: field.name,
        accessorFn: (row: TData) =>
          customValue(
            (row as { custom?: Record<string, unknown> }).custom?.[key],
            field.type,
            language,
            t,
          ),
        ...header<TData>(field.label ?? key),
      } as ListColumn<TData>;
    });
}

/** `ownerId` → "Owner": a field's label when none is translated. */
export function fieldLabel(name: string): string {
  const words = name
    .replace(/Id$/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * A column per reference field (`ref`) the caller declared none for, its
 * values named from `refs` (the id or key itself when unknown):
 * - a field `fields=` may pick (`ownerId`, `teamId`) is a column, hidden at
 *   first (the view options turn it on);
 * - one it may not (`tag`: a filter only) is never shown, never asked for.
 * Only the kinds `refs` has a source for (tag, team, principal).
 */
export function refColumns<TData extends RowData>(
  description: ListDescription,
  refs: RefSources,
  t: TFunction,
): ListColumn<TData>[] {
  const kinds = refKinds(description.fields);
  const selectable = new Set(description.select);
  return description.fields
    .filter((field) => field.ref && kinds.has(field.ref) && !field.custom)
    .map((field) => {
      const label = t(`list.fields.${field.name}`, {
        defaultValue: fieldLabel(field.name),
      });
      if (!selectable.has(field.name)) {
        return {
          id: field.name,
          accessorFn: () => NONE,
          enableHiding: false,
          meta: { label },
        } as ListColumn<TData>;
      }
      const names = new Map(
        (refs[field.ref as string]?.options ?? []).map((o) => [
          o.value,
          o.label,
        ]),
      );
      const name = (value: unknown) =>
        typeof value === 'string' ? (names.get(value) ?? value) : NONE;
      return {
        id: field.name,
        accessorFn: (row: TData) => {
          const value = (row as Record<string, unknown>)[field.name];
          return Array.isArray(value)
            ? value.map(name).join(', ')
            : name(value);
        },
        ...header<TData>(label),
      } as ListColumn<TData>;
    });
}

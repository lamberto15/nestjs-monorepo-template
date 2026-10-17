import type { HeaderContext, RowData } from '@tanstack/react-table';
import type { TFunction } from 'i18next';
import { DataTableColumnHeader } from '@/components/data-table/data-table-column-header';
import type { DataTableFeatures } from '@/lib/data-table-features';
import {
  isTagField,
  type ListColumn,
  type ListDescription,
  type ListField,
} from '@/lib/list-query';

/**
 * Columns the list's own metadata asks for, so a page built on ListPage gets
 * them without declaring them: the active custom fields (`custom.<key>`,
 * docs/custom-fields.md) and the tag filter (`tag`, docs/tags.md).
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

/**
 * The `tag` filter's column when the list has one and the caller declared
 * none: filter only (never shown, `fields=` never names it), the picker's
 * options coming from GET /v1/tags (withListMeta).
 */
export function tagFilterColumns<TData extends RowData>(
  description: ListDescription,
  label: string,
): ListColumn<TData>[] {
  return description.fields.filter(isTagField).map(
    (field) =>
      ({
        id: field.name,
        accessorFn: () => NONE,
        enableHiding: false,
        meta: { label },
      }) as ListColumn<TData>,
  );
}

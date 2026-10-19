import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { DetailItem } from '@/components/records/detail-list';
import { customFieldsQuery, type CustomField } from '@/lib/custom-fields';
import { customValue } from '@/lib/list-columns';
import type { ListField } from '@/lib/list-query';

/** A stored value as text: a choice by its label, the rest as the list shows it. */
function show(
  field: CustomField,
  value: unknown,
  language: string,
  t: (key: string) => string,
) {
  const label = (v: unknown) =>
    field.options?.find((option) => option.value === v)?.label ?? v;
  const shown = Array.isArray(value) ? value.map(label) : label(value);
  return customValue(
    shown,
    field.type as ListField['type'],
    language,
    t as never,
  );
}

/**
 * A record's custom values as detail items (inside a `DetailList`), one per
 * active field, labelled as administrators named them. `values` is the
 * record's `custom`; `undefined` (field-level permissions left it out)
 * shows nothing.
 */
export function CustomFieldValues(props: {
  subject: string;
  values: Record<string, unknown> | undefined;
}) {
  const { t, i18n } = useTranslation();
  const { data } = useQuery({
    ...customFieldsQuery(props.subject),
    meta: { errorToast: false },
  });
  if (!props.values || !data) return null;
  const values = props.values;
  return (
    <>
      {data.map((field) => (
        <DetailItem
          key={field.key}
          label={field.label}
          value={show(field, values[field.key], i18n.language, t)}
        />
      ))}
    </>
  );
}

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SearchCombobox } from '@/components/search-combobox';
import { peopleQuery, type Person } from '@/lib/people';

/**
 * Picks a member of the tenant by searching `GET /v1/people?q=` as one
 * types: Dice UI's combobox, the search done by the API
 * (`manualFiltering`). The value is the person's key (`user:<id>`).
 *
 * Not a mode of PrincipalPicker: that one searches
 * `GET /v1/access/principals` (users and API clients, addresses, inactive
 * ones, ids), which only access managers may read; this one is for pickers
 * any member uses, and the people route gives only a key and a name.
 */
export function PersonPicker(props: {
  id: string;
  label: string;
  value: string;
  onChange: (key: string, person: Person | undefined) => void;
  /** Keys not offered (yourself). */
  exclude?: readonly string[];
  /** What the input shows for the current value before any search. */
  initialLabel?: string;
  placeholder?: string;
  invalid?: boolean;
  /** The ids of the hint and the error the caller shows beside it (`useDescribedBy`). */
  describedBy?: string;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const [term, setTerm] = useState('');
  const found = useQuery({
    ...peopleQuery(term),
    placeholderData: keepPreviousData,
    retry: false,
    meta: { errorToast: false },
  });
  const items = (found.data ?? []).filter(
    (person) => !props.exclude?.includes(person.key),
  );
  const empty = found.isError
    ? t('people.failed')
    : found.isFetching
      ? t('people.searching')
      : t('people.none');

  return (
    <SearchCombobox
      id={props.id}
      label={props.label}
      value={props.value}
      onChange={(value) =>
        props.onChange(
          value,
          items.find((person) => person.key === value),
        )
      }
      onSearch={setTerm}
      items={items.map((person) => ({ value: person.key, name: person.name }))}
      empty={empty}
      initialLabel={props.initialLabel}
      placeholder={props.placeholder ?? t('people.placeholder')}
      invalid={props.invalid}
      describedBy={props.describedBy}
      disabled={props.disabled}
    />
  );
}

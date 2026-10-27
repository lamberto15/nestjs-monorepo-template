import {
  Combobox,
  ComboboxAnchor,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxTrigger,
} from '@nestjs-monorepo-template/ui/components/combobox';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useDebouncedCallback } from '@/hooks/use-debounced-callback';
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
  const [input, setInput] = useState(props.initialLabel ?? '');
  const [term, setTerm] = useState('');
  const search = useDebouncedCallback((next: string) => setTerm(next), 250);
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
    <Combobox
      value={props.value}
      onValueChange={(value) => {
        const person = items.find((p) => p.key === value);
        if (person) {
          setInput(person.name);
        }
        props.onChange(value, person);
      }}
      inputValue={input}
      onInputValueChange={(next) => {
        setInput(next);
        search(next);
      }}
      manualFiltering
      openOnFocus
      disabled={props.disabled}
    >
      <ComboboxAnchor>
        <ComboboxInput
          id={props.id}
          aria-label={props.label}
          aria-invalid={props.invalid}
          aria-describedby={props.describedBy}
          placeholder={props.placeholder ?? t('people.placeholder')}
        />
        <ComboboxTrigger />
      </ComboboxAnchor>
      <ComboboxContent>
        <ComboboxEmpty keepVisible={items.length === 0}>{empty}</ComboboxEmpty>
        {items.map((person) => (
          <ComboboxItem key={person.key} value={person.key} label={person.name}>
            {person.name}
          </ComboboxItem>
        ))}
      </ComboboxContent>
    </Combobox>
  );
}

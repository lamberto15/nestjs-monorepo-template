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
import { searchRecords } from './panels/api';

/** A record as a picker names it: its title field, its number, else its id. */
export function recordName(
  item: Record<string, unknown>,
  title: string | null,
) {
  return (
    (title ? (item[title] as string | null | undefined) : null) ??
    (item.number as string | null | undefined) ??
    (item.id as string)
  );
}

/**
 * A form's control for a reference (a `ref` field: docs/adding-a-feature.md,
 * "Relationships"): picks a record of the target's list by searching it as
 * one types (`GET /v1/<path>?q=`, PICKER_LIMIT at a time), Dice UI's
 * combobox with the search done by the API (`manualFiltering`), as
 * PersonPicker. The list offers only the records the user may read, so the
 * API takes what is picked; the value is the record's id.
 */
export function RecordPicker(props: {
  id: string;
  label: string;
  /** The target's list under /v1 (`test-items`). */
  path: string;
  /** The field a record is named by (`title`); null: its number or id. */
  title: string | null;
  value: string;
  onChange: (id: string) => void;
  /** What the input shows for the current value before any search. */
  initialLabel?: string;
  placeholder?: string;
  invalid?: boolean;
  /** The ids of the hint and the error the caller shows beside it (`useDescribedBy`). */
  describedBy?: string;
  disabled?: boolean;
}) {
  const { t } = useTranslation('records');
  const [input, setInput] = useState(props.initialLabel ?? '');
  const [term, setTerm] = useState('');
  const search = useDebouncedCallback((next: string) => setTerm(next), 250);
  const found = useQuery({
    queryKey: ['record-picker', props.path, term.trim()],
    queryFn: () => searchRecords(props.path, term),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
    retry: false,
    meta: { errorToast: false },
  });
  const items = (found.data?.items ?? []).map((item) => ({
    id: item.id as string,
    name: recordName(item, props.title),
  }));
  const empty = found.isError
    ? t('picker.failed')
    : found.isFetching
      ? t('picker.searching')
      : t('picker.none');

  return (
    <Combobox
      value={props.value}
      onValueChange={(value) => {
        const item = items.find((candidate) => candidate.id === value);
        if (item) {
          setInput(item.name);
        }
        props.onChange(value);
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
          placeholder={props.placeholder ?? t('picker.placeholder')}
        />
        <ComboboxTrigger />
      </ComboboxAnchor>
      <ComboboxContent>
        <ComboboxEmpty keepVisible={items.length === 0}>{empty}</ComboboxEmpty>
        {items.map((item) => (
          <ComboboxItem key={item.id} value={item.id} label={item.name}>
            {item.name}
          </ComboboxItem>
        ))}
      </ComboboxContent>
    </Combobox>
  );
}

import {
  Combobox,
  ComboboxAnchor,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxTrigger,
} from '@nestjs-monorepo-template/ui/components/combobox';
import { useState } from 'react';
import { useDebouncedCallback } from '@/hooks/use-debounced-callback';

/**
 * Dice UI's combobox searched by the API as one types (`manualFiltering`):
 * the picker shared by PersonPicker and RecordPicker, which supply the
 * search (`onSearch`, debounced) and its results.
 */
export function SearchCombobox(props: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  onSearch: (term: string) => void;
  items: readonly { value: string; name: string }[];
  /** What the list shows when it offers nothing (searching, failed, no match). */
  empty: string;
  /** What the input shows for the current value before any search. */
  initialLabel?: string;
  placeholder: string;
  invalid?: boolean;
  /** The ids of the hint and the error the caller shows beside it (`useDescribedBy`). */
  describedBy?: string;
  disabled?: boolean;
}) {
  const [input, setInput] = useState(props.initialLabel ?? '');
  const search = useDebouncedCallback(props.onSearch, 250);

  return (
    <Combobox
      value={props.value}
      onValueChange={(value) => {
        const item = props.items.find((candidate) => candidate.value === value);
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
          placeholder={props.placeholder}
        />
        <ComboboxTrigger />
      </ComboboxAnchor>
      <ComboboxContent>
        <ComboboxEmpty keepVisible={props.items.length === 0}>
          {props.empty}
        </ComboboxEmpty>
        {props.items.map((item) => (
          <ComboboxItem key={item.value} value={item.value} label={item.name}>
            {item.name}
          </ComboboxItem>
        ))}
      </ComboboxContent>
    </Combobox>
  );
}

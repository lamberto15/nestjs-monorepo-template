import {
  Field,
  FieldLabel,
} from '@nestjs-monorepo-template/ui/components/field';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@nestjs-monorepo-template/ui/components/select';

export type Option = { value: string; label: string };

// Select items cannot have an empty value, so "none" is a sentinel.
const NONE = '__none';

/** A labelled shadcn Select over a list of options; `empty` adds a "none" entry. */
export function OptionSelect(props: {
  id: string;
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  options: Option[];
  empty?: string;
  disabled?: boolean;
}) {
  const items = props.empty
    ? [{ value: NONE, label: props.empty }, ...props.options]
    : props.options;
  return (
    <Field>
      <FieldLabel htmlFor={props.id}>{props.label}</FieldLabel>
      <Select
        items={items}
        value={props.value || (props.empty ? NONE : '')}
        disabled={props.disabled}
        onValueChange={(value) =>
          props.onValueChange(value === NONE ? '' : (value ?? ''))
        }
      >
        <SelectTrigger id={props.id} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}

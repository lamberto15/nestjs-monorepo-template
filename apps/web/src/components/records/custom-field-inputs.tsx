import { Checkbox } from '@nestjs-monorepo-template/ui/components/checkbox';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '@nestjs-monorepo-template/ui/components/field';
import { Input } from '@nestjs-monorepo-template/ui/components/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@nestjs-monorepo-template/ui/components/select';
import { Switch } from '@nestjs-monorepo-template/ui/components/switch';
import { Textarea } from '@nestjs-monorepo-template/ui/components/textarea';
import { useTranslation } from 'react-i18next';
import type { CustomField } from '@/lib/custom-fields';
import type { CustomDraft, CustomDrafts } from '@/lib/custom-values';

/**
 * The inputs of a subject's active custom fields (docs/custom-fields.md),
 * one per definition: typed (text, long text, number, switch, date, select,
 * multi-select, email, url) and labelled as the administrators named them.
 * Controlled: the caller holds the drafts (lib/custom-values.ts), runs
 * `draftErrors` on submit and passes the messages back as `errors`.
 */
export function CustomFieldInputs(props: {
  fields: readonly CustomField[];
  value: CustomDrafts;
  onChange: (key: string, draft: CustomDraft) => void;
  errors?: Record<string, string>;
}) {
  if (props.fields.length === 0) return null;
  return (
    <>
      {props.fields.map((field) => (
        <CustomFieldInput
          key={field.key}
          field={field}
          draft={props.value[field.key]}
          onChange={(draft) => props.onChange(field.key, draft)}
          error={props.errors?.[field.key]}
        />
      ))}
    </>
  );
}

function CustomFieldInput(props: {
  field: CustomField;
  draft: CustomDraft;
  onChange: (draft: CustomDraft) => void;
  error?: string;
}) {
  const { field, draft, error } = props;
  const id = `custom-${field.key}`;
  const invalid = !!error;
  const label = field.label;
  const description = field.description ?? undefined;
  const messages = error ? [{ message: error }] : undefined;

  if (field.type === 'multiSelect') {
    const chosen = Array.isArray(draft) ? draft : [];
    return (
      <FieldSet data-invalid={invalid}>
        <FieldLegend variant="label">
          {label}
          {field.required ? ' *' : ''}
        </FieldLegend>
        {description && <FieldDescription>{description}</FieldDescription>}
        <div className="flex flex-col gap-2">
          {(field.options ?? []).map((option) => (
            <Field key={option.value} orientation="horizontal">
              <Checkbox
                id={`${id}-${option.value}`}
                checked={chosen.includes(option.value)}
                aria-invalid={invalid}
                onCheckedChange={(checked) =>
                  props.onChange(
                    checked
                      ? [...chosen, option.value]
                      : chosen.filter((value) => value !== option.value),
                  )
                }
              />
              <FieldLabel htmlFor={`${id}-${option.value}`}>
                {option.label}
              </FieldLabel>
            </Field>
          ))}
        </div>
        {invalid && <FieldError errors={messages} />}
      </FieldSet>
    );
  }

  if (field.type === 'boolean') {
    return (
      <Field orientation="horizontal" data-invalid={invalid}>
        <Switch
          id={id}
          checked={draft === true}
          aria-invalid={invalid}
          onCheckedChange={(checked) => props.onChange(checked)}
        />
        <FieldLabel htmlFor={id}>
          {label}
          {field.required ? ' *' : ''}
        </FieldLabel>
        {description && <FieldDescription>{description}</FieldDescription>}
        {invalid && <FieldError errors={messages} />}
      </Field>
    );
  }

  return (
    <Field data-invalid={invalid}>
      <FieldLabel htmlFor={id}>
        {label}
        {field.required ? ' *' : ''}
      </FieldLabel>
      {field.type === 'select' ? (
        <SelectInput
          id={id}
          field={field}
          value={typeof draft === 'string' ? draft : ''}
          invalid={invalid}
          onChange={props.onChange}
        />
      ) : field.type === 'longText' ? (
        <Textarea
          id={id}
          rows={4}
          value={typeof draft === 'string' ? draft : ''}
          aria-invalid={invalid}
          onChange={(event) => props.onChange(event.target.value)}
        />
      ) : (
        <Input
          id={id}
          type={inputType[field.type] ?? 'text'}
          step={field.type === 'number' ? 'any' : undefined}
          value={typeof draft === 'string' ? draft : ''}
          aria-invalid={invalid}
          onChange={(event) => props.onChange(event.target.value)}
        />
      )}
      {description && <FieldDescription>{description}</FieldDescription>}
      {invalid && <FieldError errors={messages} />}
    </Field>
  );
}

const inputType: Partial<Record<CustomField['type'], string>> = {
  number: 'number',
  // Its value is the API's `YYYY-MM-DD`, with no time zone.
  date: 'date',
  email: 'email',
  url: 'url',
};

/** One of the options; an optional field can be cleared with the first item. */
function SelectInput(props: {
  id: string;
  field: CustomField;
  value: string;
  invalid: boolean;
  onChange: (draft: CustomDraft) => void;
}) {
  const { t } = useTranslation('records');
  const options = [
    ...(props.field.required
      ? []
      : [{ value: NONE, label: t('customFields.none') }]),
    ...(props.field.options ?? []),
  ];
  return (
    <Select
      items={options}
      value={props.value || (props.field.required ? null : NONE)}
      onValueChange={(next) =>
        props.onChange(next === NONE ? '' : (next ?? ''))
      }
    >
      <SelectTrigger
        id={props.id}
        className="w-full"
        aria-invalid={props.invalid}
      >
        <SelectValue placeholder={t('customFields.choose')} />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

const NONE = '__none__';

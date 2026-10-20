import { Button } from '@nestjs-monorepo-template/ui/components/button';
import {
  Field,
  FieldDescription,
  FieldLabel,
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
import {
  TagsInput,
  TagsInputInput,
  TagsInputItem,
  TagsInputLabel,
  TagsInputList,
} from '@nestjs-monorepo-template/ui/components/tags-input';
import { PlusIcon, Trash2Icon } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  initialOf,
  looseFromText,
  looseToText,
  paramKind,
  type JsonSchema,
  type TypeKind,
  type TypeOption,
  type Typed,
} from './policy-draft';

/** One of a few values: shadcn's Select (Base UI), as `lib/form.tsx`'s SelectField is for forms. */
export function OptionSelect(props: {
  id: string;
  label: ReactNode;
  value: string;
  options: readonly { value: string; label: string }[];
  onChange: (value: string) => void;
  className?: string;
}) {
  return (
    <Field className={props.className}>
      <FieldLabel htmlFor={props.id}>{props.label}</FieldLabel>
      <Select
        items={props.options}
        value={props.value}
        onValueChange={(next) => next && props.onChange(next)}
      >
        <SelectTrigger id={props.id} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {props.options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}

/**
 * One use of a registered type (an approver rule, a stage mode, a
 * condition): the type to pick from `GET /v1/approvals/policy-types`, and
 * the parameters that type takes, as its JSON Schema describes them. A type
 * a project registers shows up here with no change to the page.
 */
export function TypedEditor(props: {
  kind: TypeKind;
  options: readonly TypeOption[];
  value: Typed;
  onChange: (next: Typed) => void;
  /** The group's name and the type select's label: "Approver 1". */
  label: string;
  onRemove?: () => void;
  /** The type takes no parameters here (a combinator's are its children). */
  hideParams?: boolean;
  children?: ReactNode;
}) {
  const { t } = useTranslation('approvals');
  const id = useId();
  const { options, value } = props;
  const typeLabel = (option: TypeOption) =>
    t(`policies.types.${props.kind}.${option.type}`, {
      defaultValue: option.label,
    });
  const known = options.find((option) => option.type === value.type);
  const choices = [
    ...options.map((option) => ({
      value: option.type,
      label: typeLabel(option),
    })),
    // A type no longer registered stays what it is until the user changes it.
    ...(known ? [] : [{ value: value.type, label: value.type }]),
  ];
  return (
    <div
      role="group"
      aria-label={props.label}
      className="flex flex-col gap-3 rounded-md border bg-card p-3"
    >
      <div className="flex items-end gap-2">
        <OptionSelect
          id={`${id}-type`}
          className="min-w-0 flex-1"
          label={props.label}
          value={value.type}
          options={choices}
          onChange={(type) => {
            const option = options.find((entry) => entry.type === type);
            if (option) props.onChange(initialOf(option));
          }}
        />
        {props.onRemove && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t('policies.remove', { label: props.label })}
            onClick={props.onRemove}
          >
            <Trash2Icon />
          </Button>
        )}
      </div>
      {!props.hideParams && known && (
        <ParamsEditor
          id={id}
          type={value.type}
          schema={known.params as JsonSchema}
          value={value.params}
          onChange={(params) => props.onChange({ ...value, params })}
        />
      )}
      {props.children}
    </div>
  );
}

/** A type's parameters: a field for each property of its JSON Schema. */
function ParamsEditor(props: {
  id: string;
  type: string;
  schema: JsonSchema;
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const properties = Object.entries(props.schema.properties ?? {});
  if (properties.length === 0) {
    return null;
  }
  const set = (name: string, next: unknown) => {
    const { [name]: _old, ...rest } = props.value;
    props.onChange(next === undefined ? rest : { ...rest, [name]: next });
  };
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {properties.map(([name, schema]) => (
        <ParamField
          key={`${props.type}.${name}`}
          id={`${props.id}-${name}`}
          name={name}
          schema={schema}
          value={props.value[name]}
          onChange={(next) => set(name, next)}
        />
      ))}
    </div>
  );
}

function ParamField(props: {
  id: string;
  name: string;
  schema: JsonSchema;
  value: unknown;
  onChange: (next: unknown) => void;
}) {
  const { t } = useTranslation('approvals');
  const { id, name, schema, value } = props;
  const label = t(`policies.params.${name}`, { defaultValue: name });
  const hint = t(`policies.paramHints.${name}`, { defaultValue: '' });
  switch (paramKind(schema)) {
    case 'enum':
      return (
        <OptionSelect
          id={id}
          label={label}
          value={typeof value === 'string' ? value : ''}
          options={(schema.enum as string[]).map((option) => ({
            value: option,
            label: t(`policies.enums.${name}.${option}`, {
              defaultValue: option,
            }),
          }))}
          onChange={props.onChange}
        />
      );
    case 'boolean':
      return (
        <Field orientation="horizontal">
          <Switch
            id={id}
            checked={value === true}
            onCheckedChange={(checked) => props.onChange(checked)}
          />
          <FieldLabel htmlFor={id}>{label}</FieldLabel>
        </Field>
      );
    case 'string':
      return (
        <Field>
          <FieldLabel htmlFor={id}>{label}</FieldLabel>
          <Input
            id={id}
            value={typeof value === 'string' ? value : ''}
            maxLength={schema.maxLength}
            onChange={(event) => props.onChange(event.target.value)}
          />
          {hint && <FieldDescription>{hint}</FieldDescription>}
        </Field>
      );
    case 'number':
      return (
        <Field>
          <FieldLabel htmlFor={id}>{label}</FieldLabel>
          <Input
            id={id}
            type="number"
            min={schema.minimum}
            max={schema.maximum}
            value={typeof value === 'number' ? String(value) : ''}
            onChange={(event) =>
              props.onChange(
                event.target.value === ''
                  ? undefined
                  : Number(event.target.value),
              )
            }
          />
          {hint && <FieldDescription>{hint}</FieldDescription>}
        </Field>
      );
    case 'list':
      return (
        <Field className="sm:col-span-2">
          {/* Dice UI's tags-input: one entry per tag, pasted lists split. */}
          <TagsInput
            className="w-full"
            value={Array.isArray(value) ? (value as string[]) : []}
            onValueChange={(next) => props.onChange(next)}
            addOnPaste
            blurBehavior="add"
            delimiter=","
          >
            <TagsInputLabel>{label}</TagsInputLabel>
            <TagsInputList>
              {(Array.isArray(value) ? (value as string[]) : []).map(
                (entry) => (
                  <TagsInputItem key={entry} value={entry}>
                    {entry}
                  </TagsInputItem>
                ),
              )}
              <TagsInputInput />
            </TagsInputList>
          </TagsInput>
          {hint && <FieldDescription>{hint}</FieldDescription>}
        </Field>
      );
    case 'json':
      return (
        <JsonField
          id={id}
          label={label}
          hint={hint}
          value={value}
          // A schema with no type at all is "any value": text, or JSON when it parses.
          loose={schema.type === undefined && !schema.properties}
          onChange={props.onChange}
        />
      );
  }
}

/** A value of any shape, typed as JSON (`1000`, `["a","b"]`); `loose` also takes plain text as a string. */
function JsonField(props: {
  id: string;
  label: string;
  hint: string;
  value: unknown;
  loose: boolean;
  onChange: (next: unknown) => void;
}) {
  const { t } = useTranslation('approvals');
  const [text, setText] = useState(looseToText(props.value));
  const [invalid, setInvalid] = useState(false);
  return (
    <Field data-invalid={invalid}>
      <FieldLabel htmlFor={props.id}>{props.label}</FieldLabel>
      <Input
        id={props.id}
        value={text}
        aria-invalid={invalid}
        onChange={(event) => {
          const next = event.target.value;
          setText(next);
          if (props.loose) {
            props.onChange(looseFromText(next));
            return;
          }
          try {
            props.onChange(next.trim() === '' ? undefined : JSON.parse(next));
            setInvalid(false);
          } catch {
            setInvalid(true);
          }
        }}
      />
      {invalid ? (
        <FieldDescription role="alert" className="text-destructive">
          {t('policies.invalidJson')}
        </FieldDescription>
      ) : (
        props.hint && <FieldDescription>{props.hint}</FieldDescription>
      )}
    </Field>
  );
}

/** A list of uses of one kind of type (the approvers of a stage), at least `min` of them. */
export function TypedList(props: {
  kind: TypeKind;
  options: readonly TypeOption[];
  value: Typed[];
  onChange: (next: Typed[]) => void;
  /** "Approver": each is "Approver 1", "Approver 2"… */
  itemLabel: string;
  addLabel: string;
  min?: number;
}) {
  const first = props.options[0];
  const min = props.min ?? 1;
  return (
    <div className="flex flex-col gap-2">
      {props.value.map((entry, index) => (
        <TypedEditor
          // The list is edited in place and only ever grows or shrinks at a
          // chosen index, so the position is the identity.
          key={index}
          kind={props.kind}
          options={props.options}
          value={entry}
          label={`${props.itemLabel} ${index + 1}`}
          onChange={(next) =>
            props.onChange(props.value.map((e, i) => (i === index ? next : e)))
          }
          onRemove={
            props.value.length > min
              ? () => props.onChange(props.value.filter((_, i) => i !== index))
              : undefined
          }
        />
      ))}
      {first && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="self-start"
          onClick={() => props.onChange([...props.value, initialOf(first)])}
        >
          <PlusIcon />
          {props.addLabel}
        </Button>
      )}
    </div>
  );
}

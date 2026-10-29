import { Badge } from '@nestjs-monorepo-template/ui/components/badge';
import { Button } from '@nestjs-monorepo-template/ui/components/button';
import { Checkbox } from '@nestjs-monorepo-template/ui/components/checkbox';
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
import { Skeleton } from '@nestjs-monorepo-template/ui/components/skeleton';
import {
  Sortable,
  SortableContent,
  SortableItem,
  SortableItemHandle,
} from '@nestjs-monorepo-template/ui/components/sortable';
import { Textarea } from '@nestjs-monorepo-template/ui/components/textarea';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { GripVerticalIcon, PlusIcon, TrashIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Page, PageHeader } from '@/components/page-header';
import { useSortableProps } from '@/lib/sortable';
import {
  CHOICE_TYPES,
  draftQuery,
  errorsByPath,
  FIELD_TYPES,
  type FieldType,
  type FormDefinition,
  type FormField,
  formQuery,
  type GroupField,
  optionSourcesQuery,
  usePublish,
  useSaveDraft,
} from './api';
import {
  type AnswerDrafts,
  FormRenderer,
  GROUP_ITEMS_LIMIT,
  initialDrafts,
} from './form-renderer';
import { RuleEditor } from './rule-editor';

/** A section or field as the builder edits it: a stable id while its key changes. */
type Item<T> = { uid: string; value: T };
/** A field, a group's own fields (`fields`) as items of their own. */
type BuilderField = Item<FormField> & { fields: Item<GroupField>[] };
type BuilderSection = Item<
  Omit<FormDefinition['sections'][number], 'fields'>
> & {
  fields: BuilderField[];
};

let counter = 0;
const uid = () => `item-${++counter}`;

const toBuilderField = (field: FormField): BuilderField => ({
  uid: uid(),
  value: field,
  fields: (field.fields ?? []).map((sub) => ({ uid: uid(), value: sub })),
});

const toBuilder = (definition: FormDefinition): BuilderSection[] =>
  definition.sections.map(({ fields, ...section }) => ({
    uid: uid(),
    value: section,
    fields: fields.map(toBuilderField),
  }));

/** Saved as the latest format (4: option sources), which reads every earlier draft as it was. */
const toDefinition = (sections: BuilderSection[]): FormDefinition => ({
  format: 4,
  sections: sections.map((section) => ({
    ...section.value,
    fields: section.fields.map((field) =>
      field.value.type === 'group'
        ? { ...field.value, fields: field.fields.map((sub) => sub.value) }
        : field.value,
    ),
  })),
});

/** A new field of a type: a fresh key, its type as its label, two options for a choice, one field in a group. */
function newField(
  type: FieldType,
  key: string,
  label: (type: FieldType) => string,
): FormField {
  return {
    key,
    type,
    label: label(type),
    ...(CHOICE_TYPES.includes(type) && {
      options: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
      ],
    }),
    ...(type === 'group' && {
      fields: [{ key: 'item_1', type: 'text', label: label('text') }],
    }),
  };
}

/** A key no field of the form has yet: `field_<n>`. */
function freshKey(prefix: string, taken: readonly string[]) {
  for (let n = taken.length + 1; ; n++) {
    const key = `${prefix}_${n}`;
    if (!taken.includes(key)) return key;
  }
}

/** Options as lines `value = Label` (or just `value`): what an editor types. */
const optionsText = (field: FormField) =>
  (field.options ?? [])
    .map((o) => (o.label === o.value ? o.value : `${o.value} = ${o.label}`))
    .join('\n');
const parseOptions = (text: string) =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [value = '', ...rest] = line.split('=');
      const label = rest.join('=').trim();
      return { value: value.trim(), label: label || value.trim() };
    });

/**
 * A form's builder (docs/forms.md): its sections and their fields, each
 * field's type, key, label, help, required and options; fields reordered by
 * drag and drop (or the keyboard), a live preview beside them. Saving sends
 * the whole draft under the revision it was read at (409 form_conflict when
 * another editor saved since); the server's checks come back at their paths.
 * Publishing makes the saved draft the next version.
 */
export function FormBuilder(props: { formId: string }) {
  const { t } = useTranslation('forms');
  const form = useQuery(formQuery(props.formId));
  const draft = useQuery(draftQuery(props.formId));
  if (form.isPending || draft.isPending) {
    return <Skeleton className="h-64 w-full" aria-busy />;
  }
  if (form.isError || draft.isError) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {t('error')}
      </p>
    );
  }
  return <Builder form={form.data} draft={draft.data} />;
}

/** The builder of a loaded draft: its state starts from it, and is the editor's. */
function Builder(props: {
  form: { id: string; name: string; publishedVersion: number | null };
  draft: { revision: number; definition: FormDefinition };
}) {
  const { t } = useTranslation('forms');
  const save = useSaveDraft(props.form.id);
  const publish = usePublish(props.form.id);
  const [sections, setSections] = useState(() =>
    toBuilder(props.draft.definition),
  );
  const [revision, setRevision] = useState(props.draft.revision);
  const [dirty, setDirty] = useState(false);
  const [preview, setPreview] = useState<AnswerDrafts>({});
  const form = { data: props.form };

  const definition = toDefinition(sections);
  const keys = sections.flatMap((s) => s.fields.map((f) => f.value.key));
  const errors = errorsByPath(save.error ?? publish.error);
  const conflict =
    (save.error as { code?: string } | null)?.code === 'form_conflict' ||
    (publish.error as { code?: string } | null)?.code === 'form_conflict';

  const change = (next: BuilderSection[]) => {
    setSections(next);
    setDirty(true);
  };
  const changeSection = (index: number, next: BuilderSection) =>
    change(sections.map((s, i) => (i === index ? next : s)));

  return (
    <Page>
      <PageHeader
        title={form.data.name}
        description={t('builder.description')}
        badges={
          form.data.publishedVersion !== null && (
            <Badge variant="secondary">
              {t('versionN', { version: form.data.publishedVersion })}
            </Badge>
          )
        }
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" render={<Link to="/forms" />}>
              {t('back')}
            </Button>
            <Button
              disabled={!dirty || save.isPending}
              onClick={() =>
                save.mutate(
                  { revision, definition },
                  {
                    onSuccess: (saved) => {
                      setRevision(saved.revision);
                      setDirty(false);
                      toast.success(t('builder.saved'));
                    },
                  },
                )
              }
            >
              {t('builder.save')}
            </Button>
            <Button
              variant="secondary"
              disabled={dirty || publish.isPending || keys.length === 0}
              onClick={() =>
                publish.mutate(revision, {
                  onSuccess: (version) =>
                    toast.success(
                      t('builder.published', { version: version.version }),
                    ),
                })
              }
            >
              {t('builder.publish')}
            </Button>
          </div>
        }
      />
      {conflict && (
        <p role="alert" className="text-sm text-destructive">
          {t('builder.conflict')}
        </p>
      )}
      {(publish.error as { code?: string } | null)?.code ===
        'form_unchanged' && (
        <p role="status" className="text-sm text-muted-foreground">
          {t('builder.unchanged')}
        </p>
      )}
      {Object.keys(errors).length > 0 && (
        <div role="alert" className="text-sm text-destructive">
          <p>{t('builder.invalid')}</p>
          <ul className="ms-4 list-disc">
            {Object.entries(errors).map(([path, message]) => (
              <li key={path}>
                <code>{path}</code>: {message}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="flex flex-col gap-6">
          {sections.map((section, index) => (
            <SectionEditor
              key={section.uid}
              section={section}
              before={sections
                .slice(0, index)
                .flatMap((s) => s.fields.map((f) => f.value))}
              keys={keys}
              onChange={(next) => changeSection(index, next)}
              onRemove={() => change(sections.filter((_, i) => i !== index))}
            />
          ))}
          <Button
            variant="outline"
            onClick={() =>
              change([
                ...sections,
                {
                  uid: uid(),
                  value: {
                    key: freshKey(
                      'section',
                      sections.map((s) => s.value.key),
                    ),
                    title: t('builder.newSection'),
                  },
                  fields: [],
                },
              ])
            }
          >
            <PlusIcon />
            {t('builder.addSection')}
          </Button>
        </div>
        <section
          aria-label={t('builder.preview')}
          className="flex flex-col gap-4 rounded-lg border p-4"
        >
          <h2 className="text-sm font-medium text-muted-foreground">
            {t('builder.preview')}
          </h2>
          <FormRenderer
            idPrefix="preview"
            definition={definition}
            value={{ ...initialDrafts(definition), ...preview }}
            onChange={(key, value) => setPreview({ ...preview, [key]: value })}
          />
        </section>
      </div>
    </Page>
  );
}

function SectionEditor(props: {
  section: BuilderSection;
  /** The fields of the sections before: what its conditions may read. */
  before: readonly FormField[];
  keys: readonly string[];
  onChange: (section: BuilderSection) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation('forms');
  const { section } = props;
  const sortable = useSortableProps(
    section.fields.length,
    (id) => section.fields.find((f) => f.uid === id)?.value.label ?? String(id),
  );
  const title = section.value.title ?? section.value.key;
  const setFields = (fields: BuilderField[]) =>
    props.onChange({ ...section, fields });

  return (
    <section
      aria-label={t('builder.section', { title })}
      className="flex flex-col gap-3 rounded-lg border p-4"
    >
      <div className="flex items-end gap-2">
        <Field className="flex-1">
          <FieldLabel htmlFor={`${section.uid}-title`}>
            {t('builder.sectionTitle')}
          </FieldLabel>
          <Input
            id={`${section.uid}-title`}
            value={section.value.title ?? ''}
            maxLength={200}
            onChange={(event) =>
              props.onChange({
                ...section,
                value: {
                  ...section.value,
                  title: event.target.value || undefined,
                },
              })
            }
          />
        </Field>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t('builder.removeSection', { title })}
          onClick={props.onRemove}
        >
          <TrashIcon />
        </Button>
      </div>
      <Field orientation="horizontal">
        <Checkbox
          id={`${section.uid}-page`}
          checked={section.value.startsPage === true}
          onCheckedChange={(checked) =>
            props.onChange({
              ...section,
              value: {
                ...section.value,
                startsPage: checked === true || undefined,
              },
            })
          }
        />
        <FieldLabel htmlFor={`${section.uid}-page`}>
          {t('builder.startsPage')}
        </FieldLabel>
      </Field>
      <RuleEditor
        id={`${section.uid}-visible`}
        label={t('rules.sectionVisibleWhen')}
        condition={section.value.visibleWhen}
        earlier={props.before}
        onChange={(visibleWhen) =>
          props.onChange({
            ...section,
            value: { ...section.value, visibleWhen },
          })
        }
      />
      <Sortable
        {...sortable}
        value={section.fields}
        getItemValue={(field) => field.uid}
        onValueChange={setFields}
      >
        <SortableContent
          render={
            <ul
              aria-label={t('builder.fields', { title })}
              className="flex flex-col gap-2"
            />
          }
        >
          {section.fields.map((field, index) => (
            <SortableItem
              key={field.uid}
              value={field.uid}
              render={
                <li className="flex gap-2 rounded-md border bg-card p-2" />
              }
            >
              <SortableItemHandle
                aria-label={t('builder.reorder', { label: field.value.label })}
                render={
                  <Button variant="ghost" size="icon" className="shrink-0" />
                }
              >
                <GripVerticalIcon />
              </SortableItemHandle>
              <FieldEditor
                field={field.value}
                uid={field.uid}
                groupFields={field.fields}
                onGroupFields={(fields) =>
                  setFields(
                    section.fields.map((f, i) =>
                      i === index ? { ...f, fields } : f,
                    ),
                  )
                }
                keys={props.keys}
                earlier={[
                  ...props.before,
                  ...section.fields.slice(0, index).map((f) => f.value),
                ]}
                onChange={(value) =>
                  setFields(
                    section.fields.map((f, i) =>
                      i === index ? { ...f, value } : f,
                    ),
                  )
                }
                onRemove={() =>
                  setFields(section.fields.filter((_, i) => i !== index))
                }
              />
            </SortableItem>
          ))}
        </SortableContent>
      </Sortable>
      <AddField
        id={`${section.uid}-type`}
        types={FIELD_TYPES}
        onAdd={(type) =>
          setFields([
            ...section.fields,
            toBuilderField(
              newField(type, freshKey('field', props.keys), (value) =>
                t(`types.${value}`),
              ),
            ),
          ])
        }
      />
    </section>
  );
}

/** Where a choice field's choices come from: listed here, or an option source the server offers. */
function SourcePicker(props: {
  id: string;
  value: string | undefined;
  onChange: (provider: string | undefined) => void;
}) {
  const { t } = useTranslation('forms');
  const sources = useQuery(optionSourcesQuery);
  const items = [
    { value: LISTED, label: t('builder.listedHere') },
    ...(sources.data?.items ?? []).map((source) => ({
      value: source.key,
      label: source.label,
    })),
  ];
  return (
    <Field className="sm:col-span-2">
      <FieldLabel htmlFor={props.id}>{t('builder.choicesFrom')}</FieldLabel>
      <Select
        items={items}
        value={props.value ?? LISTED}
        onValueChange={(value) =>
          props.onChange(value === LISTED || value === null ? undefined : value)
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
      {props.value && (
        <FieldDescription>{t('builder.sourceHint')}</FieldDescription>
      )}
    </Field>
  );
}

/** The "listed here" choice of SourcePicker. */
const LISTED = '__listed';

/** A new field's type, and the button that adds it. */
function AddField(props: {
  id: string;
  types: readonly FieldType[];
  label?: string;
  onAdd: (type: FieldType) => void;
}) {
  const { t } = useTranslation('forms');
  const [type, setType] = useState<FieldType>('text');
  return (
    <div className="flex items-end gap-2">
      <Field className="flex-1">
        <FieldLabel htmlFor={props.id}>{t('builder.newFieldType')}</FieldLabel>
        <Select
          items={props.types.map((value) => ({
            value,
            label: t(`types.${value}`),
          }))}
          value={type}
          onValueChange={(value) => value && setType(value as FieldType)}
        >
          <SelectTrigger id={props.id} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {props.types.map((value) => (
              <SelectItem key={value} value={value}>
                {t(`types.${value}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Button variant="outline" onClick={() => props.onAdd(type)}>
        <PlusIcon />
        {props.label ?? t('builder.addField')}
      </Button>
    </div>
  );
}

/**
 * A group's own fields (one level: no group, no conditions in them) and
 * its bounds: `minItems`, `maxItems`, at most GROUP_ITEMS_LIMIT.
 */
function GroupEditor(props: {
  field: FormField;
  uid: string;
  fields: Item<GroupField>[];
  onChange: (field: FormField) => void;
  onFields: (fields: Item<GroupField>[]) => void;
}) {
  const { t } = useTranslation('forms');
  const { field, uid: id } = props;
  const keys = props.fields.map((sub) => sub.value.key);
  const bound = (name: 'minItems' | 'maxItems', text: string) => {
    const validation = {
      ...field.validation,
      [name]: text === '' ? undefined : Number(text),
    };
    props.onChange({ ...field, validation });
  };
  return (
    <div className="flex flex-col gap-3 sm:col-span-2">
      <div className="grid gap-2 sm:grid-cols-2">
        {(['minItems', 'maxItems'] as const).map((name) => (
          <Field key={name}>
            <FieldLabel htmlFor={`${id}-${name}`}>
              {t(`builder.${name}`)}
            </FieldLabel>
            <Input
              id={`${id}-${name}`}
              type="number"
              min={name === 'minItems' ? 0 : 1}
              max={GROUP_ITEMS_LIMIT}
              value={field.validation?.[name] ?? ''}
              onChange={(event) => bound(name, event.target.value)}
            />
          </Field>
        ))}
      </div>
      <ul
        aria-label={t('builder.groupFields', { label: field.label })}
        className="flex flex-col gap-2 border-s-2 ps-3"
      >
        {props.fields.map((sub, index) => (
          <li key={sub.uid}>
            <FieldEditor
              field={sub.value}
              uid={sub.uid}
              keys={keys}
              earlier={[]}
              nested
              onChange={(value) =>
                props.onFields(
                  props.fields.map((other, i) =>
                    i === index
                      ? { ...other, value: value as GroupField }
                      : other,
                  ),
                )
              }
              onRemove={() =>
                props.onFields(props.fields.filter((_, i) => i !== index))
              }
            />
          </li>
        ))}
      </ul>
      <AddField
        id={`${id}-group-type`}
        types={FIELD_TYPES.filter((type) => type !== 'group')}
        label={t('builder.addGroupField')}
        onAdd={(type) =>
          props.onFields([
            ...props.fields,
            {
              uid: uid(),
              value: newField(type, freshKey('item', keys), (value) =>
                t(`types.${value}`),
              ) as GroupField,
            },
          ])
        }
      />
    </div>
  );
}

function FieldEditor(props: {
  field: FormField;
  uid: string;
  /** A group's own fields, and their change. */
  groupFields?: Item<GroupField>[];
  onGroupFields?: (fields: Item<GroupField>[]) => void;
  /** A field of a group: no conditions of its own. */
  nested?: boolean;
  keys: readonly string[];
  /** The fields before it: what its conditions may read. */
  earlier: readonly FormField[];
  onChange: (field: FormField) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation('forms');
  const { field, uid: id } = props;
  const [options, setOptions] = useState(optionsText(field));
  const set = (patch: Partial<FormField>) =>
    props.onChange({ ...field, ...patch });
  const choice = CHOICE_TYPES.includes(field.type);
  return (
    <div className="grid flex-1 gap-2 sm:grid-cols-2">
      <Field>
        <FieldLabel htmlFor={`${id}-label`}>{t('builder.label')}</FieldLabel>
        <Input
          id={`${id}-label`}
          value={field.label}
          maxLength={200}
          onChange={(event) => set({ label: event.target.value })}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor={`${id}-key`}>{t('builder.key')}</FieldLabel>
        <Input
          id={`${id}-key`}
          value={field.key}
          maxLength={50}
          onChange={(event) => set({ key: event.target.value })}
        />
        <FieldDescription>{t(`types.${field.type}`)}</FieldDescription>
      </Field>
      <Field className="sm:col-span-2">
        <FieldLabel htmlFor={`${id}-help`}>{t('builder.help')}</FieldLabel>
        <Input
          id={`${id}-help`}
          value={field.help ?? ''}
          maxLength={1000}
          onChange={(event) => set({ help: event.target.value || undefined })}
        />
      </Field>
      {choice && !props.nested && (
        <SourcePicker
          id={`${id}-source`}
          value={field.optionsSource?.provider}
          onChange={(provider) =>
            set(
              provider
                ? { optionsSource: { provider }, options: undefined }
                : { optionsSource: undefined, options: parseOptions(options) },
            )
          }
        />
      )}
      {choice && !field.optionsSource && (
        <Field className="sm:col-span-2">
          <FieldLabel htmlFor={`${id}-options`}>
            {t('builder.options')}
          </FieldLabel>
          <Textarea
            id={`${id}-options`}
            rows={3}
            value={options}
            onChange={(event) => {
              setOptions(event.target.value);
              set({ options: parseOptions(event.target.value) });
            }}
          />
          <FieldDescription>{t('builder.optionsHint')}</FieldDescription>
        </Field>
      )}
      <div className="flex items-center justify-between sm:col-span-2">
        <Field orientation="horizontal">
          <Checkbox
            id={`${id}-required`}
            checked={field.required === true}
            onCheckedChange={(checked) =>
              set({
                required: checked === true || undefined,
                // Always required takes no condition (the API refuses both).
                ...(checked === true && { requiredWhen: undefined }),
              })
            }
          />
          <FieldLabel htmlFor={`${id}-required`}>
            {t('builder.required')}
          </FieldLabel>
        </Field>
        <Button
          variant="ghost"
          size="sm"
          aria-label={t('builder.removeField', { label: field.label })}
          onClick={props.onRemove}
        >
          <TrashIcon />
        </Button>
      </div>
      {field.type === 'group' && props.onGroupFields && (
        <GroupEditor
          field={field}
          uid={id}
          fields={props.groupFields ?? []}
          onChange={props.onChange}
          onFields={props.onGroupFields}
        />
      )}
      {!props.nested && (
        <div className="flex flex-col gap-2 sm:col-span-2">
          <RuleEditor
            id={`${id}-visible`}
            label={t('rules.visibleWhen')}
            condition={field.visibleWhen}
            earlier={props.earlier}
            onChange={(visibleWhen) => set({ visibleWhen })}
          />
          {!field.required && (
            <RuleEditor
              id={`${id}-required-when`}
              label={t('rules.requiredWhen')}
              condition={field.requiredWhen}
              earlier={props.earlier}
              onChange={(requiredWhen) => set({ requiredWhen })}
            />
          )}
        </div>
      )}
    </div>
  );
}

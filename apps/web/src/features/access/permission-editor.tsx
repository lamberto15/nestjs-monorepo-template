import { Badge } from '@nestjs-monorepo-template/ui/components/badge';
import { Button } from '@nestjs-monorepo-template/ui/components/button';
import { Checkbox } from '@nestjs-monorepo-template/ui/components/checkbox';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '@nestjs-monorepo-template/ui/components/field';
import { Input } from '@nestjs-monorepo-template/ui/components/input';
import { PlusIcon, Trash2Icon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  actionKey,
  emptyRule,
  paramProblem,
  type Catalog,
  type CatalogAction,
  type CatalogSubject,
  type EditorState,
  type Rule,
} from '@/features/access/permissions';

/**
 * The permissions of a role, generated from `GET /v1/access/catalog`: one
 * group per subject, one checkbox per action (with what it means), and for a
 * granted action its rules: the conditions that must all hold (none: every
 * record) and, when the subject declares them, the fields it covers. Several
 * rules of one action: any of them grants it.
 */
export function PermissionEditor(props: {
  catalog: Catalog;
  value: EditorState;
  onChange: (value: EditorState) => void;
  disabled?: boolean;
  /** Whether the editor's user holds an action (`me.can`): one can't grant what one lacks. */
  holds: (key: string) => boolean;
}) {
  return (
    <div className="flex flex-col gap-6">
      {props.catalog.subjects.map((subject) => (
        <SubjectGroup key={subject.subject} subject={subject} {...props} />
      ))}
    </div>
  );
}

function SubjectGroup(props: {
  subject: CatalogSubject;
  value: EditorState;
  onChange: (value: EditorState) => void;
  disabled?: boolean;
  holds: (key: string) => boolean;
}) {
  const { subject } = props;
  return (
    <FieldSet className="rounded-lg border p-4">
      <FieldLegend>
        {subject.label}{' '}
        <code className="ms-1 text-xs font-normal text-muted-foreground">
          {subject.subject}
        </code>
      </FieldLegend>
      <div className="flex flex-col gap-4">
        {subject.actions.map((action) => (
          <ActionRow key={action.action} {...props} action={action} />
        ))}
      </div>
    </FieldSet>
  );
}

function ActionRow(props: {
  subject: CatalogSubject;
  action: CatalogAction;
  value: EditorState;
  onChange: (value: EditorState) => void;
  disabled?: boolean;
  holds: (key: string) => boolean;
}) {
  const { t } = useTranslation('access');
  const { subject, action } = props;
  const key = actionKey(subject.subject, action.action);
  const rules = props.value[key];
  const granted = rules !== undefined && rules.length > 0;
  const held = props.holds(key);
  const id = `perm-${key}`;
  const setRules = (next: Rule[] | undefined) => {
    const copy = { ...props.value };
    if (next && next.length > 0) {
      copy[key] = next;
    } else {
      delete copy[key];
    }
    props.onChange(copy);
  };
  const configurable =
    action.conditions.length > 0 || subject.fields.length > 0;
  return (
    <div className="flex flex-col gap-2">
      <Field orientation="horizontal">
        <Checkbox
          id={id}
          checked={granted}
          // Taking away is always offered; granting only what one holds.
          disabled={props.disabled || (!granted && !held)}
          onCheckedChange={(checked) =>
            setRules(checked ? [emptyRule()] : undefined)
          }
        />
        <FieldContent>
          <FieldLabel htmlFor={id}>
            {action.label}
            <code className="text-xs font-normal text-muted-foreground">
              {key}
            </code>
          </FieldLabel>
          {!held && (
            <FieldDescription>{t('roles.editor.notHeld')}</FieldDescription>
          )}
        </FieldContent>
      </Field>
      {granted && configurable && (
        <div className="ms-6 flex flex-col gap-3 border-s ps-4">
          {rules.map((rule, index) => (
            <RuleEditor
              // Rules have no identity of their own: their place is theirs.
              key={index}
              index={index}
              ruleKey={key}
              rule={rule}
              action={action}
              subject={subject}
              disabled={props.disabled}
              removable={rules.length > 1}
              onChange={(next) =>
                setRules(rules.map((r, i) => (i === index ? next : r)))
              }
              onRemove={() => setRules(rules.filter((_, i) => i !== index))}
            />
          ))}
          {action.conditions.length > 0 && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="self-start"
              disabled={props.disabled}
              onClick={() => setRules([...rules, emptyRule()])}
            >
              <PlusIcon />
              {t('roles.editor.addRule')}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function RuleEditor(props: {
  index: number;
  ruleKey: string;
  rule: Rule;
  action: CatalogAction;
  subject: CatalogSubject;
  disabled?: boolean;
  removable: boolean;
  onChange: (rule: Rule) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation('access');
  const { rule, action, subject } = props;
  const base = `rule-${props.ruleKey}-${props.index}`;
  const ticked = Object.keys(rule.conditions);
  return (
    <div
      className="flex flex-col gap-3 rounded-md bg-muted/40 p-3"
      role="group"
      aria-label={t('roles.editor.rule', { n: props.index + 1 })}
    >
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium">
          {t('roles.editor.rule', { n: props.index + 1 })}
        </span>
        {props.removable && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="ms-auto"
            aria-label={t('roles.editor.removeRule')}
            disabled={props.disabled}
            onClick={props.onRemove}
          >
            <Trash2Icon />
          </Button>
        )}
      </div>
      {action.conditions.length > 0 && (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-muted-foreground">
            {ticked.length === 0
              ? t('roles.editor.everyRecord')
              : t('roles.editor.allOf')}
          </p>
          {action.conditions.map((condition) => {
            const id = `${base}-${condition.key}`;
            const on = condition.key in rule.conditions;
            const text = rule.conditions[condition.key];
            const problem = on ? paramProblem(condition, text) : undefined;
            return (
              <div key={condition.key} className="flex flex-col gap-1">
                <Field orientation="horizontal">
                  <Checkbox
                    id={id}
                    checked={on}
                    disabled={props.disabled}
                    onCheckedChange={(checked) => {
                      const conditions = { ...rule.conditions };
                      if (checked) {
                        conditions[condition.key] = '';
                      } else {
                        delete conditions[condition.key];
                      }
                      props.onChange({ ...rule, conditions });
                    }}
                  />
                  <FieldContent>
                    <FieldLabel htmlFor={id}>{condition.label}</FieldLabel>
                    <FieldDescription>{condition.description}</FieldDescription>
                  </FieldContent>
                </Field>
                {on && condition.input && (
                  <Field data-invalid={problem !== undefined} className="ms-6">
                    <FieldLabel htmlFor={`${id}-param`}>
                      {condition.input.label}
                    </FieldLabel>
                    <Input
                      id={`${id}-param`}
                      inputMode={
                        condition.input.type === 'cents' ? 'numeric' : 'text'
                      }
                      value={text ?? ''}
                      disabled={props.disabled}
                      aria-invalid={problem !== undefined}
                      onChange={(event) =>
                        props.onChange({
                          ...rule,
                          conditions: {
                            ...rule.conditions,
                            [condition.key]: event.target.value,
                          },
                        })
                      }
                    />
                    {condition.input.type === 'cents' && (
                      <FieldDescription>
                        {t('roles.editor.cents')}
                      </FieldDescription>
                    )}
                    {problem && <FieldError>{t(problem)}</FieldError>}
                  </Field>
                )}
              </div>
            );
          })}
        </div>
      )}
      {subject.fields.length > 0 && (
        <FieldsEditor
          base={base}
          subject={subject}
          rule={rule}
          disabled={props.disabled}
          onChange={props.onChange}
        />
      )}
    </div>
  );
}

function FieldsEditor(props: {
  base: string;
  subject: CatalogSubject;
  rule: Rule;
  disabled?: boolean;
  onChange: (rule: Rule) => void;
}) {
  const { t } = useTranslation('access');
  const { rule, subject } = props;
  const allId = `${props.base}-fields-all`;
  const all = rule.fields === null;
  return (
    <div className="flex flex-col gap-2">
      <Field orientation="horizontal">
        <Checkbox
          id={allId}
          checked={all}
          disabled={props.disabled}
          onCheckedChange={(checked) =>
            props.onChange({
              ...rule,
              // Narrowing starts from every field, so nothing vanishes at once.
              fields: checked ? null : subject.fields.map((f) => f.field),
            })
          }
        />
        <FieldContent>
          <FieldLabel htmlFor={allId}>{t('roles.editor.allFields')}</FieldLabel>
          <FieldDescription>
            {t('roles.editor.allFieldsHint', {
              fields: subject.fields.map((f) => f.label).join(', '),
            })}
          </FieldDescription>
        </FieldContent>
      </Field>
      {!all && (
        <div className="ms-6 flex flex-col gap-2">
          {subject.fields.map((field) => {
            const id = `${props.base}-field-${field.field}`;
            const chosen = rule.fields?.includes(field.field) ?? false;
            return (
              <Field key={field.field} orientation="horizontal">
                <Checkbox
                  id={id}
                  checked={chosen}
                  disabled={props.disabled}
                  onCheckedChange={(checked) =>
                    props.onChange({
                      ...rule,
                      fields: checked
                        ? [...(rule.fields ?? []), field.field]
                        : (rule.fields ?? []).filter((f) => f !== field.field),
                    })
                  }
                />
                <FieldLabel htmlFor={id}>
                  {field.label}
                  {field.sensitive && (
                    <Badge variant="outline">
                      {t('roles.editor.sensitive')}
                    </Badge>
                  )}
                </FieldLabel>
              </Field>
            );
          })}
          {rule.fields?.length === 0 && (
            <p className="text-xs text-muted-foreground">
              {t('roles.editor.noFields')}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

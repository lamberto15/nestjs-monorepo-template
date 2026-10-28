import { Badge } from '@nestjs-monorepo-template/ui/components/badge';
import { Button } from '@nestjs-monorepo-template/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@nestjs-monorepo-template/ui/components/dialog';
import {
  Field,
  FieldGroup,
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
import { Spinner } from '@nestjs-monorepo-template/ui/components/spinner';
import { useQuery } from '@tanstack/react-query';
import { PlusIcon, Trash2Icon } from 'lucide-react';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { errorMessage } from '@/lib/errors';
import { FormAlert } from '@/lib/form';
import { useTags } from '@/lib/tags';
import {
  subjectsQuery,
  useSaveRule,
  useSimulate,
  type AutomationAction,
  type AutomationRule,
  type RuleBody,
  type Simulation,
} from './api';

type ActionType = AutomationAction['type'];
const ACTION_TYPES: ActionType[] = ['setField', 'addTag', 'notify', 'webhook'];

/** One action as the form edits it: every parameter as text. */
type ActionDraft = {
  type: ActionType;
  field: string;
  value: string;
  tagId: string;
  userIds: string;
  clientId: string;
};
type Condition = { key: string; value: string };

const NO_FIELD = '-';

const draftOf = (action?: AutomationAction): ActionDraft => ({
  type: action?.type ?? 'setField',
  field: action?.type === 'setField' ? action.field : '',
  value:
    action?.type === 'setField' && action.value !== null
      ? String(action.value)
      : '',
  tagId: action?.type === 'addTag' ? action.tagId : '',
  userIds: action?.type === 'notify' ? action.userIds.join(', ') : '',
  clientId: action?.type === 'webhook' ? action.clientId : '',
});

const actionOf = (draft: ActionDraft): AutomationAction => {
  switch (draft.type) {
    case 'setField':
      return { type: 'setField', field: draft.field, value: draft.value };
    case 'addTag':
      return { type: 'addTag', tagId: draft.tagId };
    case 'notify':
      return {
        type: 'notify',
        userIds: draft.userIds
          .split(',')
          .map((id) => id.trim())
          .filter(Boolean),
      };
    case 'webhook':
      return { type: 'webhook', clientId: draft.clientId.trim() };
  }
};

/** A labelled select of plain values. */
function Choice(props: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <Field>
      <FieldLabel htmlFor={id}>{props.label}</FieldLabel>
      <Select
        items={props.options}
        value={props.value}
        onValueChange={(next) => next && props.onChange(next as string)}
      >
        <SelectTrigger id={id} className="w-full">
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

function Text(props: {
  label: string;
  value: string;
  placeholder?: string;
  readOnly?: boolean;
  onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <Field>
      <FieldLabel htmlFor={id}>{props.label}</FieldLabel>
      <Input
        id={id}
        value={props.value}
        placeholder={props.placeholder}
        readOnly={props.readOnly}
        autoComplete="off"
        onChange={(event) => props.onChange(event.target.value)}
      />
    </Field>
  );
}

/**
 * The rule builder: a trigger on a subject, conditions in the subject's
 * list filters (`title.contains` = `urgent`), and up to 5 actions. "Simulate"
 * shows what the rule would do to the records as they are now, without
 * doing it (the API's evaluator, as the signed-in user); "Save" keeps it as
 * a draft, activated from the list.
 */
export function RuleDialog(props: {
  rule?: AutomationRule;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation('automations');
  const { rule } = props;
  const subjects = useQuery(subjectsQuery);
  const [name, setName] = useState(rule?.name ?? '');
  const [subject, setSubject] = useState(rule?.subject ?? '');
  const [trigger, setTrigger] = useState<'created' | 'updated'>(
    rule?.trigger ?? 'created',
  );
  const [field, setField] = useState(rule?.field ?? NO_FIELD);
  const [conditions, setConditions] = useState<Condition[]>(
    Object.entries(rule?.filters ?? {}).map(([key, value]) => ({ key, value })),
  );
  const [actions, setActions] = useState<ActionDraft[]>(
    rule ? rule.actions.map(draftOf) : [draftOf()],
  );
  const [error, setError] = useState<string>();
  const [simulation, setSimulation] = useState<Simulation>();
  const save = useSaveRule();
  const simulate = useSimulate();

  const chosen =
    subjects.data?.find((s) => s.subject === subject) ??
    (subjects.data?.length === 1 ? subjects.data[0] : undefined);
  const tags = useTags(chosen?.subject ?? '', !!chosen?.tags);

  const body = (): RuleBody => ({
    name: name.trim(),
    subject: chosen?.subject ?? subject,
    trigger,
    field: trigger === 'updated' && field !== NO_FIELD ? field : null,
    filters: Object.fromEntries(
      conditions
        .filter((c) => c.key.trim())
        .map((c) => [c.key.trim(), c.value]),
    ),
    actions: actions.map(actionOf),
  });

  const onSimulate = async () => {
    setError(undefined);
    try {
      const { name: _name, ...definition } = body();
      setSimulation(await simulate.mutateAsync({ ...definition, limit: 20 }));
    } catch (caught) {
      setSimulation(undefined);
      setError(errorMessage(caught));
    }
  };
  const onSave = async () => {
    setError(undefined);
    try {
      await save.mutateAsync({ id: rule?.id, body: body() });
      toast.success(t('saved'));
      props.onOpenChange(false);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };
  const patchAction = (index: number, change: Partial<ActionDraft>) =>
    setActions((all) =>
      all.map((a, i) => (i === index ? { ...a, ...change } : a)),
    );

  return (
    <Dialog open onOpenChange={props.onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{rule ? t('editTitle') : t('newTitle')}</DialogTitle>
          <DialogDescription>{t('builder.description')}</DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <FormAlert message={error} />
          <Text label={t('builder.name')} value={name} onChange={setName} />
          <div className="grid gap-4 sm:grid-cols-3">
            {rule ? (
              <Text
                label={t('builder.subject')}
                value={rule.subject}
                readOnly
                onChange={() => undefined}
              />
            ) : (
              <Choice
                label={t('builder.subject')}
                value={chosen?.subject ?? ''}
                options={(subjects.data ?? []).map((s) => ({
                  value: s.subject,
                  label: s.subject,
                }))}
                onChange={setSubject}
              />
            )}
            <Choice
              label={t('builder.trigger')}
              value={trigger}
              options={(['created', 'updated'] as const).map((value) => ({
                value,
                label: t(`trigger.${value}`),
              }))}
              onChange={(value) => setTrigger(value as 'created' | 'updated')}
            />
            {trigger === 'updated' && (
              <Choice
                label={t('builder.field')}
                value={field}
                options={[
                  { value: NO_FIELD, label: t('builder.anyField') },
                  ...(chosen?.fields ?? []).map((f) => ({
                    value: f,
                    label: f,
                  })),
                ]}
                onChange={setField}
              />
            )}
          </div>

          <FieldSet>
            <FieldLegend>{t('builder.conditions')}</FieldLegend>
            <p className="text-sm text-muted-foreground">
              {t('builder.conditionsHint')}
            </p>
            {conditions.map((condition, index) => (
              <div key={index} className="flex items-end gap-2">
                <Text
                  label={t('builder.filter')}
                  value={condition.key}
                  placeholder="title.contains"
                  onChange={(key) =>
                    setConditions((all) =>
                      all.map((c, i) => (i === index ? { ...c, key } : c)),
                    )
                  }
                />
                <Text
                  label={t('builder.value')}
                  value={condition.value}
                  onChange={(value) =>
                    setConditions((all) =>
                      all.map((c, i) => (i === index ? { ...c, value } : c)),
                    )
                  }
                />
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t('builder.removeCondition')}
                  onClick={() =>
                    setConditions((all) => all.filter((_, i) => i !== index))
                  }
                >
                  <Trash2Icon />
                </Button>
              </div>
            ))}
            <Button
              variant="outline"
              size="sm"
              className="self-start"
              onClick={() =>
                setConditions((all) => [...all, { key: '', value: '' }])
              }
            >
              <PlusIcon />
              {t('builder.addCondition')}
            </Button>
          </FieldSet>

          <FieldSet>
            <FieldLegend>{t('builder.actions')}</FieldLegend>
            {actions.map((action, index) => (
              <div
                key={index}
                className="grid items-end gap-2 rounded-md border p-3 sm:grid-cols-[10rem_1fr_auto]"
              >
                <Choice
                  label={t('builder.actionType')}
                  value={action.type}
                  options={ACTION_TYPES.map((type) => ({
                    value: type,
                    label: t(`action.${type}`),
                  }))}
                  onChange={(type) =>
                    patchAction(index, { type: type as ActionType })
                  }
                />
                <div className="grid gap-2 sm:grid-cols-2">
                  {action.type === 'setField' && (
                    <>
                      <Choice
                        label={t('builder.setField')}
                        value={action.field}
                        options={(chosen?.settable ?? []).map((f) => ({
                          value: f,
                          label: f,
                        }))}
                        onChange={(value) =>
                          patchAction(index, { field: value })
                        }
                      />
                      <Text
                        label={t('builder.value')}
                        value={action.value}
                        onChange={(value) => patchAction(index, { value })}
                      />
                    </>
                  )}
                  {action.type === 'addTag' && (
                    <Choice
                      label={t('builder.tag')}
                      value={action.tagId}
                      options={(tags.data ?? []).map((tag) => ({
                        value: tag.id,
                        label: tag.name,
                      }))}
                      onChange={(tagId) => patchAction(index, { tagId })}
                    />
                  )}
                  {action.type === 'notify' && (
                    <Text
                      label={t('builder.userIds')}
                      value={action.userIds}
                      onChange={(userIds) => patchAction(index, { userIds })}
                    />
                  )}
                  {action.type === 'webhook' && (
                    <Text
                      label={t('builder.clientId')}
                      value={action.clientId}
                      onChange={(clientId) => patchAction(index, { clientId })}
                    />
                  )}
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  disabled={actions.length === 1}
                  aria-label={t('builder.removeAction')}
                  onClick={() =>
                    setActions((all) => all.filter((_, i) => i !== index))
                  }
                >
                  <Trash2Icon />
                </Button>
              </div>
            ))}
            {actions.length < 5 && (
              <Button
                variant="outline"
                size="sm"
                className="self-start"
                onClick={() => setActions((all) => [...all, draftOf()])}
              >
                <PlusIcon />
                {t('builder.addAction')}
              </Button>
            )}
          </FieldSet>

          {simulation && <SimulationResult simulation={simulation} />}

          <DialogFooter>
            <Button variant="outline" onClick={() => props.onOpenChange(false)}>
              {t('builder.cancel')}
            </Button>
            <Button
              variant="secondary"
              disabled={simulate.isPending}
              onClick={() => void onSimulate()}
            >
              {simulate.isPending && <Spinner />}
              {t('builder.simulate')}
            </Button>
            <Button disabled={save.isPending} onClick={() => void onSave()}>
              {save.isPending && <Spinner />}
              {t('builder.save')}
            </Button>
          </DialogFooter>
        </FieldGroup>
      </DialogContent>
    </Dialog>
  );
}

/** What a simulation found: each matching record and what each action would do. */
function SimulationResult({ simulation }: { simulation: Simulation }) {
  const { t } = useTranslation('automations');
  return (
    <section aria-label={t('simulation.title')} className="flex flex-col gap-2">
      <h3 className="font-medium">{t('simulation.title')}</h3>
      <p className="text-sm text-muted-foreground">
        {t('simulation.summary', {
          matched: simulation.matched,
          limit: simulation.limit,
        })}
        {simulation.truncated && ` ${t('simulation.truncated')}`}
        {!simulation.triggerSimulated && ` ${t('simulation.noTrigger')}`}
      </p>
      <ul className="flex flex-col gap-2">
        {simulation.matches.map((match) => (
          <li key={match.recordId} className="rounded-md border p-2 text-sm">
            <div className="font-medium">
              {match.title ?? (
                <span className="font-mono text-xs">{match.recordId}</span>
              )}
            </div>
            <ul className="mt-1 flex flex-col gap-1">
              {match.actions.map((action, index) => (
                <li key={index} className="flex flex-wrap items-center gap-2">
                  <Badge variant={action.allowed ? 'outline' : 'destructive'}>
                    {t(`action.${action.type}`)}
                  </Badge>
                  <span>{action.detail}</span>
                  {!action.allowed && (
                    <span className="text-destructive">
                      {t(`refusal.${action.reason}`, {
                        defaultValue: action.reason ?? '',
                      })}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </section>
  );
}

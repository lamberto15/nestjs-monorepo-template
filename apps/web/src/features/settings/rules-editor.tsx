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
import {
  TagsInput,
  TagsInputInput,
  TagsInputItem,
  TagsInputList,
} from '@nestjs-monorepo-template/ui/components/tags-input';
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, TrashIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { errorMessage } from '@/lib/errors';
import { FormAlert } from '@/lib/form';
import {
  fromRuleDrafts,
  RULE_KEYS,
  toRuleDrafts,
  type ConditionDraft,
  type Rule,
  type RuleDraft,
  type RuleKey,
  type RoleRef,
} from './settings';

const emptyCondition = (key: RuleKey): ConditionDraft => ({
  key,
  values:
    key === 'principalKind'
      ? ['user']
      : key === 'tenantOperator'
        ? ['true']
        : [],
});

/** One option list of a pick-one condition. */
function Pick(props: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
  className?: string;
}) {
  return (
    <Select
      items={props.options}
      value={props.value || null}
      onValueChange={(next) => props.onChange(next ?? '')}
    >
      <SelectTrigger
        aria-label={props.label}
        className={props.className ?? 'w-full'}
      >
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
  );
}

/**
 * The targeting rules of a flag (docs/settings.md, "Targeting rules"): an
 * ordered list, each rule conditions that all must hold and an outcome (on,
 * off, or a share of the matched group); the first match decides, before the
 * scope's plain value. Dice UI's tags-input takes the lists of domains,
 * languages and tenants. `roles` (tenant scope only) are the tenant's, for
 * the role condition; without them it is not offered. `onSave` gets the
 * checked rules and may throw: the message is shown.
 */
export function RulesEditor(props: {
  scope: 'tenant' | 'platform';
  rules: readonly Rule[] | undefined;
  roles?: readonly RoleRef[];
  onSave: (rules: Rule[]) => Promise<void>;
}) {
  const { t } = useTranslation('settings');
  const [drafts, setDrafts] = useState<RuleDraft[]>(toRuleDrafts(props.rules));
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const keys = RULE_KEYS[props.scope].filter(
    (key) => key !== 'role' || (props.roles?.length ?? 0) > 0,
  );
  const keyOptions = keys.map((key) => ({
    value: key,
    label: t(`rules.condition.${key}`),
  }));

  const changeRule = (index: number, change: Partial<RuleDraft>) =>
    setDrafts((all) =>
      all.map((rule, i) => (i === index ? { ...rule, ...change } : rule)),
    );
  const changeCondition = (index: number, at: number, next: ConditionDraft) =>
    setDrafts((all) =>
      all.map((rule, i) =>
        i === index
          ? {
              ...rule,
              conditions: rule.conditions.map((c, j) => (j === at ? next : c)),
            }
          : rule,
      ),
    );
  const move = (index: number, by: -1 | 1) =>
    setDrafts((all) => {
      const next = [...all];
      const [item] = next.splice(index, 1);
      next.splice(index + by, 0, item!);
      return next;
    });

  const submit = async () => {
    setError(undefined);
    const parsed = fromRuleDrafts(drafts);
    if (!parsed.ok) {
      setError(t(`rules.invalid.${parsed.reason}`));
      return;
    }
    setSaving(true);
    try {
      await props.onSave(parsed.rules);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  };

  const valueInput = (index: number, at: number, condition: ConditionDraft) => {
    const label = t(`rules.condition.${condition.key}`);
    const set = (values: string[]) =>
      changeCondition(index, at, { ...condition, values });
    switch (condition.key) {
      case 'principalKind':
        return (
          <Pick
            label={`${label} (${index + 1}.${at + 1})`}
            value={condition.values[0] ?? ''}
            options={[
              { value: 'user', label: t('rules.kind.user') },
              { value: 'client', label: t('rules.kind.client') },
            ]}
            onChange={(value) => set([value])}
          />
        );
      case 'tenantOperator':
        return (
          <Pick
            label={`${label} (${index + 1}.${at + 1})`}
            value={condition.values[0] ?? ''}
            options={[
              { value: 'true', label: t('rules.operator.true') },
              { value: 'false', label: t('rules.operator.false') },
            ]}
            onChange={(value) => set([value])}
          />
        );
      case 'role':
        return (
          <Pick
            label={`${label} (${index + 1}.${at + 1})`}
            value={condition.values[0] ?? ''}
            options={(props.roles ?? []).map((role) => ({
              value: role.id,
              label: role.name,
            }))}
            onChange={(value) => set([value])}
          />
        );
      default:
        return (
          <TagsInput
            className="w-full"
            value={condition.values}
            onValueChange={set}
            addOnPaste
            blurBehavior="add"
            delimiter=","
          >
            <TagsInputList>
              {condition.values.map((value) => (
                <TagsInputItem key={value} value={value}>
                  {value}
                </TagsInputItem>
              ))}
              <TagsInputInput
                aria-label={`${label} (${index + 1}.${at + 1})`}
                placeholder={t(`rules.placeholder.${condition.key}`)}
              />
            </TagsInputList>
          </TagsInput>
        );
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <FormAlert message={error} />
      {drafts.length === 0 && (
        <p className="text-sm text-muted-foreground">{t('rules.none')}</p>
      )}
      <ol className="flex flex-col gap-3">
        {drafts.map((rule, index) => (
          <li
            // Rules have no id: their position is their order.
            key={index}
            aria-label={t('rules.ruleN', { n: index + 1 })}
            className="flex flex-col gap-3 rounded-lg border p-3"
          >
            <div className="flex items-center gap-1">
              <strong className="flex-1 text-sm">
                {t('rules.ruleN', { n: index + 1 })}
              </strong>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={t('rules.moveUp', { n: index + 1 })}
                disabled={index === 0}
                onClick={() => move(index, -1)}
              >
                <ArrowUpIcon />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={t('rules.moveDown', { n: index + 1 })}
                disabled={index === drafts.length - 1}
                onClick={() => move(index, 1)}
              >
                <ArrowDownIcon />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={t('rules.removeRule', { n: index + 1 })}
                onClick={() =>
                  setDrafts((all) => all.filter((_, i) => i !== index))
                }
              >
                <TrashIcon />
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">{t('rules.when')}</p>
            {rule.conditions.map((condition, at) => (
              // A rule's conditions have no id either.
              <div key={at} className="flex flex-col gap-2 sm:flex-row">
                <Pick
                  label={`${t('rules.conditionLabel')} (${index + 1}.${at + 1})`}
                  value={condition.key}
                  options={keyOptions}
                  className="sm:w-56"
                  onChange={(key) =>
                    changeCondition(index, at, emptyCondition(key as RuleKey))
                  }
                />
                <div className="flex-1">{valueInput(index, at, condition)}</div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t('rules.removeCondition', {
                    n: index + 1,
                    c: at + 1,
                  })}
                  disabled={rule.conditions.length === 1}
                  onClick={() =>
                    changeRule(index, {
                      conditions: rule.conditions.filter((_, j) => j !== at),
                    })
                  }
                >
                  <TrashIcon />
                </Button>
              </div>
            ))}
            <div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  changeRule(index, {
                    conditions: [
                      ...rule.conditions,
                      emptyCondition(keys[0] ?? 'principalKind'),
                    ],
                  })
                }
              >
                <PlusIcon />
                {t('rules.addCondition')}
              </Button>
            </div>
            <Field>
              <FieldLabel>{t('rules.then')}</FieldLabel>
              <div className="flex gap-2">
                <Pick
                  label={`${t('rules.then')} (${index + 1})`}
                  value={rule.outcome}
                  options={[
                    { value: 'on', label: t('rules.outcome.on') },
                    { value: 'off', label: t('rules.outcome.off') },
                    { value: 'rollout', label: t('rules.outcome.rollout') },
                  ]}
                  className="sm:w-56"
                  onChange={(outcome) =>
                    changeRule(index, {
                      outcome: outcome as RuleDraft['outcome'],
                    })
                  }
                />
                {rule.outcome === 'rollout' && (
                  <Input
                    type="number"
                    min={0}
                    max={100}
                    className="w-24"
                    aria-label={t('rules.percent', { n: index + 1 })}
                    value={rule.percent}
                    onChange={(event) =>
                      changeRule(index, { percent: event.target.value })
                    }
                  />
                )}
              </div>
              {rule.outcome === 'rollout' && (
                <FieldDescription>{t('rules.rolloutHint')}</FieldDescription>
              )}
            </Field>
          </li>
        ))}
      </ol>
      <div className="flex gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={() =>
            setDrafts((all) => [
              ...all,
              {
                conditions: [emptyCondition('principalKind')],
                outcome: 'on',
                percent: '50',
              },
            ])
          }
        >
          <PlusIcon />
          {t('rules.add')}
        </Button>
        <Button type="button" disabled={saving} onClick={() => void submit()}>
          {t('rules.save')}
        </Button>
      </div>
    </div>
  );
}

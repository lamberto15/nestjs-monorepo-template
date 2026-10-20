import { Button } from '@nestjs-monorepo-template/ui/components/button';
import {
  Field,
  FieldDescription,
  FieldLabel,
} from '@nestjs-monorepo-template/ui/components/field';
import { Input } from '@nestjs-monorepo-template/ui/components/input';
import { ArrowDownIcon, ArrowUpIcon, Trash2Icon } from 'lucide-react';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import type { PolicyTypes } from './api';
import { initialOf, type StageDraft } from './policy-draft';
import { OptionSelect, TypedEditor, TypedList } from './typed-editor';

/**
 * One stage of a policy: its name, who approves (rules), how it completes
 * (mode), when it reminds, is overdue and what happens then
 * (docs/approvals.md, "Stages, modes, time"). `errors` are the API's, for
 * this stage's fields (`stages.0.approvers.1.role`).
 */
export function StageEditor(props: {
  index: number;
  count: number;
  types: PolicyTypes;
  value: StageDraft;
  onChange: (next: StageDraft) => void;
  onMove: (by: -1 | 1) => void;
  onRemove: () => void;
  errors: readonly { path: string; message: string }[];
}) {
  const { t } = useTranslation('approvals');
  const id = useId();
  const { value, types } = props;
  const set = (changes: Partial<StageDraft>) =>
    props.onChange({ ...value, ...changes });
  const escalate = value.onOverdue === 'escalate';
  return (
    <section
      aria-label={t('policies.stage.label', { n: props.index + 1 })}
      className="flex flex-col gap-4 rounded-lg border p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-medium">
          {t('policies.stage.label', { n: props.index + 1 })}
        </h3>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t('policies.stage.up', { n: props.index + 1 })}
            disabled={props.index === 0}
            onClick={() => props.onMove(-1)}
          >
            <ArrowUpIcon />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t('policies.stage.down', { n: props.index + 1 })}
            disabled={props.index === props.count - 1}
            onClick={() => props.onMove(1)}
          >
            <ArrowDownIcon />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t('policies.stage.remove', { n: props.index + 1 })}
            disabled={props.count === 1}
            onClick={props.onRemove}
          >
            <Trash2Icon />
          </Button>
        </div>
      </div>
      {props.errors.length > 0 && (
        <ul role="alert" className="text-sm text-destructive">
          {props.errors.map((error) => (
            <li key={`${error.path}:${error.message}`}>
              <code>{error.path.replace(/^stages\.\d+\./, '')}</code>:{' '}
              {error.message}
            </li>
          ))}
        </ul>
      )}
      <Field>
        <FieldLabel htmlFor={`${id}-name`}>
          {t('policies.stage.name')}
        </FieldLabel>
        <Input
          id={`${id}-name`}
          value={value.name}
          maxLength={100}
          onChange={(event) => set({ name: event.target.value })}
        />
      </Field>
      <div className="flex flex-col gap-2">
        <h4 className="text-sm font-medium">{t('policies.stage.approvers')}</h4>
        <p className="text-xs text-muted-foreground">
          {t('policies.stage.approversHint')}
        </p>
        <TypedList
          kind="rule"
          options={types.approverRules}
          value={value.approvers}
          onChange={(approvers) => set({ approvers })}
          itemLabel={t('policies.stage.approver')}
          addLabel={t('policies.stage.addApprover')}
        />
      </div>
      <TypedEditor
        kind="mode"
        options={types.modes}
        value={value.mode}
        label={t('policies.stage.mode')}
        onChange={(mode) => set({ mode })}
      />
      <div className="grid gap-3 sm:grid-cols-3">
        <Field>
          <FieldLabel htmlFor={`${id}-remind`}>
            {t('policies.stage.remindAfter')}
          </FieldLabel>
          <Input
            id={`${id}-remind`}
            value={value.remindAfter}
            placeholder="1d"
            onChange={(event) => set({ remindAfter: event.target.value })}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor={`${id}-due`}>
            {t('policies.stage.dueAfter')}
          </FieldLabel>
          <Input
            id={`${id}-due`}
            value={value.dueAfter}
            placeholder="3d"
            onChange={(event) => set({ dueAfter: event.target.value })}
          />
        </Field>
        <OptionSelect
          id={`${id}-overdue`}
          label={t('policies.stage.onOverdue')}
          value={value.onOverdue}
          options={(['expire', 'escalate'] as const).map((option) => ({
            value: option,
            label: t(`policies.stage.overdue.${option}`),
          }))}
          onChange={(onOverdue) =>
            set({
              onOverdue: onOverdue as StageDraft['onOverdue'],
              // An escalation needs someone to hand the stage to.
              ...(onOverdue === 'escalate' &&
                value.escalateTo.length === 0 &&
                types.approverRules[0] && {
                  escalateTo: [initialOf(types.approverRules[0])],
                }),
            })
          }
        />
      </div>
      <FieldDescription>{t('policies.stage.durationHint')}</FieldDescription>
      {escalate && (
        <div className="flex flex-col gap-3 rounded-md border border-dashed p-3">
          <h4 className="text-sm font-medium">
            {t('policies.stage.escalateTo')}
          </h4>
          <TypedList
            kind="rule"
            options={types.approverRules}
            value={value.escalateTo}
            onChange={(escalateTo) => set({ escalateTo })}
            itemLabel={t('policies.stage.escalation')}
            addLabel={t('policies.stage.addEscalation')}
          />
          <Field>
            <FieldLabel htmlFor={`${id}-esc-due`}>
              {t('policies.stage.escalationDueAfter')}
            </FieldLabel>
            <Input
              id={`${id}-esc-due`}
              value={value.escalationDueAfter}
              placeholder="2d"
              onChange={(event) =>
                set({ escalationDueAfter: event.target.value })
              }
            />
          </Field>
        </div>
      )}
    </section>
  );
}

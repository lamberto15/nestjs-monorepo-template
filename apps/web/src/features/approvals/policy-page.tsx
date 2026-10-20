import { isApiError } from '@nestjs-monorepo-template/api-client';
import { Button } from '@nestjs-monorepo-template/ui/components/button';
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '@nestjs-monorepo-template/ui/components/field';
import { Skeleton } from '@nestjs-monorepo-template/ui/components/skeleton';
import { Switch } from '@nestjs-monorepo-template/ui/components/switch';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowLeftIcon, PlusIcon } from 'lucide-react';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ConfirmButton } from '@/components/confirm-button';
import { ConflictAlert } from '@/components/records/conflict-alert';
import { RecordState } from '@/components/records/record-state';
import { errorMessage } from '@/lib/errors';
import { FormAlert, useAppForm } from '@/lib/form';
import { isPreconditionFailed } from '@/lib/records';
import {
  approvalsKey,
  policyQuery,
  policyTypesQuery,
  useResetPolicy,
  useSavePolicy,
  type PolicyTypes,
  type PolicyView,
} from './api';
import { ConditionEditor, defaultCondition } from './condition-editor';
import {
  emptyStage,
  stageErrors,
  toBody,
  toDraft,
  type PolicyDraft,
} from './policy-draft';
import { SourceBadge } from './policies-page';
import { StageEditor } from './stage-editor';
import { InvalidFieldsContext } from './typed-editor';

type FieldIssue = { path: string; message: string };

/** `/approval-policies/$key`: one action's policy, edited and saved as a new version, or reset to the code's default. */
export function PolicyPage(props: { policyKey: string }) {
  const { t } = useTranslation('approvals');
  const query = useQuery(policyQuery(props.policyKey));
  return (
    <section className="flex max-w-3xl flex-col gap-4">
      <Link
        to="/approval-policies"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground underline-offset-4 hover:underline"
      >
        <ArrowLeftIcon className="size-4 rtl:rotate-180" />
        {t('policies.back')}
      </Link>
      <RecordState
        query={query}
        notFound={{
          title: t('policies.notFound.title'),
          description: t('policies.notFound.description'),
        }}
        error={{
          title: t('policies.error.title'),
          generic: t('policies.error.generic'),
          retry: t('policies.error.retry'),
        }}
      >
        {({ policy, etag }) => <PolicyEditor policy={policy} etag={etag} />}
      </RecordState>
    </section>
  );
}

function PolicyEditor(props: { policy: PolicyView; etag?: string }) {
  const types = useQuery(policyTypesQuery);
  if (types.isPending) {
    return <Skeleton className="h-64 w-full" aria-busy />;
  }
  if (types.isError) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {errorMessage(types.error)}
      </p>
    );
  }
  return (
    // A saved or reset policy has a new ETag: a fresh form from what the API now holds.
    <PolicyForm
      key={`${props.etag ?? ''}:${props.policy.version}`}
      policy={props.policy}
      etag={props.etag}
      types={types.data}
    />
  );
}

function PolicyForm(props: {
  policy: PolicyView;
  etag?: string;
  types: PolicyTypes;
}) {
  const { t } = useTranslation('approvals');
  const queryClient = useQueryClient();
  const { policy, types } = props;
  const save = useSavePolicy();
  const reset = useResetPolicy();
  const [error, setError] = useState<string>();
  const [issues, setIssues] = useState<FieldIssue[]>([]);
  const [conflict, setConflict] = useState(false);
  // The fields holding JSON that doesn't parse: saving waits for them.
  const [invalidFields, setInvalidFields] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const reportInvalid = useCallback((id: string, invalid: boolean) => {
    setInvalidFields((current) => {
      if (current.has(id) === invalid) return current;
      const next = new Set(current);
      if (invalid) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const form = useAppForm({
    defaultValues: toDraft(policy.policy) satisfies PolicyDraft,
    onSubmit: async ({ value }) => {
      setError(undefined);
      setIssues([]);
      setConflict(false);
      try {
        await save.mutateAsync({
          key: policy.key,
          body: toBody(value),
          etag: props.etag,
        });
        toast.success(t('policies.saved'));
      } catch (caught) {
        if (isPreconditionFailed(caught)) {
          setConflict(true);
        } else if (isApiError(caught) && caught.errors?.length) {
          // `validation_failed` names each wrong path (`stages.0.approvers.1.role`).
          setIssues(caught.errors);
          setError(caught.detail);
        } else {
          setError(errorMessage(caught));
        }
      }
    },
  });

  const payloadFields = Object.keys(
    (policy.payloadSchema.properties as Record<string, unknown> | undefined) ??
      {},
  );
  const whenIssues = issues.filter((issue) => issue.path.startsWith('when'));
  const otherIssues = issues.filter(
    (issue) =>
      !issue.path.startsWith('when') && !issue.path.startsWith('stages.'),
  );

  return (
    <>
      <header className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-medium break-words">{policy.label}</h1>
          <SourceBadge policy={policy} />
        </div>
        <p className="text-sm text-muted-foreground">
          <code>{policy.key}</code>
          {policy.description && ` · ${policy.description}`}
        </p>
        {policy.setting && (
          <p className="text-sm text-muted-foreground">
            {t('policies.setting')} <code>{policy.setting}</code>
          </p>
        )}
      </header>
      <InvalidFieldsContext.Provider value={reportInvalid}>
        <form
          noValidate
          className="flex flex-col gap-6"
          onSubmit={(event) => {
            event.preventDefault();
            void form.handleSubmit();
          }}
        >
          <FieldGroup>
            <FormAlert message={error} />
            {conflict && (
              <ConflictAlert
                title={t('policies.conflict.title')}
                description={t('policies.conflict.description')}
                reload={t('policies.conflict.reload')}
                onReload={() =>
                  void queryClient.invalidateQueries({ queryKey: approvalsKey })
                }
              />
            )}
            {otherIssues.length > 0 && <IssueList issues={otherIssues} />}
            <form.Field name="enabled">
              {(field) => (
                <Field orientation="horizontal">
                  <Switch
                    id="policy-enabled"
                    checked={field.state.value}
                    onCheckedChange={(checked) => field.handleChange(checked)}
                  />
                  <div className="flex flex-col gap-1">
                    <FieldLabel htmlFor="policy-enabled">
                      {t('policies.enabled')}
                    </FieldLabel>
                    <FieldDescription>
                      {t('policies.enabledHint')}
                    </FieldDescription>
                  </div>
                </Field>
              )}
            </form.Field>
            <form.AppField name="resubmitWithin">
              {(field) => (
                <field.TextField
                  label={t('policies.resubmitWithin')}
                  description={t('policies.resubmitWithinHint')}
                />
              )}
            </form.AppField>

            <section
              aria-labelledby="policy-when"
              className="flex flex-col gap-3"
            >
              <h2 id="policy-when" className="font-medium">
                {t('policies.when.title')}
              </h2>
              <form.Field name="when">
                {(field) => (
                  <>
                    <Field orientation="horizontal">
                      <Switch
                        id="policy-when-on"
                        checked={field.state.value !== null}
                        onCheckedChange={(on) =>
                          field.handleChange(
                            on ? defaultCondition(types.conditions) : null,
                          )
                        }
                      />
                      <div className="flex flex-col gap-1">
                        <FieldLabel htmlFor="policy-when-on">
                          {t('policies.when.only')}
                        </FieldLabel>
                        <FieldDescription>
                          {t('policies.when.hint')}
                          {payloadFields.length > 0 &&
                            ` ${t('policies.when.fields', { fields: payloadFields.join(', ') })}`}
                        </FieldDescription>
                      </div>
                    </Field>
                    {whenIssues.length > 0 && <IssueList issues={whenIssues} />}
                    {field.state.value && (
                      <ConditionEditor
                        options={types.conditions}
                        value={field.state.value}
                        label={t('policies.when.condition')}
                        onChange={(next) => field.handleChange(next)}
                      />
                    )}
                  </>
                )}
              </form.Field>
            </section>

            <section
              aria-labelledby="policy-stages"
              className="flex flex-col gap-3"
            >
              <h2 id="policy-stages" className="font-medium">
                {t('policies.stages')}
              </h2>
              <form.Field name="stages" mode="array">
                {(field) => (
                  <>
                    {field.state.value.map((stage, index) => (
                      <StageEditor
                        // Stages have no identity of their own: the position is it.
                        key={index}
                        index={index}
                        count={field.state.value.length}
                        types={types}
                        value={stage}
                        errors={stageErrors(issues, index)}
                        onChange={(next) => field.replaceValue(index, next)}
                        onMove={(by) => field.moveValue(index, index + by)}
                        onRemove={() => field.removeValue(index)}
                      />
                    ))}
                    <Button
                      type="button"
                      variant="outline"
                      className="self-start"
                      disabled={field.state.value.length >= 10}
                      onClick={() =>
                        field.pushValue(
                          emptyStage(types.approverRules, types.modes),
                        )
                      }
                    >
                      <PlusIcon />
                      {t('policies.addStage')}
                    </Button>
                  </>
                )}
              </form.Field>
            </section>

            <div className="flex flex-wrap items-center gap-2">
              <form.AppForm>
                <form.SubmitButton
                  disabled={conflict || invalidFields.size > 0}
                >
                  {t('policies.save')}
                </form.SubmitButton>
              </form.AppForm>
              <ConfirmButton
                disabled={policy.source === 'code'}
                title={t('policies.reset.title', { label: policy.label })}
                description={t('policies.reset.description')}
                confirm={t('policies.reset.confirm')}
                onConfirm={async () => {
                  try {
                    await reset.mutateAsync({
                      key: policy.key,
                      etag: props.etag,
                    });
                    toast.success(t('policies.reset.done'));
                  } catch (caught) {
                    // A changed policy is the page's to explain; any other
                    // failure keeps the dialog open to try again.
                    if (isPreconditionFailed(caught)) {
                      setConflict(true);
                      return;
                    }
                    toast.error(errorMessage(caught));
                    throw caught;
                  }
                }}
              >
                {t('policies.reset.button')}
              </ConfirmButton>
            </div>
          </FieldGroup>
        </form>
      </InvalidFieldsContext.Provider>
    </>
  );
}

function IssueList(props: { issues: FieldIssue[] }) {
  return (
    <ul role="alert" className="text-sm text-destructive">
      {props.issues.map((issue) => (
        <li key={`${issue.path}:${issue.message}`}>
          <code>{issue.path}</code>: {issue.message}
        </li>
      ))}
    </ul>
  );
}

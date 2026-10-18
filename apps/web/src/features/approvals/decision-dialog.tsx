import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@nestjs-monorepo-template/ui/components/dialog';
import { FieldGroup } from '@nestjs-monorepo-template/ui/components/field';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ConflictAlert } from '@/components/records/conflict-alert';
import { errorMessage } from '@/lib/errors';
import { FormAlert, useAppForm } from '@/lib/form';
import { isPreconditionFailed } from '@/lib/records';
import { z } from '@/lib/zod';
import { approvalsKey, useDecide, type Decision } from './api';

/** What the dialog decides: a request, how, and the ETag it was read with. */
export type DecisionTarget = {
  id: string;
  title: string;
  decision: Decision;
  etag?: string;
};

/**
 * The comment of a decision (docs/approvals.md, "The API"): optional to
 * approve, required to reject, optional (the reason) to cancel.
 */
export function DecisionDialog(props: {
  target: DecisionTarget | null;
  onClose: () => void;
}) {
  const { t } = useTranslation('approvals');
  const { target } = props;
  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => !open && props.onClose()}
    >
      <DialogContent>
        {target && (
          <>
            <DialogHeader>
              <DialogTitle>
                {t(`decision.${target.decision}.title`)}
              </DialogTitle>
              <DialogDescription>{target.title}</DialogDescription>
            </DialogHeader>
            <DecisionForm target={target} onDone={props.onClose} />
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function DecisionForm(props: { target: DecisionTarget; onDone: () => void }) {
  const { t } = useTranslation('approvals');
  const { target } = props;
  const queryClient = useQueryClient();
  const decide = useDecide();
  const [error, setError] = useState<string>();
  const [conflict, setConflict] = useState(false);
  const required = target.decision === 'reject';
  const form = useAppForm({
    defaultValues: { comment: '' },
    validators: {
      onSubmit: z.object({
        comment: required
          ? z.string().trim().min(1, t('decision.commentRequired'))
          : z.string(),
      }),
    },
    onSubmit: async ({ value }) => {
      setError(undefined);
      try {
        await decide.mutateAsync({
          id: target.id,
          decision: target.decision,
          comment: value.comment,
          etag: target.etag,
        });
        toast.success(t(`decision.${target.decision}.done`));
        props.onDone();
      } catch (caught) {
        if (isPreconditionFailed(caught)) {
          setConflict(true);
        } else {
          setError(errorMessage(caught));
        }
      }
    },
  });
  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void form.handleSubmit();
      }}
    >
      <FieldGroup>
        <FormAlert message={error} />
        {conflict && (
          <ConflictAlert
            title={t('conflict.title')}
            description={t('conflict.description')}
            reload={t('conflict.reload')}
            onReload={() => {
              void queryClient.invalidateQueries({ queryKey: approvalsKey });
              props.onDone();
            }}
          />
        )}
        <form.AppField name="comment">
          {(field) => (
            <field.TextAreaField
              label={t(
                required ? 'decision.commentRequiredLabel' : 'decision.comment',
              )}
              rows={3}
            />
          )}
        </form.AppField>
        <form.AppForm>
          <form.SubmitButton className="self-start" disabled={conflict}>
            {t(`decision.${target.decision}.submit`)}
          </form.SubmitButton>
        </form.AppForm>
      </FieldGroup>
    </form>
  );
}

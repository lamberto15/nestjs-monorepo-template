import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { unwrap } from '@nestjs-monorepo-template/api-client';
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from '@nestjs-monorepo-template/ui/components/alert';
import { Badge } from '@nestjs-monorepo-template/ui/components/badge';
import { Button } from '@nestjs-monorepo-template/ui/components/button';
import { FieldGroup } from '@nestjs-monorepo-template/ui/components/field';
import {
  QRCode,
  QRCodeSkeleton,
  QRCodeSvg,
} from '@nestjs-monorepo-template/ui/components/qr-code';
import { Spinner } from '@nestjs-monorepo-template/ui/components/spinner';
import { ShieldAlertIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { z } from '@/lib/zod';
import { Section } from '@/components/account/section';
import { ConfirmButton } from '@/components/confirm-button';
import { useOnSessionChange } from '@/hooks/use-on-session-change';
import { api } from '@/lib/api';
import { applyFieldErrors, errorMessage } from '@/lib/errors';
import { useFeatures, useMe } from '@/lib/features';
import { FormAlert, useAppForm } from '@/lib/form';
import { meQuery } from '@/lib/session';

export const mfaQuery = queryOptions({
  queryKey: ['auth', 'mfa'],
  queryFn: () => unwrap(api.GET('/v1/auth/mfa')),
});

/**
 * Two-factor (TOTP): set up (a QR code of the `otpauth://` URI, Dice UI's
 * qr-code), confirm with a code (the recovery codes, shown once), new
 * recovery codes, off. Setting up is the `mfa` switch's; an account that has
 * it keeps the rest when the switch is off (docs/auth.md, "Switches").
 */
export function MfaSection() {
  const { t } = useTranslation();
  const me = useMe();
  const queryClient = useQueryClient();
  const features = useFeatures();
  const status = useQuery(mfaQuery);
  // Required (`me.mfaEnrollmentRequired`) leads to enrolment, whatever the
  // features call said (it answers 403 `mfa_enrollment_required` for a user
  // who has not enrolled yet).
  const required = me?.mfaEnrollmentRequired === true;
  // Off only when the deployment said so: while the features are unknown
  // (loading, failed) enrolment is offered; the API refuses it with 404
  // `feature_off` when it is off.
  const enrollAllowed = required || features === undefined || features.mfa;
  const [enrollment, setEnrollment] = useState<{
    secret: string;
    uri: string;
  }>();
  const [codes, setCodes] = useState<string[]>();
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: mfaQuery.queryKey }),
      queryClient.invalidateQueries({ queryKey: meQuery.queryKey }),
    ]);

  const enroll = useMutation({
    mutationFn: () => unwrap(api.POST('/v1/auth/mfa/enroll')),
    onSuccess: setEnrollment,
  });
  // Required and not yet enrolled: go straight to the QR code, once.
  const autoEnrolled = useRef(false);
  const { mutate: startEnrollment } = enroll;
  useEffect(() => {
    if (required && status.data?.enabled === false && !autoEnrolled.current) {
      autoEnrolled.current = true;
      startEnrollment();
    }
  }, [required, status.data?.enabled, startEnrollment]);
  const newCodes = useMutation({
    mutationFn: () => unwrap(api.POST('/v1/auth/mfa/recovery-codes')),
    onSuccess: async (result) => {
      setCodes(result.recoveryCodes);
      await refresh();
    },
  });
  // Shown once, to the session that asked: a session that changes under the
  // page (signed out, another account or tenant, here or in another tab)
  // never sees the codes or the secret, nor the mutations' results.
  useOnSessionChange(() => {
    setCodes(undefined);
    setEnrollment(undefined);
    enroll.reset();
    newCodes.reset();
    autoEnrolled.current = false;
  });
  const disable = useMutation({
    mutationFn: async () => {
      await api.DELETE('/v1/auth/mfa');
    },
    onSuccess: async () => {
      toast.success(t('account.mfa.disabled'));
      await refresh();
    },
  });

  return (
    <Section
      title={
        <span className="flex items-center gap-2">
          {t('account.mfa.title')}
          {status.data && (
            <Badge variant={status.data.enabled ? 'default' : 'outline'}>
              {status.data.enabled ? t('account.mfa.on') : t('account.mfa.off')}
            </Badge>
          )}
        </span>
      }
      description={t('account.mfa.description')}
    >
      {required && (
        <Alert variant="destructive">
          <ShieldAlertIcon />
          <AlertTitle>{t('account.mfa.requiredTitle')}</AlertTitle>
          <AlertDescription>{t('account.mfa.required')}</AlertDescription>
        </Alert>
      )}
      {codes && (
        <RecoveryCodes
          codes={codes}
          onDone={() => {
            // Shown once: nothing keeps them (the mutations' results too).
            setCodes(undefined);
            newCodes.reset();
          }}
        />
      )}
      {status.isPending ? (
        <Spinner />
      ) : status.data?.enabled ? (
        <>
          <p className="text-sm text-muted-foreground">
            {t('account.mfa.remaining', {
              count: status.data.remainingRecoveryCodes,
            })}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={newCodes.isPending}
              onClick={() => newCodes.mutate()}
            >
              {newCodes.isPending && <Spinner />}
              {t('account.mfa.newCodes')}
            </Button>
            <ConfirmButton
              variant="destructive"
              title={t('account.mfa.disableTitle')}
              description={t('account.mfa.disableDescription')}
              confirm={t('account.mfa.disable')}
              onConfirm={() => disable.mutateAsync()}
            >
              {t('account.mfa.disable')}
            </ConfirmButton>
          </div>
        </>
      ) : enrollment ? (
        <ConfirmEnrollment
          enrollment={enrollment}
          onConfirmed={async (recoveryCodes) => {
            setEnrollment(undefined);
            enroll.reset();
            setCodes(recoveryCodes);
            await refresh();
          }}
          onCancel={() => {
            setEnrollment(undefined);
            enroll.reset();
          }}
        />
      ) : enrollAllowed ? (
        <Button
          className="self-start"
          disabled={enroll.isPending}
          onClick={() => enroll.mutate()}
        >
          {enroll.isPending && <Spinner />}
          {t('account.mfa.enable')}
        </Button>
      ) : (
        <p className="text-sm text-muted-foreground">
          {t('account.mfa.unavailable')}
        </p>
      )}
    </Section>
  );
}

function ConfirmEnrollment(props: {
  enrollment: { secret: string; uri: string };
  onConfirmed: (recoveryCodes: string[]) => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [error, setError] = useState<string>();
  const confirm = useMutation({
    mutationFn: (code: string) =>
      unwrap(api.POST('/v1/auth/mfa/confirm', { body: { code } })),
    meta: { errorToast: false },
  });
  const form = useAppForm({
    defaultValues: { code: '' },
    validators: {
      onSubmit: z.object({
        code: z.string().regex(/^\d{6}$/, t('auth.mfa.codeInvalid')),
      }),
    },
    onSubmit: async ({ value }) => {
      setError(undefined);
      try {
        const result = await confirm.mutateAsync(value.code);
        confirm.reset();
        await props.onConfirmed(result.recoveryCodes);
      } catch (caught) {
        if (!applyFieldErrors(form, caught)) {
          setError(errorMessage(caught));
        }
        form.setFieldValue('code', '');
      }
    },
  });
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
      <QRCode
        value={props.enrollment.uri}
        size={176}
        className="shrink-0 self-center rounded-md border bg-white p-2"
        aria-label={t('account.mfa.qr')}
      >
        <QRCodeSkeleton />
        <QRCodeSvg />
      </QRCode>
      <form
        noValidate
        className="flex-1"
        onSubmit={(event) => {
          event.preventDefault();
          void form.handleSubmit();
        }}
      >
        <FieldGroup>
          <p className="text-sm text-muted-foreground">
            {t('account.mfa.scan')}
          </p>
          <p className="text-sm">
            {t('account.mfa.secret')}{' '}
            <code className="break-all rounded bg-muted px-1 py-0.5 font-mono text-xs">
              {props.enrollment.secret}
            </code>
          </p>
          <FormAlert message={error} />
          <form.AppField name="code">
            {(field) => (
              <field.CodeField
                label={t('auth.mfa.code')}
                onComplete={() => void form.handleSubmit()}
              />
            )}
          </form.AppField>
          <div className="flex gap-2">
            <form.AppForm>
              <form.SubmitButton>{t('account.mfa.confirm')}</form.SubmitButton>
            </form.AppForm>
            <Button type="button" variant="ghost" onClick={props.onCancel}>
              {t('account.cancel')}
            </Button>
          </div>
        </FieldGroup>
      </form>
    </div>
  );
}

/** The recovery codes, shown once: the user keeps them. */
function RecoveryCodes(props: { codes: string[]; onDone: () => void }) {
  const { t } = useTranslation();
  return (
    <Alert>
      <ShieldAlertIcon />
      <AlertTitle>{t('account.mfa.codesTitle')}</AlertTitle>
      <AlertDescription className="flex flex-col gap-3">
        <span>{t('account.mfa.codesHint')}</span>
        <ul className="grid grid-cols-2 gap-1 font-mono text-sm">
          {props.codes.map((code) => (
            <li key={code}>{code}</li>
          ))}
        </ul>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              void navigator.clipboard
                ?.writeText(props.codes.join('\n'))
                .then(() => toast.success(t('account.mfa.copied')));
            }}
          >
            {t('account.mfa.copy')}
          </Button>
          <Button size="sm" onClick={props.onDone}>
            {t('account.mfa.saved')}
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  );
}

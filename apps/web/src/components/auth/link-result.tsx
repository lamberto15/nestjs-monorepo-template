import { Link } from '@tanstack/react-router';
import {
  Alert,
  AlertDescription,
} from '@nestjs-monorepo-template/ui/components/alert';
import { Button } from '@nestjs-monorepo-template/ui/components/button';
import { CircleAlertIcon, CircleCheckIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

/** An outcome of an email link's page, with the way on. */
export function LinkResult(props: {
  ok: boolean;
  children: ReactNode;
  /** Something to do about the outcome, between it and the way on. */
  extra?: ReactNode;
  action?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-4">
      <Alert variant={props.ok ? 'default' : 'destructive'} role="status">
        {props.ok ? <CircleCheckIcon /> : <CircleAlertIcon />}
        <AlertDescription>{props.children}</AlertDescription>
      </Alert>
      {props.extra}
      {props.action ?? (
        <Button nativeButton={false} render={<Link to="/sign-in" />}>
          {t('auth.signIn.title')}
        </Button>
      )}
    </div>
  );
}

/** The page was opened without its link's token. */
export function MissingToken() {
  const { t } = useTranslation();
  return <LinkResult ok={false}>{t('auth.links.missingToken')}</LinkResult>;
}

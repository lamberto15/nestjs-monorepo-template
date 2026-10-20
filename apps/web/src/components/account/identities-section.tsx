import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { unwrap } from '@nestjs-monorepo-template/api-client';
import { Button } from '@nestjs-monorepo-template/ui/components/button';
import { Spinner } from '@nestjs-monorepo-template/ui/components/spinner';
import { LinkIcon } from 'lucide-react';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Section } from '@/components/account/section';
import { ConfirmButton } from '@/components/confirm-button';
import { providerName } from '@/components/login-form';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { formatDateTime } from '@/lib/date-time';
import { FormAlert } from '@/lib/form';
import { requestReauthentication } from '@/lib/reauth';
import { useMe } from '@/lib/features';
import { methodsQuery } from '@/lib/session';

export const identitiesQuery = queryOptions({
  queryKey: ['auth', 'identities'],
  queryFn: () => unwrap(api.GET('/v1/auth/identities')),
});

/**
 * The sign-in providers connected to the account (docs/auth.md, "Google,
 * Microsoft, GitHub"): list, disconnect (a recent sign-in, asked for by the
 * step-up dialog; the API refuses the last way to sign in, 409
 * `last_sign_in_method`, and its problem is the toast) and connect another.
 * Connecting is the API's own flow: the browser navigates to
 * `/v1/auth/oidc/{provider}/login?link=true` and comes back to this page.
 * `error` is what the API sent the browser back with, if the flow failed.
 */
export function IdentitiesSection(props: { error?: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  // The message is kept here and the parameter dropped from the address: the
  // banner doesn't outlive the visit, nor ride along when the step-up dialog
  // builds its `redirectTo` from the location.
  const [error] = useState(props.error);
  useEffect(() => {
    if (props.error) {
      void navigate({ to: '.', search: {}, replace: true });
    }
  }, [props.error, navigate]);
  const queryClient = useQueryClient();
  const me = useMe();
  const list = useQuery(identitiesQuery);
  const methods = useQuery(methodsQuery);
  const unlink = useMutation({
    mutationFn: async (provider: string) => {
      await api.DELETE('/v1/auth/identities/{provider}', {
        params: { path: { provider } },
      });
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: identitiesQuery.queryKey }),
  });
  const linked = list.data?.items ?? [];
  const connectable = (methods.data?.providers ?? []).filter(
    (provider) => !linked.some((identity) => identity.provider === provider),
  );
  const failed = list.isError || methods.isError;
  // Not shown before it is known whether there is anything to show: nothing
  // connected and nothing to connect is a deployment without providers. A
  // failed read is not "nothing": it says so, with a retry.
  if (
    !failed &&
    (methods.isPending ||
      (!list.isPending && linked.length === 0 && connectable.length === 0))
  ) {
    return null;
  }
  return (
    <Section
      title={t('account.identities.title')}
      description={t('account.identities.description')}
    >
      {error && (
        <FormAlert
          message={
            error === 'generic'
              ? t('account.identities.failed')
              : t(`auth.signIn.errors.${error}`)
          }
        />
      )}
      {failed ? (
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <p className="flex-1 text-muted-foreground">
            {t('account.identities.loadFailed')}
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void (list.isError ? list.refetch() : undefined);
              void (methods.isError ? methods.refetch() : undefined);
            }}
          >
            {t('account.identities.retry')}
          </Button>
        </div>
      ) : list.isPending ? (
        <Spinner />
      ) : linked.length > 0 ? (
        <ul className="flex flex-col divide-y rounded-md border">
          {linked.map((identity) => (
            <li
              key={identity.provider}
              className="flex flex-wrap items-center gap-3 p-3"
            >
              <LinkIcon className="size-4 text-muted-foreground" />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate font-medium">
                  {providerName(identity.provider)}
                </span>
                <span className="truncate text-xs text-muted-foreground">
                  {[
                    identity.email,
                    t('account.identities.connectedOn', {
                      date: formatDateTime(identity.createdAt),
                    }),
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </div>
              <ConfirmButton
                size="sm"
                variant="ghost"
                label={t('account.identities.disconnectLabel', {
                  provider: providerName(identity.provider),
                })}
                title={t('account.identities.disconnectTitle', {
                  provider: providerName(identity.provider),
                })}
                description={t('account.identities.disconnectDescription', {
                  provider: providerName(identity.provider),
                })}
                confirm={t('account.identities.disconnect')}
                onConfirm={() => unlink.mutateAsync(identity.provider)}
              >
                {t('account.identities.disconnect')}
              </ConfirmButton>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">
          {t('account.identities.none')}
        </p>
      )}
      {!failed &&
        connectable.length > 0 &&
        (me?.user.emailVerified === false ? (
          <p className="text-sm text-muted-foreground">
            {t('account.identities.unverified')}
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {connectable.map((provider) => (
              <ConnectButton
                key={provider}
                provider={provider}
                recentUntil={me?.authentication?.recentUntil}
              />
            ))}
          </div>
        ))}
    </Section>
  );
}

/**
 * A full navigation (the API redirects to the provider and back). Linking
 * wants a recent sign-in, and a stale one is bounced back by the API with
 * `?error=reauthentication_required`: so a session that may be stale asks
 * `GET /v1/auth/reauthenticate` first, and the step-up dialog when it is.
 */
function ConnectButton(props: {
  provider: string;
  recentUntil: string | null | undefined;
}) {
  const { t } = useTranslation();
  const href = `/v1/auth/oidc/${encodeURIComponent(props.provider)}/login?link=true&redirectTo=${encodeURIComponent('/account/security')}`;
  const recent = (until: string | null | undefined) =>
    !!until && new Date(until).getTime() > Date.now();
  return (
    <Button
      variant="outline"
      nativeButton={false}
      render={
        <a
          href={href}
          onClick={async (event) => {
            // Always by the handler (not the anchor's own navigation), so a
            // stale sign-in is stepped up first and one place navigates.
            event.preventDefault();
            try {
              if (!recent(props.recentUntil)) {
                const status = await unwrap(api.GET('/v1/auth/reauthenticate'));
                if (
                  !recent(status.recentUntil) &&
                  !(await requestReauthentication({
                    status: 403,
                    code: 'reauthentication_required',
                    methods: status.methods,
                    mfaRequired: status.mfaRequired,
                  }))
                ) {
                  return;
                }
              }
              location.assign(href);
            } catch (caught) {
              toast.error(errorMessage(caught));
            }
          }}
        />
      }
    >
      {t('account.identities.connect', {
        provider: providerName(props.provider),
      })}
    </Button>
  );
}

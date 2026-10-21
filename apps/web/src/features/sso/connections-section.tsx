import { Badge } from '@nestjs-monorepo-template/ui/components/badge';
import { Button } from '@nestjs-monorepo-template/ui/components/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@nestjs-monorepo-template/ui/components/card';
import { Skeleton } from '@nestjs-monorepo-template/ui/components/skeleton';
import { Switch } from '@nestjs-monorepo-template/ui/components/switch';
import { useQuery } from '@tanstack/react-query';
import {
  ExternalLinkIcon,
  UsersIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
} from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { formatDateTime } from '@/lib/date-time';
import { errorMessage } from '@/lib/errors';
import { ConnectionDialog } from './connection-dialog';
import { CopyValue } from './copy-value';
import { RoleMappingsDialog } from './role-mappings-dialog';
import {
  connectionsQuery,
  useRefreshConnection,
  useRemoveConnection,
  useUpdateConnection,
  type Connection,
} from './queries';

/** `/v1/auth/sso/<tenant>/<connection>/login` → the tenant's id. */
export function tenantIdOf(loginUrl: string) {
  return /\/auth\/sso\/([^/]+)\/[^/]+\/login/.exec(loginUrl)?.[1];
}

export function ConnectionsSection() {
  const { t } = useTranslation('sso');
  const connections = useQuery({
    ...connectionsQuery,
    meta: { errorToast: false },
  });
  const [editing, setEditing] = useState<Connection | 'new'>();
  const [mapping, setMapping] = useState<Connection>();
  const [removing, setRemoving] = useState<Connection>();
  const [confirming, setConfirming] = useState(false);
  const remove = useRemoveConnection();

  return (
    <section className="flex flex-col gap-4" aria-labelledby="sso-connections">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 id="sso-connections" className="text-base font-medium">
            {t('connections.title')}
          </h2>
          <p className="text-sm text-muted-foreground">
            {t('connections.description')}
          </p>
        </div>
        <Button onClick={() => setEditing('new')}>
          <PlusIcon />
          {t('connections.add')}
        </Button>
      </div>
      {connections.isPending && <Skeleton className="h-32 w-full" aria-busy />}
      {connections.isError && (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(connections.error)}
        </p>
      )}
      {connections.isSuccess && connections.data.items.length === 0 && (
        <p role="status" className="text-sm text-muted-foreground">
          {t('connections.none')}
        </p>
      )}
      {connections.isSuccess &&
        connections.data.items.map((connection) => (
          <ConnectionCard
            key={connection.id}
            connection={connection}
            onEdit={() => setEditing(connection)}
            onMappings={() => setMapping(connection)}
            onRemove={() => {
              setRemoving(connection);
              setConfirming(true);
            }}
          />
        ))}
      {editing && (
        <ConnectionDialog
          // Remounted for another connection: its fields start from it.
          key={editing === 'new' ? 'new' : editing.id}
          connection={editing === 'new' ? undefined : editing}
          onOpenChange={(open) => !open && setEditing(undefined)}
        />
      )}
      {mapping && (
        <RoleMappingsDialog
          key={mapping.id}
          connection={mapping}
          onOpenChange={(open) => !open && setMapping(undefined)}
        />
      )}
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t('connections.removeTitle', { name: removing?.name })}
        description={t('connections.removeDescription')}
        confirm={t('connections.remove')}
        onConfirm={async () => {
          if (!removing) return;
          await remove.mutateAsync(removing.id);
          toast.success(t('connections.removed', { name: removing.name }));
          setConfirming(false);
        }}
      />
    </section>
  );
}

function ConnectionCard(props: {
  connection: Connection;
  onEdit: () => void;
  onMappings: () => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation('sso');
  const { connection } = props;
  const update = useUpdateConnection();
  const refresh = useRefreshConnection();
  const tenantId = tenantIdOf(connection.loginUrl);
  const switchId = `sso-enabled-${connection.id}`;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2">
            {connection.name}
            <Badge variant="secondary">
              {t(`protocol.${connection.protocol}`)}
            </Badge>
            {connection.saml?.requireEncryptedAssertions && (
              <Badge variant="outline">
                {t('details.requireEncryptedAssertions')}
              </Badge>
            )}
            {connection.jitProvisioning && (
              <Badge variant="outline">{t('connections.jitBadge')}</Badge>
            )}
          </CardTitle>
          <div className="flex items-center gap-2">
            <label htmlFor={switchId} className="text-sm">
              {connection.enabled
                ? t('connections.enabled')
                : t('connections.disabled')}
            </label>
            <Switch
              id={switchId}
              checked={connection.enabled}
              disabled={update.isPending}
              onCheckedChange={(enabled) =>
                update.mutate(
                  { id: connection.id, changes: { enabled } },
                  {
                    onSuccess: () =>
                      toast.success(
                        t(
                          enabled
                            ? 'connections.turnedOn'
                            : 'connections.turnedOff',
                          { name: connection.name },
                        ),
                      ),
                    onError: (error) => toast.error(errorMessage(error)),
                  },
                )
              }
            />
          </div>
        </div>
        <CardDescription>
          {t('connections.created_at', {
            date: formatDateTime(connection.createdAt),
          })}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {connection.oidc && (
          <p className="text-sm" role="status">
            {connection.oidc.metadataError
              ? t('connections.discoveryError', {
                  error: connection.oidc.metadataError,
                })
              : connection.oidc.metadataFetchedAt
                ? t('connections.discoveryOk', {
                    date: formatDateTime(connection.oidc.metadataFetchedAt),
                  })
                : t('connections.discoveryPending')}
          </p>
        )}
        {connection.oauth2 && (
          // No discovery document: the endpoints are the connection's own
          // fields, so it is ready as soon as it is on.
          <p className="text-sm" role="status">
            {connection.enabled
              ? t('connections.oauth2Ready')
              : t('connections.oauth2Off')}
          </p>
        )}
        <dl className="grid gap-3 md:grid-cols-2">
          {connection.oidc && (
            <>
              <CopyValue
                label={t('details.redirectUri')}
                value={connection.oidc.redirectUri}
              />
              <CopyValue
                label={t('form.issuer')}
                value={connection.oidc.issuer}
              />
            </>
          )}
          {connection.oauth2 && (
            <>
              <CopyValue
                label={t('details.redirectUri')}
                value={connection.oauth2.redirectUri}
              />
              <CopyValue
                label={t('form.authorizationEndpoint')}
                value={connection.oauth2.authorizationEndpoint}
              />
            </>
          )}
          {connection.saml && (
            <>
              <CopyValue
                label={t('details.spEntityId')}
                value={connection.saml.spEntityId}
              />
              <CopyValue
                label={t('details.acsUrl')}
                value={connection.saml.acsUrl}
              />
              <CopyValue
                label={t('details.metadataUrl')}
                value={connection.saml.metadataUrl}
              />
              <div className="flex flex-col gap-1">
                <dt className="text-xs text-muted-foreground">
                  {t('details.certificates')}
                </dt>
                <dd className="flex flex-col gap-1 text-xs">
                  {connection.saml.idpCertificates.map((cert) => (
                    <span key={cert.fingerprint256} className="break-all">
                      {cert.subject} ·{' '}
                      {t('details.validUntil', {
                        date: formatDateTime(cert.notAfter),
                      })}
                    </span>
                  ))}
                </dd>
              </div>
            </>
          )}
          {tenantId && (
            <>
              <CopyValue label={t('details.tenantId')} value={tenantId} />
              <CopyValue
                label={t('details.connectionId')}
                value={connection.id}
              />
            </>
          )}
        </dl>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={props.onEdit}>
            <PencilIcon />
            {t('connections.edit')}
          </Button>
          <Button variant="outline" size="sm" onClick={props.onMappings}>
            <UsersIcon />
            {t('connections.mappings')}
          </Button>
          {connection.enabled ? (
            <Button
              variant="outline"
              size="sm"
              nativeButton={false}
              render={
                // A full navigation in a new tab: the API redirects to the
                // IdP, and the outcome lands on the web app.
                <a
                  href={`${connection.loginUrl}?redirectTo=${encodeURIComponent('/sso')}`}
                  target="_blank"
                  rel="noopener noreferrer"
                />
              }
            >
              <ExternalLinkIcon />
              {t('connections.test')}
            </Button>
          ) : (
            // Off: the login route answers 404, so no link to follow.
            <Button variant="outline" size="sm" disabled>
              <ExternalLinkIcon />
              {t('connections.test')}
            </Button>
          )}
          {connection.oidc && (
            <Button
              variant="outline"
              size="sm"
              disabled={refresh.isPending}
              onClick={() =>
                refresh.mutate(connection.id, {
                  onSuccess: () => toast.success(t('connections.refreshing')),
                })
              }
            >
              <RefreshCwIcon />
              {t('connections.refresh')}
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={props.onRemove}>
            <Trash2Icon />
            {t('connections.remove')}
          </Button>
        </div>
        {!connection.enabled && (
          <p className="text-xs text-muted-foreground">
            {t('connections.testOff')}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

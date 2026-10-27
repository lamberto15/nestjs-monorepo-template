import { Badge } from '@nestjs-monorepo-template/ui/components/badge';
import { Button } from '@nestjs-monorepo-template/ui/components/button';
import { Spinner } from '@nestjs-monorepo-template/ui/components/spinner';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@nestjs-monorepo-template/ui/components/table';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { PlusIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { useSwitchTenant } from '@/components/tenant-switcher';
import { EmptyState } from '@/components/empty-state';
import { Page, PageHeader } from '@/components/page-header';
import { formatDateTime } from '@/lib/date-time';
import { errorMessage } from '@/lib/errors';
import { useMe } from '@/lib/features';
import { tenantsQuery } from '@/lib/session';
import { FormAlert } from '@/lib/form';
import { CreateTenantDialog } from './create-tenant-dialog';
import { deletionPending, tenantsAdminQuery, useCreateTenant } from './queries';

/**
 * Every tenant of the deployment, for its operators, and a form to make one
 * with its first administrator. A name opens the tenant (rename, slug,
 * deactivate: `tenant-detail.tsx`). A tenant the user is a member of can be
 * switched to from here.
 */
export function TenantsPage() {
  const { t } = useTranslation('tenants');
  const list = useQuery(tenantsAdminQuery);
  const mine = useQuery(tenantsQuery);
  const me = useMe();
  const [creating, setCreating] = useState(false);
  const create = useCreateTenant();
  const switchTenant = useSwitchTenant();
  const memberOf = new Set(mine.data?.items.map((tenant) => tenant.id));
  return (
    <Page>
      <PageHeader
        title={t('list.title')}
        description={t('list.description')}
        actions={
          <Button onClick={() => setCreating(true)}>
            <PlusIcon />
            {t('list.create')}
          </Button>
        }
      />
      {list.isPending ? (
        <Spinner />
      ) : list.isError ? (
        <FormAlert message={errorMessage(list.error)} />
      ) : list.data.items.length ? (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('list.columns.name')}</TableHead>
                <TableHead>{t('list.columns.slug')}</TableHead>
                <TableHead>{t('list.columns.status')}</TableHead>
                <TableHead>{t('list.columns.created')}</TableHead>
                <TableHead>
                  <span className="sr-only">{t('list.columns.actions')}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.data.items.map((tenant) => (
                <TableRow key={tenant.id}>
                  <TableCell className="font-medium">
                    <Link
                      to="/tenants/$id"
                      params={{ id: tenant.id }}
                      className="underline-offset-4 hover:underline"
                    >
                      {tenant.name}
                    </Link>
                    {tenant.operator && (
                      <Badge variant="secondary" className="ms-2">
                        {t('list.operator')}
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {tenant.slug}
                  </TableCell>
                  <TableCell>
                    <Badge variant={tenant.active ? 'default' : 'outline'}>
                      {t(`status.${tenant.active ? 'active' : 'inactive'}`)}
                    </Badge>
                    {deletionPending(tenant) ? (
                      <Badge
                        variant="destructive"
                        className="ms-2"
                        title={t('list.erasedOn', {
                          date: formatDateTime(tenant.deletionScheduledFor),
                        })}
                      >
                        {t('status.deletionPending')}
                      </Badge>
                    ) : (
                      tenant.deletionStartedAt && (
                        <Badge variant="destructive" className="ms-2">
                          {t('status.erasing')}
                        </Badge>
                      )
                    )}
                  </TableCell>
                  <TableCell>{formatDateTime(tenant.createdAt)}</TableCell>
                  <TableCell className="text-end">
                    {tenant.id === me?.tenant?.id ? (
                      <span className="text-xs text-muted-foreground">
                        {t('list.current')}
                      </span>
                    ) : (
                      memberOf.has(tenant.id) && (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={switchTenant.isPending}
                          onClick={() => switchTenant.mutate(tenant.id)}
                        >
                          {t('list.switch')}
                        </Button>
                      )
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <EmptyState title={t('list.empty')} />
      )}
      <CreateTenantDialog
        open={creating}
        onOpenChange={setCreating}
        onCreate={async (body) => {
          const tenant = await create.mutateAsync(body);
          toast.success(
            t('create.done', {
              name: tenant.name,
              email: body.administratorEmail,
            }),
          );
          return tenant;
        }}
      />
    </Page>
  );
}

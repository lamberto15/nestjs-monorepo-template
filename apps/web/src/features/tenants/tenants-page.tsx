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
import { PlusIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { useSwitchTenant } from '@/components/tenant-switcher';
import { formatDateTime } from '@/lib/date-time';
import { errorMessage } from '@/lib/errors';
import { useMe } from '@/lib/features';
import { tenantsQuery } from '@/lib/session';
import { FormAlert } from '@/lib/form';
import { CreateTenantDialog } from './create-tenant-dialog';
import { tenantsAdminQuery, useCreateTenant } from './queries';

/**
 * Every tenant of the deployment, for its operators, and a form to make one
 * with its first administrator. The API has no more for a tenant yet
 * (docs/tenancy.md: deactivating, renaming, deleting are roadmap 1b), so
 * there is no detail page. A tenant the user is a member of can be switched
 * to from here.
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
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex-1">
          <h1 className="text-xl font-medium">{t('list.title')}</h1>
          <p className="text-sm text-muted-foreground">
            {t('list.description')}
          </p>
        </div>
        <Button onClick={() => setCreating(true)}>
          <PlusIcon />
          {t('list.create')}
        </Button>
      </div>
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
                    {tenant.name}
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
        <p className="text-sm text-muted-foreground">{t('list.empty')}</p>
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
    </div>
  );
}

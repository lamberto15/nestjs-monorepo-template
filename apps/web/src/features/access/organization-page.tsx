import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
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
import { PencilIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ConfirmButton } from '@/components/confirm-button';
import { Page, PageHeader } from '@/components/page-header';
import {
  deleteUnit,
  invalidateAccess,
  unitsQuery,
  type Unit,
} from '@/features/access/api';
import { orderedTree } from '@/features/access/pickers';
import { UnitDialog, unitErrorMessage } from '@/features/access/unit-dialog';
import { errorMessage } from '@/lib/errors';
import { useCan } from '@/lib/features';
import { FormAlert } from '@/lib/form';

/**
 * The organization structure (docs/permissions.md, "Organization hierarchy"):
 * the tree of units, what "in my units" covers. Deleting wants an empty unit
 * (409 `unit_not_empty` otherwise); a unit the IdP manages over SCIM is
 * changed there (409 `unit_managed_by_scim`).
 * Whoever manages users reads it too (to reach a unit's members); changing
 * the tree wants manageOrganizationalUnits.
 */
export function OrganizationPage() {
  const { t } = useTranslation('access');
  const units = useQuery(unitsQuery);
  const mayChange = useCan('Access.manageOrganizationalUnits');
  const [editing, setEditing] = useState<Unit | 'new'>();
  return (
    <Page>
      <PageHeader
        title={t('units.title')}
        actions={
          mayChange && (
            <Button onClick={() => setEditing('new')}>
              <PlusIcon />
              {t('units.new')}
            </Button>
          )
        }
      />
      {units.isPending ? (
        <Spinner />
      ) : units.isError ? (
        <FormAlert message={errorMessage(units.error)} />
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('units.columns.name')}</TableHead>
                <TableHead>{t('units.columns.type')}</TableHead>
                <TableHead>{t('units.columns.members')}</TableHead>
                <TableHead>
                  <span className="sr-only">{t('actions')}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {units.data.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="text-muted-foreground">
                    {t('units.none')}
                  </TableCell>
                </TableRow>
              )}
              {orderedTree(units.data).map((unit) => (
                <UnitRow
                  key={unit.id}
                  unit={unit}
                  mayChange={mayChange}
                  onEdit={() => setEditing(unit)}
                />
              ))}
            </TableBody>
          </Table>
          <UnitDialog
            open={editing !== undefined}
            onOpenChange={(open) => !open && setEditing(undefined)}
            units={units.data}
            unit={editing === 'new' ? undefined : editing}
          />
        </>
      )}
    </Page>
  );
}

function UnitRow(props: {
  unit: Unit;
  mayChange: boolean;
  onEdit: () => void;
}) {
  const { t } = useTranslation('access');
  const { unit } = props;
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: () => deleteUnit(unit.id),
    meta: { errorToast: false },
    onError: (error) => toast.error(unitErrorMessage(error, t)),
    onSuccess: async () => {
      toast.success(t('units.deleted', { name: unit.name }));
      await invalidateAccess(queryClient);
    },
  });
  return (
    <TableRow>
      <TableCell>
        <span style={{ paddingInlineStart: `${unit.depth * 1.25}rem` }}>
          <Link
            to="/access/organization/$unitId"
            params={{ unitId: unit.id }}
            className="font-medium hover:underline"
          >
            {unit.name}
          </Link>
        </span>
      </TableCell>
      <TableCell>{t(`units.types.${unit.type}`)}</TableCell>
      <TableCell>
        {unit.members}
        {unit.managedByScim && (
          <Badge variant="outline" className="ms-2">
            {t('units.scim')}
          </Badge>
        )}
      </TableCell>
      <TableCell>
        {props.mayChange && (
          <div className="flex justify-end gap-2">
            <Button
              size="sm"
              variant="outline"
              className="pointer-coarse:h-10"
              onClick={props.onEdit}
            >
              <PencilIcon />
              {t('units.edit')}
            </Button>
            <ConfirmButton
              size="sm"
              variant="outline"
              className="pointer-coarse:h-10"
              title={t('units.deleteTitle', { name: unit.name })}
              description={t('units.deleteDescription')}
              confirm={t('units.delete')}
              onConfirm={() => remove.mutateAsync()}
            >
              <Trash2Icon />
              {t('units.delete')}
            </ConfirmButton>
          </div>
        )}
      </TableCell>
    </TableRow>
  );
}

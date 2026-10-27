import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  Alert,
  AlertDescription,
} from '@nestjs-monorepo-template/ui/components/alert';
import {
  Button,
  buttonVariants,
} from '@nestjs-monorepo-template/ui/components/button';
import {
  Field,
  FieldLabel,
} from '@nestjs-monorepo-template/ui/components/field';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@nestjs-monorepo-template/ui/components/select';
import { Spinner } from '@nestjs-monorepo-template/ui/components/spinner';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@nestjs-monorepo-template/ui/components/table';
import { ArrowLeftIcon } from 'lucide-react';
import { Page, PageHeader } from '@/components/page-header';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ConfirmButton } from '@/components/confirm-button';
import { PersonName } from '@/components/person-name';
import { PrincipalPicker } from '@/components/principal-picker';
import {
  addUnitMember,
  changeUnitMember,
  invalidateAccess,
  removeUnitMember,
  unitMembersQuery,
  unitsQuery,
  type UnitMember,
} from '@/features/access/api';
import { unitErrorMessage } from '@/features/access/unit-dialog';
import { errorMessage } from '@/lib/errors';
import { useCan } from '@/lib/features';
import { FormAlert } from '@/lib/form';

type Role = UnitMember['role'];

const ROLES: Role[] = ['member', 'lead'];

function RoleSelect(props: {
  id?: string;
  label: string;
  value: Role;
  onChange: (role: Role) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation('access');
  const options = ROLES.map((value) => ({
    value,
    label: t(`units.roles.${value}`),
  }));
  return (
    <Select
      items={options}
      value={props.value}
      disabled={props.disabled}
      onValueChange={(value) => value && props.onChange(value as Role)}
    >
      <SelectTrigger id={props.id} aria-label={props.label} className="w-40">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * A unit's current members (`GET /v1/access/organizational-units/{id}/members`)
 * with their role, member or lead. Adding, changing the role and ending a
 * membership want Access.manageUsers. Whom to add is searched
 * (`GET /v1/access/principals`); the members' names come from the people
 * lookup (the API lists user ids only).
 */
export function UnitMembers(props: { unitId: string }) {
  const { t } = useTranslation('access');
  const units = useQuery(unitsQuery);
  const members = useQuery(unitMembersQuery(props.unitId));
  const mayChange = useCan('Access.manageUsers');
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState('');
  const [role, setRole] = useState<Role>('member');
  // A new picker (an empty input) after each addition.
  const [picker, setPicker] = useState(0);
  const [error, setError] = useState<string>();
  const change = useMutation({
    mutationFn: (action: () => Promise<unknown>) => action(),
    meta: { errorToast: false },
    onSuccess: () => invalidateAccess(queryClient),
  });
  const run = async (action: () => Promise<unknown>, done: string) => {
    setError(undefined);
    try {
      await change.mutateAsync(action);
      toast.success(done);
    } catch (caught) {
      setError(unitErrorMessage(caught, t));
      throw caught;
    }
  };

  if (units.isPending || members.isPending) return <Spinner />;
  if (units.isError || members.isError) {
    return <FormAlert message={errorMessage(units.error ?? members.error)} />;
  }
  const unit = units.data.find((item) => item.id === props.unitId);
  if (!unit) {
    return <FormAlert message={t('units.notFound')} />;
  }
  const inUnit = members.data;

  return (
    <Page>
      <div>
        <Link
          to="/access/organization"
          aria-label={t('units.back')}
          className={buttonVariants({ variant: 'ghost', size: 'icon-sm' })}
        >
          <ArrowLeftIcon className="rtl:rotate-180" />
        </Link>
      </div>
      <PageHeader title={unit.name} />
      <FormAlert message={error} />
      {!mayChange && (
        <Alert>
          <AlertDescription>{t('units.needsManageUsers')}</AlertDescription>
        </Alert>
      )}
      {mayChange && (
        <div className="flex flex-wrap items-end gap-2">
          <Field className="max-w-sm">
            <FieldLabel htmlFor="unit-add">{t('units.addMember')}</FieldLabel>
            <PrincipalPicker
              key={picker}
              id="unit-add"
              label={t('units.addMember')}
              placeholder={t('units.pickMember')}
              kind="user"
              active
              by="id"
              // Nobody is added twice.
              exclude={inUnit.map((m) => m.userId)}
              value={adding}
              onChange={(value) => setAdding(value)}
            />
          </Field>
          <Field className="w-40">
            <FieldLabel htmlFor="unit-add-role">
              {t('units.columns.role')}
            </FieldLabel>
            <RoleSelect
              id="unit-add-role"
              label={t('units.columns.role')}
              value={role}
              onChange={setRole}
            />
          </Field>
          <Button
            disabled={!adding || change.isPending}
            onClick={() =>
              void run(
                () => addUnitMember(unit.id, { userId: adding, role }),
                t('units.memberAdded'),
              )
                .then(() => {
                  setAdding('');
                  setPicker((n) => n + 1);
                })
                .catch(() => {})
            }
          >
            {change.isPending && <Spinner />}
            {t('units.add')}
          </Button>
        </div>
      )}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('units.columns.member')}</TableHead>
            <TableHead>{t('units.columns.role')}</TableHead>
            <TableHead>
              <span className="sr-only">{t('actions')}</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {inUnit.length === 0 && (
            <TableRow>
              <TableCell colSpan={3} className="text-muted-foreground">
                {t('units.noMembers')}
              </TableCell>
            </TableRow>
          )}
          {inUnit.map((member) => (
            <TableRow key={member.id}>
              <TableCell className="font-medium">
                <PersonName value={`user:${member.userId}`} />
              </TableCell>
              <TableCell>
                {mayChange ? (
                  <RoleSelect
                    label={t('units.columns.role')}
                    value={member.role}
                    disabled={change.isPending}
                    onChange={(next) =>
                      void run(
                        () => changeUnitMember(unit.id, member.userId, next),
                        t('units.roleChanged'),
                      ).catch(() => {})
                    }
                  />
                ) : (
                  t(`units.roles.${member.role}`)
                )}
              </TableCell>
              <TableCell className="text-end">
                {mayChange && (
                  <ConfirmButton
                    size="sm"
                    variant="ghost"
                    title={t('units.removeTitle', { unit: unit.name })}
                    description={t('units.removeDescription')}
                    confirm={t('units.remove')}
                    onConfirm={() =>
                      run(
                        () => removeUnitMember(unit.id, member.userId),
                        t('units.memberRemoved'),
                      )
                    }
                  >
                    {t('units.remove')}
                  </ConfirmButton>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Page>
  );
}

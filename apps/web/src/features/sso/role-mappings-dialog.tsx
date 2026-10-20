import { Button } from '@nestjs-monorepo-template/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@nestjs-monorepo-template/ui/components/dialog';
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '@nestjs-monorepo-template/ui/components/field';
import { Input } from '@nestjs-monorepo-template/ui/components/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@nestjs-monorepo-template/ui/components/select';
import { useQuery } from '@tanstack/react-query';
import { PlusIcon, Trash2Icon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { rolesQuery } from '@/features/access/api';
import { errorMessage } from '@/lib/errors';
import { FormAlert } from '@/lib/form';
import { useUpdateConnection, type Connection } from './queries';

type Mapping = { group: string; roleId: string };

/**
 * A connection's group-to-role mappings (docs/auth.md, "Roles from the
 * IdP"): where the IdP lists the groups, and which role each group gives at
 * every sign-in. The API replaces the whole list on a save, so the dialog
 * edits a copy and sends it at once. Whoever saves must be able to grant
 * each role (403 otherwise, shown here).
 */
export function RoleMappingsDialog(props: {
  connection: Connection;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation('sso');
  const { connection } = props;
  const roles = useQuery({ ...rolesQuery, meta: { errorToast: false } });
  const update = useUpdateConnection();
  const [attribute, setAttribute] = useState(connection.groupsAttribute ?? '');
  const [mappings, setMappings] = useState<Mapping[]>(
    connection.roleMappings ?? [],
  );
  const [group, setGroup] = useState('');
  const [roleId, setRoleId] = useState('');
  const [error, setError] = useState<string>();

  const options = (roles.data ?? []).map((role) => ({
    value: role.id,
    label: role.name,
  }));
  const roleName = (id: string) =>
    options.find((option) => option.value === id)?.label ?? id;

  const add = () => {
    const name = group.trim();
    if (!name || !roleId) {
      setError(t('mappings.incomplete'));
      return;
    }
    setError(undefined);
    if (!mappings.some((m) => m.group === name && m.roleId === roleId)) {
      setMappings([...mappings, { group: name, roleId }]);
    }
    setGroup('');
  };

  const save = async () => {
    setError(undefined);
    try {
      await update.mutateAsync({
        id: connection.id,
        changes: {
          groupsAttribute: attribute.trim() || null,
          roleMappings: mappings,
        },
      });
      toast.success(t('mappings.saved', { name: connection.name }));
      props.onOpenChange(false);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };

  return (
    <Dialog open onOpenChange={props.onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {t('mappings.title', { name: connection.name })}
          </DialogTitle>
          <DialogDescription>{t('mappings.description')}</DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <FormAlert
            message={roles.isError ? errorMessage(roles.error) : error}
          />
          <Field>
            <FieldLabel htmlFor="mappings-attribute">
              {t('mappings.attribute')}
            </FieldLabel>
            <Input
              id="mappings-attribute"
              value={attribute}
              placeholder="groups"
              maxLength={256}
              onChange={(event) => setAttribute(event.target.value)}
            />
            <FieldDescription>{t('mappings.attributeHint')}</FieldDescription>
          </Field>
          <div className="flex flex-col gap-2">
            {mappings.length === 0 && (
              <p role="status" className="text-sm text-muted-foreground">
                {t('mappings.none')}
              </p>
            )}
            <ul className="flex flex-col gap-2">
              {mappings.map((mapping) => (
                <li
                  key={`${mapping.group}\u0000${mapping.roleId}`}
                  className="flex items-center justify-between gap-2 rounded-md border p-2 text-sm"
                >
                  <span className="break-all">
                    {t('mappings.row', {
                      group: mapping.group,
                      role: roleName(mapping.roleId),
                    })}
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    aria-label={t('mappings.removeLabel', {
                      group: mapping.group,
                      role: roleName(mapping.roleId),
                    })}
                    onClick={() =>
                      setMappings(mappings.filter((m) => m !== mapping))
                    }
                  >
                    <Trash2Icon />
                  </Button>
                </li>
              ))}
            </ul>
          </div>
          <div className="flex flex-col gap-3 rounded-md border p-3">
            <Field>
              <FieldLabel htmlFor="mappings-group">
                {t('mappings.group')}
              </FieldLabel>
              <Input
                id="mappings-group"
                value={group}
                maxLength={256}
                onChange={(event) => setGroup(event.target.value)}
              />
              <FieldDescription>{t('mappings.groupHint')}</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="mappings-role">
                {t('mappings.role')}
              </FieldLabel>
              <Select
                items={options}
                value={roleId || null}
                onValueChange={(value) => setRoleId(value ?? '')}
              >
                <SelectTrigger id="mappings-role" className="w-full">
                  <SelectValue placeholder={t('mappings.rolePlaceholder')} />
                </SelectTrigger>
                <SelectContent>
                  {options.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Button type="button" variant="outline" size="sm" onClick={add}>
              <PlusIcon />
              {t('mappings.add')}
            </Button>
          </div>
        </FieldGroup>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => props.onOpenChange(false)}
          >
            {t('form.cancel')}
          </Button>
          <Button type="button" disabled={update.isPending} onClick={save}>
            {t('form.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

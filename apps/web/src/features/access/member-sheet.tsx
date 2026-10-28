import { UserAvatar } from '@/components/user-avatar';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  AlertDescription,
} from '@nestjs-monorepo-template/ui/components/alert';
import { Badge } from '@nestjs-monorepo-template/ui/components/badge';
import { Button } from '@nestjs-monorepo-template/ui/components/button';
import { Separator } from '@nestjs-monorepo-template/ui/components/separator';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@nestjs-monorepo-template/ui/components/sheet';
import { Spinner } from '@nestjs-monorepo-template/ui/components/spinner';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ConfirmButton } from '@/components/confirm-button';
import {
  invalidateAccess,
  memberQuery,
  rolesQuery,
  unitsQuery,
  updateMember,
  type Member,
  type MemberChanges,
  type Role,
} from '@/features/access/api';
import {
  draftOf,
  endInPast,
  grantsBody,
  isEnded,
  type GrantDraft,
} from '@/features/access/grants';
import { AccessExplanation } from '@/features/access/access-explanation';
import { ImpersonateButton } from '@/features/access/impersonate-button';
import { RoleGrantsPicker, UnitsPicker } from '@/features/access/pickers';
import { formatDateTime } from '@/lib/date-time';
import { errorMessage } from '@/lib/errors';
import { useCan, useMe } from '@/lib/features';
import { FormAlert } from '@/lib/form';

/**
 * A member of the tenant: their roles (with ends), units and status, and
 * what an administrator may do about them (`PATCH /v1/access/users/{id}`,
 * docs/tenancy.md "Accounts and sessions"): never their name or password.
 * The member is read on their own (`GET /v1/access/users/{id}`): a list row
 * may hold only the columns shown.
 */
export function MemberSheet(props: {
  memberId: string | undefined;
  onClose: () => void;
}) {
  const { t } = useTranslation('access');
  const read = useQuery({
    ...memberQuery(props.memberId ?? ''),
    enabled: props.memberId !== undefined,
  });
  const member = props.memberId === undefined ? undefined : read.data;
  return (
    <Sheet
      open={props.memberId !== undefined}
      onOpenChange={(open) => !open && props.onClose()}
    >
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
        {member ? (
          <>
            <SheetHeader>
              <UserAvatar
                size="lg"
                name={member.name || member.email}
                src={member.avatarUrl}
              />
              <SheetTitle>{member.name || member.email}</SheetTitle>
              <SheetDescription>{member.email}</SheetDescription>
            </SheetHeader>
            <div className="flex flex-col gap-6 px-4 pb-6">
              <MemberDetail
                // A new member, a fresh draft.
                key={member.id + member.updatedAt}
                member={member}
                onDone={props.onClose}
              />
            </div>
          </>
        ) : (
          <>
            <SheetHeader>
              <SheetTitle>{t('users.title')}</SheetTitle>
            </SheetHeader>
            <div className="px-4">
              {read.isError ? (
                <FormAlert message={errorMessage(read.error)} />
              ) : (
                <Spinner />
              )}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

function MemberDetail(props: { member: Member; onDone: () => void }) {
  const { t } = useTranslation('access');
  const { member } = props;
  const me = useMe();
  const self = me?.user.id === member.id;
  // Read-only for whoever reads the members without managing them.
  const mayManage = useCan('Access.manageUsers');
  // Explaining access: who hands out roles or manages members (AccessPolicy.explain).
  const mayExplain = useCan('Access.manageRoles') || mayManage;
  const queryClient = useQueryClient();
  const roles = useQuery(rolesQuery);
  const units = useQuery(unitsQuery);
  const [grants, setGrants] = useState<GrantDraft>(() => draftOf(member.roles));
  const [error, setError] = useState<string>();
  const change = useMutation({
    mutationFn: (body: MemberChanges) => updateMember(member.id, body),
    meta: { errorToast: false },
    onSuccess: () => invalidateAccess(queryClient),
  });
  const run = async (body: MemberChanges, done: string) => {
    setError(undefined);
    try {
      await change.mutateAsync(body);
      toast.success(done);
    } catch (caught) {
      setError(errorMessage(caught));
      throw caught;
    }
  };
  const roleById = new Map((roles.data ?? []).map((role) => [role.id, role]));
  const ended = member.roles.filter((grant) => isEnded(grant));
  const administrator = member.roles.some(
    (grant) => !isEnded(grant) && roleById.get(grant.roleId)?.system === true,
  );
  const pastEnd = Object.values(grants).some((until) => endInPast(until));

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={member.active ? 'secondary' : 'destructive'}>
          {t(member.active ? 'users.status.active' : 'users.status.inactive')}
        </Badge>
        {!member.emailVerified && (
          <Badge variant="outline">{t('users.status.unverified')}</Badge>
        )}
        {self && <Badge variant="outline">{t('users.you')}</Badge>}
        <span className="text-xs text-muted-foreground">
          {t('users.since', { date: formatDateTime(member.createdAt) })}
        </span>
      </div>
      <FormAlert message={error} />
      {!mayManage && (
        <Alert>
          <AlertDescription>{t('users.readOnly')}</AlertDescription>
        </Alert>
      )}

      <section className="flex flex-col gap-3" aria-labelledby="member-roles">
        <h3 id="member-roles" className="font-medium">
          {t('users.roles')}
        </h3>
        {self && mayManage && (
          <Alert>
            <AlertDescription>{t('users.selfRoles')}</AlertDescription>
          </Alert>
        )}
        {roles.isPending ? (
          <Spinner />
        ) : roles.isError ? (
          <FormAlert message={errorMessage(roles.error)} />
        ) : (
          <RoleGrantsPicker
            idPrefix="member"
            roles={roles.data}
            value={grants}
            onChange={setGrants}
            disabled={!mayManage || change.isPending}
          />
        )}
        {ended.length > 0 && (
          <EndedGrants roles={roleById} ended={ended.map((g) => g.roleId)} />
        )}
        {mayManage && (
          <Button
            className="self-start"
            disabled={change.isPending || pastEnd || !roles.isSuccess}
            onClick={() =>
              void run(grantsBody(grants), t('users.rolesSaved')).catch(
                () => {},
              )
            }
          >
            {change.isPending && <Spinner />}
            {t('users.saveRoles')}
          </Button>
        )}
      </section>

      <Separator />

      <section className="flex flex-col gap-3" aria-labelledby="member-units">
        <h3 id="member-units" className="sr-only">
          {t('units.title')}
        </h3>
        {units.isPending ? (
          <Spinner />
        ) : units.isError ? (
          <FormAlert message={errorMessage(units.error)} />
        ) : (
          <UnitsPicker
            idPrefix="member"
            units={units.data}
            value={member.unitIds}
            onChange={() => {}}
            // Read-only: memberships change on the unit's pages.
            disabled
          />
        )}
        <p className="text-xs text-muted-foreground">
          {t('users.unitsOnUnits')}{' '}
          <Link to="/access/organization" className="underline">
            {t('units.title')}
          </Link>
        </p>
      </section>

      <Separator />

      {mayExplain && (
        <>
          <section
            className="flex flex-col gap-3"
            aria-labelledby="member-explain"
          >
            <h3 id="member-explain" className="font-medium">
              {t('users.explain.title')}
            </h3>
            <AccessExplanation memberId={member.id} roles={roleById} />
          </section>
          <Separator />
        </>
      )}

      <section className="flex flex-wrap gap-2" aria-label={t('actions')}>
        {!mayManage ? null : member.active ? (
          !self && (
            <ConfirmButton
              variant="destructive"
              title={t('users.remove.title', { email: member.email })}
              description={t('users.remove.description')}
              confirm={t('users.remove.confirm')}
              onConfirm={async () => {
                await run({ active: false }, t('users.remove.done'));
                props.onDone();
              }}
            >
              {t('users.remove.button')}
            </ConfirmButton>
          )
        ) : (
          <Button
            variant="outline"
            disabled={change.isPending}
            onClick={() =>
              void run({ active: true }, t('users.reactivated')).catch(() => {})
            }
          >
            {t('users.reactivate')}
          </Button>
        )}
        <ImpersonateButton member={member} administrator={administrator} />
      </section>
    </>
  );
}

function EndedGrants(props: { roles: Map<string, Role>; ended: string[] }) {
  const { t } = useTranslation('access');
  return (
    <p className="text-xs text-muted-foreground">
      {t('grants.ended', {
        roles: props.ended
          .map((id) => props.roles.get(id)?.name ?? id)
          .join(', '),
      })}
    </p>
  );
}

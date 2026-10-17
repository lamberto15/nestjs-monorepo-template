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
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ConfirmButton } from '@/components/confirm-button';
import {
  invalidateAccess,
  rolesQuery,
  teamsQuery,
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
import { ImpersonateButton } from '@/features/access/impersonate-button';
import { RoleGrantsPicker, TeamsPicker } from '@/features/access/pickers';
import { formatDateTime } from '@/lib/date-time';
import { errorMessage } from '@/lib/errors';
import { useMe } from '@/lib/features';
import { FormAlert } from '@/lib/form';

/**
 * A member of the tenant: their roles (with ends), teams and status, and
 * what an administrator may do about them (`PATCH /v1/access/users/{id}`,
 * docs/tenancy.md "Accounts and sessions"): never their name or password.
 */
export function MemberSheet(props: {
  member: Member | undefined;
  onClose: () => void;
}) {
  const { t } = useTranslation('access');
  return (
    <Sheet
      open={props.member !== undefined}
      onOpenChange={(open) => !open && props.onClose()}
    >
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
        {props.member && (
          <>
            <SheetHeader>
              <SheetTitle>{props.member.name ?? props.member.email}</SheetTitle>
              <SheetDescription>{props.member.email}</SheetDescription>
            </SheetHeader>
            <div className="flex flex-col gap-6 px-4 pb-6">
              <MemberDetail
                // A new member, a fresh draft.
                key={props.member.id + props.member.updatedAt}
                member={props.member}
                onDone={props.onClose}
              />
            </div>
          </>
        )}
        {!props.member && <span className="sr-only">{t('users.title')}</span>}
      </SheetContent>
    </Sheet>
  );
}

function MemberDetail(props: { member: Member; onDone: () => void }) {
  const { t } = useTranslation('access');
  const { member } = props;
  const me = useMe();
  const self = me?.user.id === member.id;
  const queryClient = useQueryClient();
  const roles = useQuery(rolesQuery);
  const teams = useQuery(teamsQuery);
  const [grants, setGrants] = useState<GrantDraft>(() => draftOf(member.roles));
  const [teamIds, setTeamIds] = useState<string[]>(member.teamIds);
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

      <section className="flex flex-col gap-3" aria-labelledby="member-roles">
        <h3 id="member-roles" className="font-medium">
          {t('users.roles')}
        </h3>
        {self && (
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
            disabled={change.isPending}
          />
        )}
        {ended.length > 0 && (
          <EndedGrants roles={roleById} ended={ended.map((g) => g.roleId)} />
        )}
        <Button
          className="self-start"
          disabled={change.isPending || pastEnd || !roles.isSuccess}
          onClick={() =>
            void run(grantsBody(grants), t('users.rolesSaved')).catch(() => {})
          }
        >
          {change.isPending && <Spinner />}
          {t('users.saveRoles')}
        </Button>
      </section>

      <Separator />

      <section className="flex flex-col gap-3" aria-labelledby="member-teams">
        <h3 id="member-teams" className="sr-only">
          {t('teams.title')}
        </h3>
        {teams.isPending ? (
          <Spinner />
        ) : teams.isError ? (
          <FormAlert message={errorMessage(teams.error)} />
        ) : (
          <TeamsPicker
            idPrefix="member"
            teams={teams.data}
            value={teamIds}
            onChange={setTeamIds}
            // The API refuses changing one's own teams.
            disabled={self || change.isPending}
          />
        )}
        {self ? (
          <p className="text-xs text-muted-foreground">
            {t('users.selfTeams')}
          </p>
        ) : (
          <Button
            className="self-start"
            variant="outline"
            disabled={change.isPending || !teams.isSuccess}
            onClick={() =>
              void run({ teamIds }, t('users.teamsSaved')).catch(() => {})
            }
          >
            {t('users.saveTeams')}
          </Button>
        )}
      </section>

      <Separator />

      <section className="flex flex-wrap gap-2" aria-label={t('actions')}>
        {member.active ? (
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

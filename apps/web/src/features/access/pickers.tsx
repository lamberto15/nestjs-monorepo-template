import { Checkbox } from '@nestjs-monorepo-template/ui/components/checkbox';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '@nestjs-monorepo-template/ui/components/field';
import { Input } from '@nestjs-monorepo-template/ui/components/input';
import { useTranslation } from 'react-i18next';
import type { Role, Team } from '@/features/access/api';
import { endInPast, type GrantDraft } from '@/features/access/grants';

/**
 * Roles given to someone (grants, docs/permissions.md "Roles and grants"):
 * each ticked role may end at a date and time (temporary access).
 */
export function RoleGrantsPicker(props: {
  roles: Role[];
  value: GrantDraft;
  onChange: (value: GrantDraft) => void;
  disabled?: boolean;
  idPrefix: string;
}) {
  const { t } = useTranslation('access');
  return (
    <FieldSet>
      <FieldLegend variant="label">{t('grants.roles')}</FieldLegend>
      <FieldDescription>{t('grants.hint')}</FieldDescription>
      <div className="flex flex-col gap-3">
        {props.roles.map((role) => {
          const id = `${props.idPrefix}-role-${role.id}`;
          const on = role.id in props.value;
          const until = props.value[role.id] ?? '';
          const past = on && endInPast(until);
          return (
            <div key={role.id} className="flex flex-col gap-2">
              <Field orientation="horizontal">
                <Checkbox
                  id={id}
                  checked={on}
                  disabled={props.disabled}
                  onCheckedChange={(checked) => {
                    const next = { ...props.value };
                    if (checked) {
                      next[role.id] = '';
                    } else {
                      delete next[role.id];
                    }
                    props.onChange(next);
                  }}
                />
                <FieldContent>
                  <FieldLabel htmlFor={id}>{role.name}</FieldLabel>
                  {role.description && (
                    <FieldDescription>{role.description}</FieldDescription>
                  )}
                </FieldContent>
              </Field>
              {on && (
                <Field data-invalid={past} className="ms-6 max-w-64">
                  <FieldLabel htmlFor={`${id}-until`}>
                    {t('grants.until')}
                  </FieldLabel>
                  <Input
                    id={`${id}-until`}
                    type="datetime-local"
                    value={until}
                    disabled={props.disabled}
                    aria-invalid={past}
                    onChange={(event) =>
                      props.onChange({
                        ...props.value,
                        [role.id]: event.target.value,
                      })
                    }
                  />
                  {past ? (
                    <FieldError>{t('grants.untilPast')}</FieldError>
                  ) : (
                    <FieldDescription>{t('grants.untilHint')}</FieldDescription>
                  )}
                </Field>
              )}
            </div>
          );
        })}
      </div>
    </FieldSet>
  );
}

/** Teams someone belongs to: the tree, indented by depth. */
export function TeamsPicker(props: {
  teams: Team[];
  value: string[];
  onChange: (value: string[]) => void;
  disabled?: boolean;
  idPrefix: string;
}) {
  const { t } = useTranslation('access');
  return (
    <FieldSet>
      <FieldLegend variant="label">{t('teams.title')}</FieldLegend>
      {props.teams.length === 0 ? (
        <FieldDescription>{t('teams.none')}</FieldDescription>
      ) : (
        <div className="flex flex-col gap-2">
          {orderedTree(props.teams).map((team) => {
            const id = `${props.idPrefix}-team-${team.id}`;
            return (
              <Field
                key={team.id}
                orientation="horizontal"
                style={{ paddingInlineStart: `${team.depth * 1.25}rem` }}
              >
                <Checkbox
                  id={id}
                  checked={props.value.includes(team.id)}
                  disabled={props.disabled}
                  onCheckedChange={(checked) =>
                    props.onChange(
                      checked
                        ? [...props.value, team.id]
                        : props.value.filter((v) => v !== team.id),
                    )
                  }
                />
                <FieldLabel htmlFor={id}>{team.name}</FieldLabel>
              </Field>
            );
          })}
        </div>
      )}
    </FieldSet>
  );
}

/** The teams in tree order: each followed by the teams under it. */
export function orderedTree(teams: readonly Team[]): Team[] {
  const children = new Map<string | null, Team[]>();
  const ids = new Set(teams.map((team) => team.id));
  for (const team of teams) {
    // A parent not in the list (shouldn't happen): shown at the top.
    const parent =
      team.parentId && ids.has(team.parentId) ? team.parentId : null;
    children.set(parent, [...(children.get(parent) ?? []), team]);
  }
  const out: Team[] = [];
  const walk = (parent: string | null) => {
    for (const team of (children.get(parent) ?? []).toSorted((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      out.push(team);
      walk(team.id);
    }
  };
  walk(null);
  return out;
}

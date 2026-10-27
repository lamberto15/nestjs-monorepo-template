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
import type { Role, Unit } from '@/features/access/api';
import { endInPast, type GrantDraft } from '@/features/access/grants';
import { useDescribedBy } from '@/lib/form';

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
                <GrantEnd
                  id={`${id}-until`}
                  value={until}
                  past={past}
                  disabled={props.disabled}
                  onChange={(next) =>
                    props.onChange({ ...props.value, [role.id]: next })
                  }
                />
              )}
            </div>
          );
        })}
      </div>
    </FieldSet>
  );
}

/** When one role's grant ends; the hint, or why the end is refused, describes the input. */
function GrantEnd(props: {
  id: string;
  value: string;
  past: boolean;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation('access');
  // The hint and the error take turns, as the text under the input does.
  const { descriptionId, errorId, describedBy } = useDescribedBy(
    !props.past,
    props.past,
  );
  return (
    <Field data-invalid={props.past} className="ms-6 max-w-64">
      <FieldLabel htmlFor={props.id}>{t('grants.until')}</FieldLabel>
      <Input
        id={props.id}
        type="datetime-local"
        value={props.value}
        disabled={props.disabled}
        aria-invalid={props.past}
        aria-describedby={describedBy}
        onChange={(event) => props.onChange(event.target.value)}
      />
      {props.past ? (
        <FieldError id={errorId}>{t('grants.untilPast')}</FieldError>
      ) : (
        <FieldDescription id={descriptionId}>
          {t('grants.untilHint')}
        </FieldDescription>
      )}
    </Field>
  );
}

/** Units someone belongs to: the tree, indented by depth. */
export function UnitsPicker(props: {
  units: Unit[];
  value: string[];
  onChange: (value: string[]) => void;
  disabled?: boolean;
  idPrefix: string;
}) {
  const { t } = useTranslation('access');
  return (
    <FieldSet>
      <FieldLegend variant="label">{t('units.title')}</FieldLegend>
      {props.units.length === 0 ? (
        <FieldDescription>{t('units.none')}</FieldDescription>
      ) : (
        <div className="flex flex-col gap-2">
          {orderedTree(props.units).map((unit) => {
            const id = `${props.idPrefix}-unit-${unit.id}`;
            return (
              <Field
                key={unit.id}
                orientation="horizontal"
                style={{ paddingInlineStart: `${unit.depth * 1.25}rem` }}
              >
                <Checkbox
                  id={id}
                  checked={props.value.includes(unit.id)}
                  disabled={props.disabled}
                  onCheckedChange={(checked) =>
                    props.onChange(
                      checked
                        ? [...props.value, unit.id]
                        : props.value.filter((v) => v !== unit.id),
                    )
                  }
                />
                <FieldLabel htmlFor={id}>{unit.name}</FieldLabel>
              </Field>
            );
          })}
        </div>
      )}
    </FieldSet>
  );
}

/** The units in tree order: each followed by the units under it. */
export function orderedTree(units: readonly Unit[]): Unit[] {
  const children = new Map<string | null, Unit[]>();
  const ids = new Set(units.map((unit) => unit.id));
  for (const unit of units) {
    // A parent not in the list (shouldn't happen): shown at the top.
    const parent =
      unit.parentId && ids.has(unit.parentId) ? unit.parentId : null;
    children.set(parent, [...(children.get(parent) ?? []), unit]);
  }
  const out: Unit[] = [];
  const walk = (parent: string | null) => {
    for (const unit of (children.get(parent) ?? []).toSorted((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      out.push(unit);
      walk(unit.id);
    }
  };
  walk(null);
  return out;
}

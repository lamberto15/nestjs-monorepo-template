import { useQuery } from '@tanstack/react-query';
import { Badge } from '@nestjs-monorepo-template/ui/components/badge';
import { Button } from '@nestjs-monorepo-template/ui/components/button';
import {
  Field,
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
import { Spinner } from '@nestjs-monorepo-template/ui/components/spinner';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  catalogQuery,
  type Explanation,
  explanationQuery,
  type Role,
} from '@/features/access/api';
import type { CatalogSubject } from '@/features/access/permissions';
import { errorMessage } from '@/lib/errors';
import { FormAlert } from '@/lib/form';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Why a member may or may not act on a subject, or on one of its records
 * (`GET /v1/access/users/{id}/explanation`, docs/permissions.md
 * "Explaining access"): the engine's answer per action, the fields it may
 * touch, and which grant of which role reaches the record. Access.manageRoles
 * or Access.manageUsers.
 */
export function AccessExplanation(props: {
  memberId: string;
  roles: Map<string, Role>;
}) {
  const { t, i18n } = useTranslation('access');
  const catalog = useQuery(catalogQuery(i18n.language));
  const [subject, setSubject] = useState('');
  const [recordId, setRecordId] = useState('');
  const [asked, setAsked] = useState<{ subject: string; recordId?: string }>();
  const explanation = useQuery({
    ...explanationQuery(props.memberId, asked?.subject ?? '', asked?.recordId),
    enabled: asked !== undefined,
  });
  if (catalog.isPending) return <Spinner />;
  if (catalog.isError) {
    return <FormAlert message={errorMessage(catalog.error)} />;
  }
  const options = catalog.data.subjects.map((item) => ({
    value: item.subject,
    label: item.label,
  }));
  const declared = catalog.data.subjects.find(
    (item) => item.subject === asked?.subject,
  );
  const record = recordId.trim();
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">
        {t('users.explain.description')}
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <Field className="w-48">
          <FieldLabel htmlFor="explain-subject">
            {t('users.explain.subject')}
          </FieldLabel>
          <Select
            items={options}
            value={subject || null}
            onValueChange={(value) => setSubject(value ?? '')}
          >
            <SelectTrigger id="explain-subject">
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
        </Field>
        <Field className="w-72">
          <FieldLabel htmlFor="explain-record">
            {t('users.explain.record')}
          </FieldLabel>
          <Input
            id="explain-record"
            value={recordId}
            onChange={(event) => setRecordId(event.target.value)}
            aria-invalid={record !== '' && !UUID.test(record)}
          />
        </Field>
        <Button
          variant="outline"
          disabled={!subject || (record !== '' && !UUID.test(record))}
          onClick={() =>
            setAsked({ subject, recordId: record === '' ? undefined : record })
          }
        >
          {t('users.explain.run')}
        </Button>
      </div>
      {asked &&
        (explanation.isPending ? (
          <Spinner />
        ) : explanation.isError ? (
          <FormAlert message={errorMessage(explanation.error)} />
        ) : (
          <ExplainedActions
            explanation={explanation.data}
            subject={declared}
            roles={props.roles}
          />
        ))}
    </div>
  );
}

function ExplainedActions(props: {
  explanation: Explanation;
  subject: CatalogSubject | undefined;
  roles: Map<string, Role>;
}) {
  const { t } = useTranslation('access');
  const { explanation, subject } = props;
  const verdict = (value: boolean | null) =>
    value === null ? 'withheld' : value ? 'allowed' : 'denied';
  const fieldLabel = (field: string) =>
    subject?.fields.find((item) => item.field === field)?.label ?? field;
  const ended = explanation.roles.filter((role) => role.expired);
  return (
    <ul className="flex flex-col gap-3" aria-label={t('users.explain.title')}>
      {explanation.actions.map((explained) => {
        const action = subject?.actions.find(
          (item) => item.action === explained.action,
        );
        const conditionLabel = (key: string) =>
          action?.conditions.find((item) => item.key === key)?.label ?? key;
        return (
          <li key={explained.action} className="flex flex-col gap-1 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">
                {action?.label ?? explained.action}
              </span>
              <Badge variant={explained.allowed ? 'secondary' : 'outline'}>
                {t(`users.explain.${verdict(explained.allowed)}`)}
              </Badge>
            </div>
            {explained.allowed && subject && subject.fields.length > 0 && (
              <span className="text-xs text-muted-foreground">
                {explained.fields?.length
                  ? t('users.explain.fields', {
                      fields: explained.fields.map(fieldLabel).join(', '),
                    })
                  : t('users.explain.noFields')}
              </span>
            )}
            {explained.grants.length === 0 ? (
              <span className="text-xs text-muted-foreground">
                {t('users.explain.noGrant')}
              </span>
            ) : (
              <ul className="ms-4 list-disc text-xs text-muted-foreground">
                {explained.grants.map((grant, i) => (
                  <li key={i}>
                    {grant.roleId
                      ? (props.roles.get(grant.roleId)?.name ?? grant.roleId)
                      : t('users.explain.builtIn')}
                    {': '}
                    {grant.all
                      ? t('users.explain.all')
                      : grant.conditions.length
                        ? grant.conditions
                            .map(
                              (condition) =>
                                `${conditionLabel(condition.key)} (${t(`users.explain.condition.${verdict(condition.matches)}`)})`,
                            )
                            .join(', ')
                        : t('users.explain.everyRecord')}
                    {explanation.recordId &&
                      ` · ${t(`users.explain.reaches.${verdict(grant.matches)}`)}`}
                  </li>
                ))}
              </ul>
            )}
          </li>
        );
      })}
      {ended.length > 0 && (
        <li className="text-xs text-muted-foreground">
          {t('grants.ended', {
            roles: ended.map((role) => role.name).join(', '),
          })}
        </li>
      )}
    </ul>
  );
}

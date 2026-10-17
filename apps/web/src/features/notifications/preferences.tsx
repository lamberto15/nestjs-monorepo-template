import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { unwrap } from '@nestjs-monorepo-template/api-client';
import { Button } from '@nestjs-monorepo-template/ui/components/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@nestjs-monorepo-template/ui/components/select';
import { Spinner } from '@nestjs-monorepo-template/ui/components/spinner';
import { LockIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import {
  preferencesQuery,
  typesQuery,
  type NotificationType,
  type Preferences,
} from './queries';

type Value = string | boolean;
type Draft = Record<string, Record<string, Value>>;

/** Frequencies of the `email` channel; `false` is off. */
const emailValues = ['false', 'immediate', 'hourly', 'daily'] as const;
const flagValues = ['false', 'true'] as const;

const encode = (value: unknown) => String(value);
const decode = (value: string): Value =>
  value === 'true' ? true : value === 'false' ? false : value;

/** The channels a user may set for a type (`webhook` is for API clients). */
function settable(type: NotificationType) {
  return Object.keys(type.channels).filter(
    (channel) => channel === 'email' || channel === 'webhook',
  );
}

/**
 * What differs from the type's defaults: `PUT /v1/notifications/preferences`
 * replaces the overrides, a type or channel left out goes back to default.
 */
export function overrides(types: NotificationType[], draft: Draft): Draft {
  const body: Draft = {};
  for (const type of types) {
    for (const channel of settable(type)) {
      const value = draft[type.type]?.[channel];
      if (value !== undefined && value !== type.channels[channel]) {
        (body[type.type] ??= {})[channel] = value;
      }
    }
  }
  return body;
}

/** The effective settings: the saved overrides over the defaults. */
function initial(types: NotificationType[], saved: Preferences): Draft {
  const draft: Draft = {};
  for (const type of types) {
    draft[type.type] = {};
    for (const channel of settable(type)) {
      draft[type.type]![channel] = (saved[type.type]?.[channel] ??
        type.channels[channel]) as Value;
    }
  }
  return draft;
}

/** The per-type, per-channel settings of the signed-in user. */
export function PreferencesForm() {
  const types = useQuery(typesQuery);
  const saved = useQuery(preferencesQuery);
  if (!types.data || !saved.data) {
    return <Spinner />;
  }
  return (
    <Editor
      types={types.data.items}
      saved={saved.data.types}
      // A fresh draft when the saved settings change underneath.
      key={JSON.stringify(saved.data.types)}
    />
  );
}

function Editor(props: { types: NotificationType[]; saved: Preferences }) {
  const { t } = useTranslation('notifications');
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(() => initial(props.types, props.saved));
  const save = useMutation({
    mutationFn: () =>
      unwrap(
        api.PUT('/v1/notifications/preferences', {
          body: overrides(props.types, draft),
        }),
      ),
    onSuccess: (data) => {
      queryClient.setQueryData(preferencesQuery.queryKey, data);
      toast.success(t('preferences.saved'));
    },
  });

  const set = (type: string, channel: string, value: Value) =>
    setDraft((now) => ({ ...now, [type]: { ...now[type], [channel]: value } }));

  return (
    <div className="flex flex-col gap-4">
      <ul className="rounded-lg border">
        {props.types.map((type) => (
          <li
            key={type.type}
            className="flex flex-col gap-3 border-b p-3 last:border-b-0"
          >
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">{type.label}</span>
              {type.mandatory && (
                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                  <LockIcon className="size-3" />
                  {t('preferences.mandatory')}
                </span>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
              <span className="text-sm text-muted-foreground">
                {t('preferences.channels.inApp')}: {t('preferences.alwaysOn')}
              </span>
              {settable(type).map((channel) => {
                const values = channel === 'email' ? emailValues : flagValues;
                const label = t(`preferences.channels.${channel}`);
                const items = values.map((value) => ({
                  value,
                  label: t(`preferences.values.${channel}.${value}`),
                }));
                return (
                  <label
                    key={channel}
                    className="flex items-center gap-2 text-sm"
                  >
                    {label}
                    <Select
                      items={items}
                      value={encode(draft[type.type]?.[channel])}
                      onValueChange={(value) =>
                        set(type.type, channel, decode(value ?? 'false'))
                      }
                    >
                      <SelectTrigger
                        size="sm"
                        aria-label={`${type.label}: ${label}`}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {items.map((entry) => (
                          <SelectItem
                            key={entry.value}
                            value={entry.value}
                            // A mandatory type may change a frequency, never go off.
                            disabled={type.mandatory && entry.value === 'false'}
                          >
                            {entry.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </label>
                );
              })}
            </div>
          </li>
        ))}
      </ul>
      <Button
        className="self-start"
        disabled={save.isPending}
        onClick={() => save.mutate()}
      >
        {save.isPending && <Spinner />}
        {t('preferences.save')}
      </Button>
    </div>
  );
}

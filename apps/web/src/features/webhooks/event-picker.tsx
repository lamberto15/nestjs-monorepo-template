import { Checkbox } from '@nestjs-monorepo-template/ui/components/checkbox';
import {
  Field,
  FieldDescription,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '@nestjs-monorepo-template/ui/components/field';
import { Spinner } from '@nestjs-monorepo-template/ui/components/spinner';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { errorMessage } from '@/lib/errors';
import { FormAlert } from '@/lib/form';
import { eventTypesQuery } from './queries';

export const ALL_EVENTS = '*';

/**
 * The events an endpoint receives, from the catalog
 * (`GET /v1/webhook-event-types`) grouped by feature: all of them (`*`) or
 * chosen types, a whole feature at once. A type the endpoint holds that the
 * catalog no longer lists stays, under its own heading, so saving never
 * drops it by accident.
 */
export function EventPicker(props: {
  value: string[];
  onChange: (value: string[]) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation('webhooks');
  const catalog = useQuery(eventTypesQuery);
  const all = props.value.includes(ALL_EVENTS);
  const chosen = new Set(props.value);
  const listed = new Set(
    catalog.data?.items.flatMap((group) => group.types.map((x) => x.type)),
  );
  const unlisted = props.value.filter(
    (type) => type !== ALL_EVENTS && !listed.has(type),
  );
  const toggle = (types: string[], on: boolean) => {
    const next = new Set(chosen);
    for (const type of types) {
      if (on) next.add(type);
      else next.delete(type);
    }
    props.onChange([...next]);
  };
  return (
    <FieldSet>
      <FieldLegend variant="label">{t('form.events')}</FieldLegend>
      <Field orientation="horizontal">
        <Checkbox
          id="events-all"
          checked={all}
          disabled={props.disabled}
          onCheckedChange={(checked) =>
            props.onChange(checked ? [ALL_EVENTS] : [])
          }
        />
        <FieldLabel htmlFor="events-all">{t('form.allEvents')}</FieldLabel>
      </Field>
      <FieldDescription>{t('form.eventsHint')}</FieldDescription>
      {!all &&
        (catalog.isPending ? (
          <Spinner />
        ) : catalog.isError ? (
          <FormAlert message={errorMessage(catalog.error)} />
        ) : (
          <div className="flex max-h-72 flex-col gap-4 overflow-y-auto rounded-md border p-3">
            {[
              ...catalog.data.items,
              ...(unlisted.length
                ? [
                    {
                      group: t('form.otherGroup'),
                      types: unlisted.map((type) => ({
                        type,
                        description: null,
                      })),
                    },
                  ]
                : []),
            ].map((group) => {
              const types = group.types.map((x) => x.type);
              const count = types.filter((type) => chosen.has(type)).length;
              return (
                <fieldset key={group.group} className="flex flex-col gap-2">
                  <Field orientation="horizontal">
                    <Checkbox
                      id={`events-group-${group.group}`}
                      checked={count === types.length}
                      indeterminate={count > 0 && count < types.length}
                      disabled={props.disabled}
                      onCheckedChange={(checked) => toggle(types, checked)}
                    />
                    <FieldLabel
                      htmlFor={`events-group-${group.group}`}
                      className="font-medium"
                    >
                      {group.group}
                    </FieldLabel>
                  </Field>
                  {group.types.map((entry) => (
                    <Field
                      key={entry.type}
                      orientation="horizontal"
                      className="ps-6"
                    >
                      <Checkbox
                        id={`event-${entry.type}`}
                        checked={chosen.has(entry.type)}
                        disabled={props.disabled}
                        onCheckedChange={(checked) =>
                          toggle([entry.type], checked)
                        }
                      />
                      <FieldLabel htmlFor={`event-${entry.type}`}>
                        <span className="font-mono text-xs">{entry.type}</span>
                        {entry.description && (
                          <span className="text-muted-foreground font-normal">
                            {entry.description}
                          </span>
                        )}
                      </FieldLabel>
                    </Field>
                  ))}
                </fieldset>
              );
            })}
          </div>
        ))}
    </FieldSet>
  );
}

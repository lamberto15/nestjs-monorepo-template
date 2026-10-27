import { Button } from '@nestjs-monorepo-template/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@nestjs-monorepo-template/ui/components/dialog';
import { FieldGroup } from '@nestjs-monorepo-template/ui/components/field';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { applyFieldErrors, errorMessage } from '@/lib/errors';
import { FormAlert, useAppForm } from '@/lib/form';
import { z } from '@/lib/zod';
import { EventPicker } from './event-picker';
import type { Endpoint } from './queries';

export type EndpointValues = {
  url: string;
  description: string;
  eventTypes: string[];
};

// The API states no limit for an endpoint's description: this is the web's.
const DESCRIPTION_MAX = 500;

const isHttpUrl = (value: string) => {
  try {
    return ['https:', 'http:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
};

/**
 * Creating (no `endpoint`) or editing an endpoint: URL, description and
 * events (the editing also switches it on or off, on the detail page).
 * `onSubmit` throws to keep the dialog open with the API's message.
 */
export function EndpointFormDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  endpoint?: Endpoint;
  onSubmit: (values: EndpointValues) => Promise<unknown>;
}) {
  const { t } = useTranslation('webhooks');
  const [error, setError] = useState<string>();
  const editing = props.endpoint !== undefined;
  const form = useAppForm({
    defaultValues: {
      url: props.endpoint?.url ?? '',
      description: props.endpoint?.description ?? '',
      eventTypes: props.endpoint?.eventTypes ?? ['*'],
    } satisfies EndpointValues,
    validators: {
      onSubmit: z.object({
        url: z
          .string()
          .trim()
          .min(1, t('form.urlRequired'))
          .refine(isHttpUrl, { message: t('form.urlInvalid') }),
        description: z
          .string()
          .trim()
          .max(
            DESCRIPTION_MAX,
            t('form.descriptionTooLong', { max: DESCRIPTION_MAX }),
          ),
        eventTypes: z.array(z.string()).min(1, t('form.eventsRequired')),
      }),
    },
    onSubmit: async ({ value }) => {
      setError(undefined);
      try {
        await props.onSubmit({
          url: value.url.trim(),
          description: value.description.trim(),
          eventTypes: value.eventTypes,
        });
        if (!editing) form.reset();
        props.onOpenChange(false);
      } catch (caught) {
        if (!applyFieldErrors(form, caught)) {
          setError(errorMessage(caught));
        }
      }
    },
  });
  // Closing drops a new endpoint's draft: the dialog stays mounted, so it
  // would return. An edit's defaults are the saved endpoint.
  const onOpenChange = (open: boolean) => {
    if (!open) {
      if (!editing) form.reset();
      setError(undefined);
    }
    props.onOpenChange(open);
  };
  return (
    <Dialog open={props.open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {editing ? t('form.editTitle') : t('form.createTitle')}
          </DialogTitle>
          <DialogDescription>
            {editing ? t('form.editDescription') : t('form.createDescription')}
          </DialogDescription>
        </DialogHeader>
        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void form.handleSubmit();
          }}
        >
          <FieldGroup>
            <FormAlert message={error} />
            <form.AppField name="url">
              {(field) => (
                <field.TextField
                  label={t('form.url')}
                  description={t('form.urlHint')}
                  placeholder="https://example.com/hooks"
                  autoFocus
                />
              )}
            </form.AppField>
            <form.AppField name="description">
              {(field) => (
                <field.TextField
                  label={t('form.descriptionLabel')}
                  placeholder={t('form.descriptionPlaceholder')}
                />
              )}
            </form.AppField>
            <form.Field name="eventTypes">
              {(field) => (
                <>
                  <EventPicker
                    value={field.state.value}
                    onChange={field.handleChange}
                  />
                  {field.state.meta.errors.length > 0 && (
                    <FormAlert
                      message={field.state.meta.errors
                        .map((e) => (typeof e === 'string' ? e : e?.message))
                        .join(' ')}
                    />
                  )}
                </>
              )}
            </form.Field>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
              >
                {t('form.cancel')}
              </Button>
              <form.AppForm>
                <form.SubmitButton>
                  {editing ? t('form.save') : t('form.create')}
                </form.SubmitButton>
              </form.AppForm>
            </DialogFooter>
          </FieldGroup>
        </form>
      </DialogContent>
    </Dialog>
  );
}

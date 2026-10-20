import { isApiError } from '@nestjs-monorepo-template/api-client';
import { Button } from '@nestjs-monorepo-template/ui/components/button';
import {
  ColorPicker,
  ColorPickerArea,
  ColorPickerContent,
  ColorPickerHueSlider,
  ColorPickerInput,
} from '@nestjs-monorepo-template/ui/components/color-picker';
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
import { PaletteIcon, XIcon } from 'lucide-react';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { applyFieldErrors, errorMessage } from '@/lib/errors';
import { FormAlert, useAppForm } from '@/lib/form';
import { TagBadge, type Tag } from '@/lib/tags';
import { z } from '@/lib/zod';
import { useUpdateTag, type TagChanges } from './api';

/** The schema's limits (`PATCH /v1/tags/{id}`). */
const LIMITS = { name: 100, description: 500 } as const;

/** The color the picker opens on when the tag has none yet. */
const START_COLOR = '#3b82f6';

/**
 * Rename, recolour or describe one tag (docs/tags.md). Sends only what
 * changed; a color taken off is `null`, an emptied description too. A name
 * another tag of the subject has (whatever the case) is a 409 shown on the
 * name field.
 */
export function TagDialog(props: {
  tag: Tag;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation('tags');
  const { tag } = props;
  const update = useUpdateTag();
  const [error, setError] = useState<string>();

  const form = useAppForm({
    defaultValues: {
      name: tag.name,
      // '' is "no color": a hex color is what the API stores.
      color: tag.color ?? '',
      description: tag.description ?? '',
    },
    onSubmit: async ({ value }) => {
      setError(undefined);
      const changes: TagChanges = {};
      const name = value.name.trim();
      if (name !== tag.name) changes.name = name;
      if (value.color.toLowerCase() !== (tag.color ?? '').toLowerCase()) {
        changes.color = value.color || null;
      }
      const description = value.description.trim();
      if (description !== (tag.description ?? '')) {
        changes.description = description || null;
      }
      if (Object.keys(changes).length === 0) {
        props.onOpenChange(false);
        return;
      }
      try {
        await update.mutateAsync({ id: tag.id, changes });
        toast.success(t('updated', { name }));
        props.onOpenChange(false);
      } catch (caught) {
        if (isApiError(caught) && caught.status === 409) {
          form.setFieldMeta('name', (meta) => ({
            ...meta,
            isTouched: true,
            errorMap: {
              ...meta?.errorMap,
              onSubmit: { message: t('form.nameTaken', { name }) },
            },
          }));
        } else if (!applyFieldErrors(form, caught)) {
          setError(errorMessage(caught));
        }
      }
    },
  });

  return (
    <Dialog open onOpenChange={props.onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('form.title', { name: tag.name })}</DialogTitle>
          <DialogDescription>
            {t('form.description', { subject: tag.subject })}
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
            <form.AppField
              name="name"
              validators={{
                onSubmit: z
                  .string()
                  .trim()
                  .min(1, t('form.nameRequired'))
                  .max(LIMITS.name, t('form.nameTooLong')),
              }}
            >
              {(f) => <f.TextField label={t('form.name')} autoFocus />}
            </form.AppField>
            <form.Field name="color">
              {(f) => (
                <Field>
                  <FieldLabel>{t('form.color')}</FieldLabel>
                  <FieldDescription>{t('form.colorHint')}</FieldDescription>
                  {f.state.value ? (
                    <div className="flex flex-col gap-2">
                      <HexPicker
                        value={f.state.value}
                        onChange={f.handleChange}
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="self-start"
                        onClick={() => f.handleChange('')}
                      >
                        <XIcon />
                        {t('form.removeColor')}
                      </Button>
                    </div>
                  ) : (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="self-start"
                      onClick={() => f.handleChange(START_COLOR)}
                    >
                      <PaletteIcon />
                      {t('form.chooseColor')}
                    </Button>
                  )}
                </Field>
              )}
            </form.Field>
            <form.AppField
              name="description"
              validators={{
                onSubmit: z
                  .string()
                  .max(LIMITS.description, t('form.descriptionTooLong')),
              }}
            >
              {(f) => (
                <f.TextAreaField
                  label={t('form.descriptionLabel')}
                  description={t('form.descriptionHint')}
                  rows={3}
                />
              )}
            </form.AppField>
            <form.Subscribe selector={(state) => state.values}>
              {(values) => (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  {t('form.preview')}
                  <TagBadge
                    tag={{
                      name: values.name.trim() || tag.name,
                      color: values.color || null,
                    }}
                  />
                </div>
              )}
            </form.Subscribe>
          </FieldGroup>
          <DialogFooter className="mt-4">
            <Button
              type="button"
              variant="outline"
              onClick={() => props.onOpenChange(false)}
            >
              {t('form.cancel')}
            </Button>
            <form.AppForm>
              <form.SubmitButton>{t('form.save')}</form.SubmitButton>
            </form.AppForm>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Dice UI's color picker on a hex color. It passes the color through HSV when
 * it mounts and reports the rounded result (`#ef4444` comes back as
 * `#f04343`), which would recolour a tag the user only opened: so its changes
 * count from the first pointer, key or input event on it, and it starts from
 * `value` (uncontrolled: the parent remounts it for another color).
 */
function HexPicker(props: { value: string; onChange: (hex: string) => void }) {
  const touched = useRef(false);
  const touch = () => {
    touched.current = true;
  };
  return (
    <div
      onPointerDownCapture={touch}
      onKeyDownCapture={touch}
      onChangeCapture={touch}
    >
      <ColorPicker
        inline
        format="hex"
        defaultValue={props.value}
        onValueChange={(next) => touched.current && props.onChange(next)}
      >
        <ColorPickerContent className="w-full p-0">
          <ColorPickerArea />
          <ColorPickerHueSlider />
          <ColorPickerInput withoutAlpha />
        </ColorPickerContent>
      </ColorPicker>
    </div>
  );
}

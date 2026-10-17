import { unwrap } from '@nestjs-monorepo-template/api-client';
import { Button } from '@nestjs-monorepo-template/ui/components/button';
import {
  TagsInput,
  TagsInputInput,
  TagsInputItem,
  TagsInputList,
} from '@nestjs-monorepo-template/ui/components/tags-input';
import { Spinner } from '@nestjs-monorepo-template/ui/components/spinner';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { PencilIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { useCan } from '@/lib/features';
import { useInvalidateRecords } from '@/lib/records';
import { TagBadge, useTags, type Tag } from '@/lib/tags';
import { setTags } from './api';

type RecordTag = Pick<Tag, 'id' | 'name' | 'color'>;

const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * The record's tags and their editor. The picker offers the tenant's tags for
 * the subject (a click, or typing a name); a name that is no tag yet is
 * created inline when the user holds `Access.manageTags` (POST /v1/tags),
 * otherwise it is refused. Saving replaces the whole set
 * (`PUT …/tags { tagIds }`, docs/tags.md) and refreshes the record and the
 * lists.
 */
export function TagsPanel(props: {
  subject: string;
  /** The record's list route (`/v1/notes`): its queries are refreshed. */
  listPath: string;
  base: string;
  id: string;
  tags: readonly RecordTag[];
  canEdit: boolean;
}) {
  const { t } = useTranslation('records');
  const queryClient = useQueryClient();
  const invalidate = useInvalidateRecords(props.listPath);
  const canCreate = useCan('Access.manageTags');
  const [editing, setEditing] = useState(false);
  const [names, setNames] = useState<string[]>([]);
  const catalog = useTags(props.subject, editing);
  const known = catalog.data ?? [];

  const save = useMutation({
    mutationFn: async () => {
      const ids: string[] = [];
      let created = false;
      for (const name of names) {
        const existing = known.find((tag) => sameName(tag.name, name));
        if (existing) {
          ids.push(existing.id);
          continue;
        }
        const tag = await unwrap(
          api.POST('/v1/tags', { body: { subject: props.subject, name } }),
        );
        created = true;
        ids.push(tag.id);
      }
      await setTags(props.base, props.id, ids);
      return created;
    },
    onSuccess: async (created) => {
      if (created) {
        await queryClient.invalidateQueries({
          queryKey: ['tags', props.subject],
        });
      }
      await invalidate();
      setEditing(false);
      toast.success(t('tags.saved'));
    },
  });

  const add = (name: string) =>
    setNames((current) =>
      current.some((n) => sameName(n, name)) ? current : [...current, name],
    );

  if (!editing) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        {props.tags.length > 0 ? (
          <ul className="flex flex-wrap gap-1.5" aria-label={t('tags.title')}>
            {props.tags.map((tag) => (
              <li key={tag.id}>
                <TagBadge tag={tag} />
              </li>
            ))}
          </ul>
        ) : (
          <span className="text-sm text-muted-foreground">
            {t('tags.none')}
          </span>
        )}
        {props.canEdit && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setNames(props.tags.map((tag) => tag.name));
              setEditing(true);
            }}
          >
            <PencilIcon />
            {t('tags.edit')}
          </Button>
        )}
      </div>
    );
  }

  const unused = known.filter(
    (tag) => !names.some((name) => sameName(name, tag.name)),
  );
  return (
    <div className="flex max-w-2xl flex-col gap-2">
      <TagsInput
        className="w-full"
        value={names}
        onValueChange={(next) =>
          // The case of an existing tag wins over what was typed.
          setNames(
            next.map(
              (name) =>
                known.find((tag) => sameName(tag.name, name))?.name ?? name,
            ),
          )
        }
        onValidate={(name) =>
          known.some((tag) => sameName(tag.name, name)) || canCreate
        }
        onInvalid={(name) => toast.error(t('tags.unknown', { name }))}
        blurBehavior="add"
      >
        <TagsInputList>
          {names.map((name) => (
            <TagsInputItem key={name} value={name}>
              {name}
            </TagsInputItem>
          ))}
          <TagsInputInput
            aria-label={t('tags.label')}
            placeholder={
              canCreate ? t('tags.placeholderNew') : t('tags.placeholder')
            }
          />
        </TagsInputList>
      </TagsInput>
      {unused.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label={t('tags.available')}>
          {unused.map((tag) => (
            <li key={tag.id}>
              <button
                type="button"
                className="rounded-full focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => add(tag.name)}
                aria-label={t('tags.add', { name: tag.name })}
              >
                <TagBadge tag={tag} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-2">
        <Button
          type="button"
          size="sm"
          disabled={save.isPending}
          onClick={() => save.mutate()}
        >
          {save.isPending && <Spinner />}
          {t('save')}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={save.isPending}
          onClick={() => setEditing(false)}
        >
          {t('cancel')}
        </Button>
      </div>
    </div>
  );
}

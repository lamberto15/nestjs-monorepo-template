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
import { Skeleton } from '@nestjs-monorepo-template/ui/components/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@nestjs-monorepo-template/ui/components/table';
import { useQuery } from '@tanstack/react-query';
import { PencilIcon, Trash2Icon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { formatDateTime } from '@/lib/date-time';
import { errorMessage } from '@/lib/errors';
import {
  allTagsQuery,
  MAX_TAGS,
  subjectTagsQuery,
  TagBadge,
  type Tag,
} from '@/lib/tags';
import { useDeleteTag } from './api';
import { TagDialog } from './tag-dialog';

/** The filter's "every subject" (a subject's name is a Pascal-case word). */
const ALL = '*';

/**
 * The tags of every subject (docs/tags.md): rename, recolour, describe and
 * delete them. Tags are made where records are tagged (a record's tag editor),
 * so this page only manages the existing ones. Filter by subject, or by part of
 * a name.
 */
export function TagsPage() {
  const { t } = useTranslation('tags');
  // Every subject's tags give the subjects to choose from; a chosen subject is
  // read on its own (`?subject=`), so a subject past the first MAX_TAGS tags
  // of all is still complete.
  const everything = useQuery({ ...allTagsQuery, meta: { errorToast: false } });
  const remove = useDeleteTag();
  const [chosen, setChosen] = useState(ALL);
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<Tag>();
  const [deleting, setDeleting] = useState<Tag>();
  // Kept after the dialog closes, so its closing animation still has its text.
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const subjects = [
    ...new Set((everything.data?.tags ?? []).map((tag) => tag.subject)),
  ].toSorted();
  // The chosen subject is gone when its last tag was deleted or renamed away:
  // back to all, derived (no effect).
  const subject = subjects.includes(chosen) ? chosen : ALL;
  const ofSubject = useQuery({
    ...subjectTagsQuery(subject),
    enabled: subject !== ALL,
    meta: { errorToast: false },
  });
  const tags = subject === ALL ? everything : ofSubject;
  const all = tags.data?.tags ?? [];
  const needle = search.trim().toLowerCase();
  const shown = all
    .filter((tag) => !needle || tag.name.toLowerCase().includes(needle))
    .toSorted(
      (a, b) =>
        a.subject.localeCompare(b.subject) || a.name.localeCompare(b.name),
    );

  return (
    <div className="flex max-w-5xl flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-medium">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('description')}</p>
      </div>
      <div className="flex flex-wrap items-end gap-4">
        <Field className="w-full sm:w-56">
          <FieldLabel htmlFor="tags-subject">{t('subject')}</FieldLabel>
          <Select
            items={[
              { value: ALL, label: t('allSubjects') },
              ...subjects.map((s) => ({ value: s, label: s })),
            ]}
            value={subject}
            onValueChange={(next) => next && setChosen(next)}
          >
            <SelectTrigger id="tags-subject" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{t('allSubjects')}</SelectItem>
              {subjects.map((s) => (
                <SelectItem key={s} value={s}>
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field className="w-full sm:w-64">
          <FieldLabel htmlFor="tags-search">{t('search')}</FieldLabel>
          <Input
            id="tags-search"
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </Field>
      </div>

      {tags.isPending && <Skeleton className="h-40 w-full" aria-busy />}
      {tags.isError && (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(tags.error)}
        </p>
      )}
      {tags.isSuccess && tags.data.truncated && (
        <p role="status" className="text-sm text-muted-foreground">
          {t(subject === ALL ? 'truncatedAll' : 'truncated', { n: MAX_TAGS })}
        </p>
      )}
      {tags.isSuccess &&
        (all.length === 0 ? (
          <p role="status" className="text-sm text-muted-foreground">
            {t('none')}
          </p>
        ) : shown.length === 0 ? (
          <p role="status" className="text-sm text-muted-foreground">
            {t('noMatch')}
          </p>
        ) : (
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('columns.tag')}</TableHead>
                  <TableHead>{t('columns.subject')}</TableHead>
                  <TableHead>{t('columns.description')}</TableHead>
                  <TableHead>{t('columns.updated')}</TableHead>
                  <TableHead>
                    <span className="sr-only">{t('columns.actions')}</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {shown.map((tag) => (
                  <TableRow key={tag.id}>
                    <TableCell>
                      <TagBadge tag={tag} />
                    </TableCell>
                    <TableCell>{tag.subject}</TableCell>
                    <TableCell className="max-w-xs whitespace-normal break-words text-muted-foreground">
                      {tag.description}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {formatDateTime(tag.updatedAt)}
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="outline"
                          size="sm"
                          aria-label={t('edit', { name: tag.name })}
                          onClick={() => setEditing(tag)}
                        >
                          <PencilIcon />
                          {t('editButton')}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          aria-label={t('delete', { name: tag.name })}
                          onClick={() => {
                            setDeleting(tag);
                            setConfirmingDelete(true);
                          }}
                        >
                          <Trash2Icon />
                          {t('deleteButton')}
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ))}

      {editing && (
        <TagDialog
          // A fresh form for each tag.
          key={editing.id}
          tag={editing}
          onOpenChange={(open) => !open && setEditing(undefined)}
        />
      )}
      <ConfirmDialog
        open={confirmingDelete}
        onOpenChange={setConfirmingDelete}
        title={t('deleteTitle', { name: deleting?.name })}
        description={t('deleteDescription', {
          name: deleting?.name,
          subject: deleting?.subject,
        })}
        confirm={t('deleteConfirm')}
        onConfirm={async () => {
          if (deleting) await remove.mutateAsync(deleting.id);
          toast.success(t('deleted'));
        }}
      />
    </div>
  );
}

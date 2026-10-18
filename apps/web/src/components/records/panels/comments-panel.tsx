import { Button } from '@nestjs-monorepo-template/ui/components/button';
import {
  Mention,
  MentionContent,
  MentionInput,
  MentionItem,
} from '@nestjs-monorepo-template/ui/components/mention';
import { Skeleton } from '@nestjs-monorepo-template/ui/components/skeleton';
import { Spinner } from '@nestjs-monorepo-template/ui/components/spinner';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmButton } from '@/components/confirm-button';
import { RelativeTime } from '@/features/notifications/relative-time';
import { useDebouncedCallback } from '@/hooks/use-debounced-callback';
import { useMe } from '@/lib/features';
import { useRealtime } from '@/lib/realtime';
import {
  addComment,
  editComment,
  listComments,
  panelKeys,
  removeComment,
  type Comment,
} from './api';
import { CommentText } from './comment-text';
import { usePeople, type Person } from './users';

/** The API's limit (docs/comments.md): 1 to 10 000 characters. */
const MAX_LENGTH = 10_000;

/**
 * The text box: typing `@` offers the tenant's people (`GET /v1/people?q=`,
 * searched by name as the user types); choosing one writes `@user:<id>` into
 * the text, which is what the API reads (docs/comments.md). The body sent is
 * exactly the text. `onPicked` hears of each person chosen, so the thread
 * can name them.
 */
function CommentEditor(props: {
  initial?: string;
  submit: string;
  label: string;
  placeholder: string;
  busy: boolean;
  onSubmit: (body: string) => Promise<unknown>;
  onPicked: (person: Person) => void;
  onCancel?: () => void;
}) {
  const { t } = useTranslation('records');
  const [text, setText] = useState(props.initial ?? '');
  const [mentions, setMentions] = useState<string[]>([]);
  const [term, setTerm] = useState('');
  const search = useDebouncedCallback(setTerm, 250);
  const people = usePeople(term).data ?? [];
  const body = text.trim();

  const send = async (event: FormEvent) => {
    event.preventDefault();
    if (!body || body.length > MAX_LENGTH) {
      return;
    }
    try {
      await props.onSubmit(body);
      setText('');
      setMentions([]);
    } catch {
      // The global handler told the user; the text stays to try again.
    }
  };

  return (
    <form className="flex flex-col gap-2" onSubmit={send}>
      <Mention
        trigger="@"
        value={mentions}
        onValueChange={(keys) => {
          setMentions(keys);
          for (const person of people) {
            if (keys.includes(person.key)) props.onPicked(person);
          }
        }}
        inputValue={text}
        onInputValueChange={setText}
        disabled={props.busy}
        // The API searches by name (the next answer replaces the list); the
        // list at hand is narrowed meanwhile, by name too, not by the key.
        onFilter={(keys, typed) => {
          search(typed);
          const needle = typed.toLowerCase();
          return keys.filter((key) =>
            people.some(
              (person) =>
                person.key === key &&
                person.name.toLowerCase().includes(needle),
            ),
          );
        }}
      >
        <MentionInput
          aria-label={props.label}
          placeholder={props.placeholder}
          maxLength={MAX_LENGTH}
          autoComplete="off"
        />
        {people.length > 0 && (
          <MentionContent>
            {people.map((person) => (
              <MentionItem key={person.key} value={person.key}>
                <span className="truncate">{person.name}</span>
              </MentionItem>
            ))}
          </MentionContent>
        )}
      </Mention>
      <p className="text-xs text-muted-foreground">{t('comments.hint')}</p>
      <div className="flex justify-end gap-2">
        {props.onCancel && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={props.onCancel}
          >
            {t('cancel')}
          </Button>
        )}
        <Button type="submit" size="sm" disabled={props.busy || !body}>
          {props.busy && <Spinner />}
          {props.submit}
        </Button>
      </div>
    </form>
  );
}

/** Who wrote it, as the API names them (`authorName`). */
function authorName(
  comment: Comment,
  me: string | undefined,
  t: (key: string) => string,
) {
  if (comment.author === 'anonymous') return t('comments.anonymous');
  if (comment.author.startsWith('client:')) return t('comments.system');
  if (me !== undefined && comment.author === `user:${me}`) {
    return t('comments.you');
  }
  return comment.authorName ?? t('comments.someone');
}

function CommentItem(props: {
  comment: Comment;
  base: string;
  recordId: string;
  names: ReadonlyMap<string, string>;
  onPicked: (person: Person) => void;
  canModerate: boolean;
  refresh: () => Promise<unknown>;
}) {
  const { t } = useTranslation('records');
  const me = useMe()?.user.id;
  const { comment } = props;
  const [editing, setEditing] = useState(false);
  const own = me !== undefined && comment.author === `user:${me}`;
  const edit = useMutation({
    mutationFn: (body: string) =>
      editComment(props.base, props.recordId, comment.id, body),
    onSuccess: async () => {
      setEditing(false);
      await props.refresh();
    },
  });

  return (
    <li
      className="flex flex-col gap-1 rounded-lg border p-3"
      data-comment={comment.id}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-sm font-medium">
          {authorName(comment, me, t)}
        </span>
        <span className="flex items-baseline gap-2">
          <RelativeTime value={comment.createdAt} />
          {comment.editedAt && (
            <span className="text-xs text-muted-foreground">
              {t('comments.edited')}
            </span>
          )}
        </span>
      </div>
      {editing ? (
        <CommentEditor
          initial={comment.body}
          onPicked={props.onPicked}
          label={t('comments.editLabel')}
          placeholder={t('comments.placeholder')}
          submit={t('save')}
          busy={edit.isPending}
          onSubmit={(body) => edit.mutateAsync(body)}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <CommentText
          body={comment.body}
          names={props.names}
          unknown={t('comments.someone')}
        />
      )}
      {!editing && (own || props.canModerate) && (
        <div className="flex gap-1">
          {own && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setEditing(true)}
            >
              {t('comments.edit')}
            </Button>
          )}
          <ConfirmButton
            variant="ghost"
            size="sm"
            title={t('comments.deleteTitle')}
            description={t('comments.deleteDescription')}
            confirm={t('comments.delete')}
            onConfirm={async () => {
              await removeComment(props.base, props.recordId, comment.id);
              await props.refresh();
            }}
          >
            {t('comments.delete')}
          </ConfirmButton>
        </div>
      )}
    </li>
  );
}

/**
 * The record's conversation, oldest first (the newest last). Whoever may read
 * the record may comment; an author edits their own; the author or whoever
 * may change the record deletes (`canModerate`).
 *
 * It reloads when `record.commented` arrives for the record (RecordPanels
 * listens); without realtime (switched off, or not connected) it polls.
 * A mention `@user:<id>` shows the person's name when it is known: the
 * thread's authors, the people the autocomplete offered, the user.
 */
export function CommentsPanel(props: {
  base: string;
  id: string;
  canModerate: boolean;
}) {
  const { t } = useTranslation('records');
  const queryClient = useQueryClient();
  const live = useRealtime() !== undefined;
  const me = useMe()?.user;
  const offered = usePeople('').data;
  const [picked, setPicked] = useState<ReadonlyMap<string, string>>(new Map());
  const key = panelKeys.comments(props.base, props.id);
  const query = useQuery({
    queryKey: key,
    queryFn: () => listComments(props.base, props.id),
    refetchInterval: live ? false : 30_000,
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: key });
  const add = useMutation({
    mutationFn: (body: string) => addComment(props.base, props.id, body),
    onSuccess: refresh,
  });
  const remember = (person: Person) =>
    setPicked((current) =>
      current.get(person.key) === person.name
        ? current
        : new Map(current).set(person.key, person.name),
    );

  const names = new Map<string, string>();
  for (const person of offered ?? []) names.set(person.key, person.name);
  for (const comment of query.data ?? []) {
    if (comment.authorName) names.set(comment.author, comment.authorName);
  }
  for (const [key, name] of picked) names.set(key, name);
  if (me?.name) names.set(`user:${me.id}`, me.name);

  return (
    <div className="flex flex-col gap-4">
      {query.isPending ? (
        <div className="flex flex-col gap-2" aria-busy>
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : query.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {t('comments.error')}
        </p>
      ) : query.data.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('comments.empty')}</p>
      ) : (
        <ul className="flex flex-col gap-2" aria-label={t('comments.title')}>
          {query.data.map((comment) => (
            <CommentItem
              key={comment.id}
              comment={comment}
              base={props.base}
              recordId={props.id}
              names={names}
              onPicked={remember}
              canModerate={props.canModerate}
              refresh={refresh}
            />
          ))}
        </ul>
      )}
      <CommentEditor
        label={t('comments.label')}
        placeholder={t('comments.placeholder')}
        submit={t('comments.add')}
        busy={add.isPending}
        onSubmit={(body) => add.mutateAsync(body)}
        onPicked={remember}
      />
    </div>
  );
}

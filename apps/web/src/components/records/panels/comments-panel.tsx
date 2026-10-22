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
import { PersonAvatar, UserAvatar } from '@/components/user-avatar';
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
import { labelFor, toBody, toDraft, type Picked } from './comment-draft';
import { CommentText, useMentionNames } from './comment-text';
import { usePeople } from './users';

/** The API's limit (docs/comments.md): 1 to 10 000 characters. */
const MAX_LENGTH = 10_000;

/**
 * The text box: typing `@` offers the tenant's people (`GET /v1/people?q=`,
 * searched by name as the user types); choosing one writes `@Name` into the
 * box, and the body sent has `@user:<id>` in its place, which is what the API
 * reads (docs/comments.md; comment-draft.ts does the turning). The API names
 * the people mentioned (`mentionNames`).
 *
 * Dice UI's input is not a controlled one: it keeps its own value, and each
 * mention's place inside, whatever the `inputValue` says. So the input is
 * given `value`, and after a send the `Mention` is made anew (`key`), the only
 * way to make it forget the places of the mentions just sent.
 */
function CommentEditor(props: {
  /** The body to edit; its mentions show by name (`names`). */
  initial?: string;
  /** The names of the people `initial` mentions (`mentionNames`). */
  names?: Readonly<Record<string, string | null>>;
  submit: string;
  label: string;
  placeholder: string;
  busy: boolean;
  onSubmit: (body: string) => Promise<unknown>;
  onCancel?: () => void;
}) {
  const { t } = useTranslation('records');
  const [draft] = useState(() => toDraft(props.initial ?? '', props.names));
  const [text, setText] = useState(draft.text);
  // Whom each label in the box stands for. Only added to: Dice UI drops every
  // mention of a person when one is deleted, but a label left in the text
  // must still turn into the id it stood for.
  const [picked, setPicked] = useState<Picked>(draft.picked);
  const [session, setSession] = useState(0);
  const [term, setTerm] = useState('');
  const search = useDebouncedCallback(setTerm, 250);
  const people = usePeople(term).data ?? [];
  // The label each listed person gets (their name, told apart from another's
  // of the same name), or the one already written for them.
  const used = new Map([
    ...people.map((person) => [person.key, person.name] as const),
    ...Object.entries(picked),
  ]);
  const labels = new Map(
    people.map((person) => [
      person.key,
      picked[person.key] ?? labelFor(person.key, person.name, used),
    ]),
  );
  const trimmed = text.trim();
  const body = toBody(trimmed, picked);

  const send = async (event: FormEvent) => {
    event.preventDefault();
    if (!trimmed || body.length > MAX_LENGTH) {
      return;
    }
    try {
      await props.onSubmit(body);
      setText('');
      setPicked({});
      setSession((n) => n + 1);
    } catch {
      // The global handler told the user; the text stays to try again.
    }
  };

  return (
    <form className="flex flex-col gap-2" onSubmit={send}>
      <Mention
        key={session}
        trigger="@"
        onValueChange={(keys) =>
          setPicked((before) => {
            const after = { ...before };
            for (const key of keys) {
              const label = labels.get(key);
              if (label !== undefined) {
                after[key] ??= label;
              }
            }
            return after;
          })
        }
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
          value={text}
          // The room left for the text once the names are ids (a mention
          // is longer as an id than as a name).
          maxLength={MAX_LENGTH - (body.length - trimmed.length)}
          autoComplete="off"
        />
        {people.length > 0 && (
          <MentionContent>
            {people.map((person) => (
              <MentionItem
                key={person.key}
                value={person.key}
                label={labels.get(person.key)}
              >
                <UserAvatar
                  size="sm"
                  name={person.name}
                  src={person.avatarUrl}
                />
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
        <Button
          type="submit"
          size="sm"
          disabled={props.busy || !trimmed || body.length > MAX_LENGTH}
        >
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
  canModerate: boolean;
  refresh: () => Promise<unknown>;
}) {
  const { t } = useTranslation('records');
  const me = useMe()?.user.id;
  const { comment } = props;
  const names = useMentionNames(comment.body, comment.mentionNames);
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
        <span className="flex items-center gap-2 text-sm font-medium">
          {comment.author.startsWith('user:') && (
            <PersonAvatar
              size="sm"
              value={comment.author}
              name={authorName(comment, me, t)}
            />
          )}
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
          names={names}
          label={t('comments.editLabel')}
          placeholder={t('comments.placeholder')}
          submit={t('save')}
          busy={edit.isPending}
          onSubmit={(body) => edit.mutateAsync(body)}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <CommentText body={comment.body} names={names} />
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
 * A mention `@user:<id>` shows the person's name (`mentionNames`, else the
 * people directory: useMentionNames).
 */
export function CommentsPanel(props: {
  base: string;
  id: string;
  canModerate: boolean;
}) {
  const { t } = useTranslation('records');
  const queryClient = useQueryClient();
  const live = useRealtime() !== undefined;
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
      />
    </div>
  );
}

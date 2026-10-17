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
import { useMe } from '@/lib/features';
import {
  addComment,
  editComment,
  listComments,
  panelKeys,
  removeComment,
  type Comment,
} from './api';
import { CommentText } from './comment-text';
import { useMentionable, type Mentionable } from './users';

/** The API's limit (docs/comments.md): 1 to 10 000 characters. */
const MAX_LENGTH = 10_000;

/**
 * The text box: typing `@` offers the people the directory knows; choosing
 * one writes `@<address>` into the text, which is what the API reads
 * (docs/comments.md). The body sent is exactly the text.
 */
function CommentEditor(props: {
  initial?: string;
  users: readonly Mentionable[];
  submit: string;
  label: string;
  placeholder: string;
  busy: boolean;
  onSubmit: (body: string) => Promise<unknown>;
  onCancel?: () => void;
}) {
  const { t } = useTranslation('records');
  const [text, setText] = useState(props.initial ?? '');
  const [mentions, setMentions] = useState<string[]>([]);
  const body = text.trim();
  const search = (term: string) => {
    const needle = term.toLowerCase();
    return props.users.filter(
      (user) =>
        user.email.toLowerCase().includes(needle) ||
        user.name.toLowerCase().includes(needle),
    );
  };

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
        onValueChange={setMentions}
        inputValue={text}
        onInputValueChange={setText}
        disabled={props.busy}
        // The directory is searched here by name and address, not by the
        // address alone.
        onFilter={(options, term) =>
          options.filter((option) =>
            search(term).some((user) => user.email === option),
          )
        }
      >
        <MentionInput
          aria-label={props.label}
          placeholder={props.placeholder}
          maxLength={MAX_LENGTH}
          autoComplete="off"
        />
        {props.users.length > 0 && (
          <MentionContent>
            {props.users.map((user) => (
              <MentionItem key={user.id} value={user.email}>
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">{user.name}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {user.email}
                  </span>
                </span>
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

function authorName(
  author: string,
  me: string | undefined,
  users: readonly Mentionable[],
  t: (key: string) => string,
) {
  if (author === 'anonymous') return t('comments.anonymous');
  if (author.startsWith('client:')) return t('comments.system');
  const id = author.replace(/^user:/, '');
  if (id === me) return t('comments.you');
  return users.find((user) => user.id === id)?.name ?? t('comments.someone');
}

function CommentItem(props: {
  comment: Comment;
  base: string;
  recordId: string;
  users: readonly Mentionable[];
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
          {authorName(comment.author, me, props.users, t)}
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
          users={props.users}
          label={t('comments.editLabel')}
          placeholder={t('comments.placeholder')}
          submit={t('save')}
          busy={edit.isPending}
          onSubmit={(body) => edit.mutateAsync(body)}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <CommentText body={comment.body} users={props.users} />
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
 * No realtime event carries comments (backend finding), so it refreshes on a
 * timer, on focus and on the `refresh` of the parent (a notification arrived).
 */
export function CommentsPanel(props: {
  base: string;
  id: string;
  canModerate: boolean;
}) {
  const { t } = useTranslation('records');
  const queryClient = useQueryClient();
  const users = useMentionable().data ?? [];
  const key = panelKeys.comments(props.base, props.id);
  const query = useQuery({
    queryKey: key,
    queryFn: () => listComments(props.base, props.id),
    refetchInterval: 30_000,
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
              users={users}
              canModerate={props.canModerate}
              refresh={refresh}
            />
          ))}
        </ul>
      )}
      <CommentEditor
        users={users}
        label={t('comments.label')}
        placeholder={t('comments.placeholder')}
        submit={t('comments.add')}
        busy={add.isPending}
        onSubmit={(body) => add.mutateAsync(body)}
      />
    </div>
  );
}

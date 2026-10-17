import { useRouter } from '@tanstack/react-router';
import type { NotificationItem } from '@nestjs-monorepo-template/api-client';
import { Button } from '@nestjs-monorepo-template/ui/components/button';
import { CheckIcon, Trash2Icon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { normalizeRedirect } from '@/lib/safe-redirect';
import { RelativeTime } from './relative-time';

/**
 * One notification: unread dot, title, text, age. With a `link` (a path of
 * this app, checked) the row opens it; opening marks it read.
 */
export function NotificationRow(props: {
  item: NotificationItem;
  /** Mark read / remove are offered only when given (not while impersonating). */
  onRead?: (id: string) => void;
  onRemove?: (id: string) => void;
  /** After the row opened its link (the bell closes its popover). */
  onOpen?: () => void;
}) {
  const { t } = useTranslation('notifications');
  const router = useRouter();
  const { item, onRead, onRemove } = props;
  const path = normalizeRedirect(item.link);

  const open = () => {
    if (!item.read) {
      onRead?.(item.id);
    }
    if (path) {
      router.history.push(path);
      props.onOpen?.();
    }
  };

  const text = (
    <>
      <span className="flex items-center gap-2">
        {!item.read && (
          <span
            role="img"
            aria-label={t('item.unread')}
            className="size-2 shrink-0 rounded-full bg-primary"
          />
        )}
        <span className="truncate text-sm font-medium">{item.title}</span>
      </span>
      {item.body && (
        <span className="line-clamp-2 text-sm text-muted-foreground">
          {item.body}
        </span>
      )}
      <RelativeTime value={item.updatedAt} />
    </>
  );

  return (
    <li className="flex items-start gap-1 border-b p-2 last:border-b-0">
      {path ? (
        <button
          type="button"
          onClick={open}
          className="flex min-w-0 flex-1 flex-col gap-0.5 rounded-md p-1 text-start hover:bg-muted"
        >
          {text}
        </button>
      ) : (
        <div className="flex min-w-0 flex-1 flex-col gap-0.5 p-1">{text}</div>
      )}
      <div className="flex shrink-0">
        {onRead && !item.read && (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('item.markRead')}
            title={t('item.markRead')}
            onClick={() => onRead(item.id)}
          >
            <CheckIcon />
          </Button>
        )}
        {onRemove && (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('item.remove')}
            title={t('item.remove')}
            onClick={() => onRemove(item.id)}
          >
            <Trash2Icon />
          </Button>
        )}
      </div>
    </li>
  );
}

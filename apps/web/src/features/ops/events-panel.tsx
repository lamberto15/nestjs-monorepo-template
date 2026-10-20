import { Badge } from '@nestjs-monorepo-template/ui/components/badge';
import { Button } from '@nestjs-monorepo-template/ui/components/button';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useOpsEvents, type LogEntry } from './use-ops-events';

/** A line of the log shows at most this much of an event's details. */
const DETAIL_LIMIT = 300;

/** What an event is about: its `type` (the outbox's, the workflow's…) when it has one. */
function kindOf(event: LogEntry['event']): string {
  for (const key of ['type', 'event', 'name', 'kind']) {
    const value = event[key];
    if (typeof value === 'string') {
      return value;
    }
  }
  return '';
}

/** The rest of the event as one line of text, cut short. */
function detailOf(event: LogEntry['event']): string {
  const { source: _source, at: _at, ...rest } = event;
  const text = JSON.stringify(rest) ?? '';
  return text.length > DETAIL_LIMIT ? `${text.slice(0, DETAIL_LIMIT)}…` : text;
}

const time = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/**
 * Every engine's events as they happen. The stream is open while this
 * panel is mounted and not paused. Event details are remote text: rendered
 * as text, never as markup.
 */
export function EventsPanel() {
  const { t } = useTranslation('ops');
  const [live, setLive] = useState(true);
  const { entries, status, clear } = useOpsEvents(live);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge
          variant={status === 'open' ? 'default' : 'outline'}
          data-testid="stream-status"
        >
          {t(`events.status.${status}`)}
        </Badge>
        <span className="flex-1 text-sm text-muted-foreground">
          {t('events.description', { count: entries.length })}
        </span>
        <Button variant="outline" size="sm" onClick={() => setLive(!live)}>
          {live ? t('events.pause') : t('events.resume')}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={entries.length === 0}
          onClick={clear}
        >
          {t('events.clear')}
        </Button>
      </div>
      {entries.length ? (
        <ol
          className="max-h-[32rem] overflow-auto rounded-md border text-xs"
          aria-label={t('events.log')}
        >
          {entries.map(({ id, event }) => (
            <li
              key={id}
              className="flex flex-wrap items-baseline gap-x-2 border-b px-3 py-1.5 last:border-b-0"
            >
              <time className="font-mono text-muted-foreground">
                {time.format(event.at)}
              </time>
              <Badge variant="secondary">{event.source}</Badge>
              <span className="font-medium">{kindOf(event)}</span>
              <span className="min-w-0 break-all font-mono text-muted-foreground">
                {detailOf(event)}
              </span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-sm text-muted-foreground">{t('events.empty')}</p>
      )}
    </div>
  );
}

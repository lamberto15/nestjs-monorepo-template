import { Badge } from '@nestjs-monorepo-template/ui/components/badge';
import { Button } from '@nestjs-monorepo-template/ui/components/button';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useDateTimeFormat } from '@/lib/date-time';
import { useOpsEvents } from './use-ops-events';

/**
 * Every engine's events as they happen. The stream is open while this
 * panel is mounted and not paused. Event details are remote text: rendered
 * as text, never as markup.
 */
export function EventsPanel() {
  const { t } = useTranslation('ops');
  const format = useDateTimeFormat();
  const [live, setLive] = useState(true);
  const { entries, status, clear, reconnect } = useOpsEvents(live);
  // The browser gave up (a refusal, or the connection ended): only a new one helps.
  const ended = live && status === 'closed';
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
        {ended ? (
          <Button variant="outline" size="sm" onClick={reconnect}>
            {t('events.reconnect')}
          </Button>
        ) : (
          <Button variant="outline" size="sm" onClick={() => setLive(!live)}>
            {live ? t('events.pause') : t('events.resume')}
          </Button>
        )}
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
          tabIndex={0}
          className="max-h-[32rem] overflow-auto rounded-md border text-xs focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
          aria-label={t('events.log')}
        >
          {entries.map((entry) => (
            <li
              key={entry.id}
              className="flex flex-wrap items-baseline gap-x-2 border-b px-3 py-1.5 last:border-b-0"
            >
              <time className="font-mono text-muted-foreground">
                {format(new Date(entry.at).toISOString(), 'time')}
              </time>
              <Badge variant="secondary">{entry.source}</Badge>
              <span className="font-medium">{entry.kind}</span>
              <span className="min-w-0 break-all font-mono text-muted-foreground">
                {entry.detail}
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

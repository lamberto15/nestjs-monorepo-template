import { Button } from '@nestjs-monorepo-template/ui/components/button';
import { useTranslation } from 'react-i18next';
import type { RecordViews as Declared, ViewKind } from './api';
import { Board } from './board';
import { Calendar } from './calendar';
import { Timeline } from './timeline';
import type { ViewProps } from './rows';

/** Table, board, calendar, timeline: the kinds the list offers, one pressed. */
export function ViewSwitcher(props: {
  kinds: ViewKind[];
  kind: ViewKind;
  onChange: (kind: ViewKind) => void;
}) {
  const { t } = useTranslation('record-views');
  return (
    <div role="group" aria-label={t('switch')} className="flex gap-1">
      {props.kinds.map((kind) => (
        <Button
          key={kind}
          size="sm"
          variant={kind === props.kind ? 'default' : 'outline'}
          aria-pressed={kind === props.kind}
          onClick={() => props.onChange(kind)}
        >
          {t(`kinds.${kind}`)}
        </Button>
      ))}
    </div>
  );
}

/** The declared view of a kind other than the table. */
export function RecordViewOf(
  props: ViewProps & { subject: string; kind: ViewKind; views: Declared },
) {
  const { views, kind, ...rest } = props;
  if (kind === 'board' && views.board) {
    return (
      <Board
        {...rest}
        field={views.board.field}
        readOnly={views.board.readOnly}
      />
    );
  }
  if (kind === 'calendar' && views.calendar) {
    return (
      <Calendar
        {...rest}
        fields={views.calendar.fields}
        readOnly={views.calendar.readOnly}
      />
    );
  }
  if (kind === 'timeline' && views.timeline) {
    return (
      <Timeline
        {...rest}
        start={views.timeline.start}
        end={views.timeline.end}
      />
    );
  }
  return null;
}

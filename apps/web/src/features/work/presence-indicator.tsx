import { Badge } from '@nestjs-monorepo-template/ui/components/badge';
import { PencilIcon, UsersIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { usePresence } from './api';

/**
 * Who else is on this record, and a warning when someone is editing it.
 * Advisory (saving is still guarded by the ETag); shows nothing when the
 * person is alone:
 *
 *   <PresenceIndicator subject="Note" recordId={note.id} mode="viewing" />
 */
export function PresenceIndicator(props: {
  subject: string;
  recordId: string;
  mode: 'viewing' | 'editing';
}) {
  const { t } = useTranslation('work');
  const others = usePresence(props.subject, props.recordId, props.mode);
  if (others.length === 0) {
    return null;
  }
  const editing = others.filter((person) => person.mode === 'editing');
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground"
    >
      {others.map((person) => (
        <Badge
          key={person.key}
          variant={person.mode === 'editing' ? 'default' : 'secondary'}
        >
          {person.mode === 'editing' ? (
            <PencilIcon aria-hidden />
          ) : (
            <UsersIcon aria-hidden />
          )}
          {t(`presence.${person.mode}`, { name: person.name })}
        </Badge>
      ))}
      {editing.length > 0 && <span>{t('presence.warning')}</span>}
    </div>
  );
}

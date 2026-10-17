import { Badge } from '@nestjs-monorepo-template/ui/components/badge';
import { useTranslation } from 'react-i18next';
import type { Setting } from './settings';

export function SourceBadge({ source }: { source: Setting['source'] }) {
  const { t } = useTranslation('settings');
  return (
    <Badge variant={source === 'default' ? 'outline' : 'secondary'}>
      {t(`source.${source}`)}
    </Badge>
  );
}

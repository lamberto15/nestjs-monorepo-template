import { Button } from '@nestjs-monorepo-template/ui/components/button';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { UploadIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { catalogQuery } from './api';

/** "Import" on a list page: shown when the user may import `importer` (`GET /v1/data`). */
export function ImportButton(props: { importer: string }) {
  const { t } = useTranslation('transfer');
  const catalog = useQuery({ ...catalogQuery, meta: { errorToast: false } });
  if (!catalog.data?.imports.some((i) => i.name === props.importer)) {
    return null;
  }
  return (
    <Button
      variant="outline"
      nativeButton={false}
      render={<Link to="/transfers/import" search={{ name: props.importer }} />}
    >
      <UploadIcon />
      {t('import.action')}
    </Button>
  );
}

import { Button } from '@nestjs-monorepo-template/ui/components/button';
import { useQuery } from '@tanstack/react-query';
import { CalendarClockIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { catalogQuery } from '@/features/transfer/api';
import { useFeature } from '@/lib/features';
import { ReportDialog } from './report-dialog';

/**
 * "Schedule a report" from a list page: the export `exporter` with the list's
 * current filter, search and sort, run on a schedule and mailed. Shown when
 * reports are on (`REPORTS`) and the user may run that export.
 */
export function ScheduleReportButton(props: {
  exporter: string;
  filters: Record<string, string>;
  sort?: string;
}) {
  const { t } = useTranslation('reports');
  const on = useFeature('reports');
  const catalog = useQuery({
    ...catalogQuery,
    enabled: on,
    meta: { errorToast: false },
  });
  const [open, setOpen] = useState(false);
  const may = catalog.data?.exports.some((e) => e.name === props.exporter);
  if (!on || !may) return null;
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <CalendarClockIcon />
        {t('schedule.action')}
      </Button>
      {open && (
        <ReportDialog
          open
          onOpenChange={setOpen}
          draft={{
            exporter: props.exporter,
            filters: props.filters,
            sort: props.sort,
          }}
        />
      )}
    </>
  );
}

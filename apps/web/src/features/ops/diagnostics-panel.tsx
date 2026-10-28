import { Badge } from '@nestjs-monorepo-template/ui/components/badge';
import { Button } from '@nestjs-monorepo-template/ui/components/button';
import { Spinner } from '@nestjs-monorepo-template/ui/components/spinner';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@nestjs-monorepo-template/ui/components/table';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { errorMessage } from '@/lib/errors';
import { FormAlert } from '@/lib/form';
import {
  opsDiagnosticsQuery,
  useTestDiagnostic,
  type Diagnostic,
} from './queries';

const variant = (state: Diagnostic['state']) =>
  state === 'ok'
    ? 'default'
    : state === 'unavailable' || state === 'unconfigured'
      ? 'destructive'
      : 'outline';

/**
 * The integrations (database, Redis, workers, mail, storage, realtime):
 * each one's state, driver, the masked error and a hint, and a safe test
 * for those that have one. The API's texts are remote: shown as text.
 */
export function DiagnosticsPanel() {
  const { t } = useTranslation('ops');
  const diagnostics = useQuery(opsDiagnosticsQuery);
  const test = useTestDiagnostic();
  const [testing, setTesting] = useState<string | null>(null);
  if (diagnostics.isPending) {
    return <Spinner />;
  }
  if (diagnostics.isError) {
    return <FormAlert message={errorMessage(diagnostics.error)} />;
  }
  const run = async (check: Diagnostic['check']) => {
    setTesting(check);
    try {
      const result = await test.mutateAsync(check);
      if (result.ok) {
        toast.success(
          t('diagnostics.passed', {
            check: t(`diagnostics.checks.${check}`),
            ms: result.durationMs,
          }),
        );
      } else {
        toast.error(
          t('diagnostics.failed', { check: t(`diagnostics.checks.${check}`) }),
          { description: result.detail ?? result.hint ?? undefined },
        );
      }
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setTesting(null);
    }
  };
  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('diagnostics.check')}</TableHead>
            <TableHead>{t('diagnostics.state')}</TableHead>
            <TableHead>{t('diagnostics.driver')}</TableHead>
            <TableHead>{t('diagnostics.details')}</TableHead>
            <TableHead>
              <span className="sr-only">{t('diagnostics.actions')}</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {diagnostics.data.items.map((item) => (
            <TableRow key={item.check}>
              <TableCell>{t(`diagnostics.checks.${item.check}`)}</TableCell>
              <TableCell>
                <Badge variant={variant(item.state)}>
                  {t(`diagnostics.states.${item.state}`)}
                </Badge>
              </TableCell>
              <TableCell className="font-mono text-xs">
                {item.driver ?? '—'}
              </TableCell>
              <TableCell className="max-w-md break-words whitespace-normal text-xs">
                {item.detail && <p>{item.detail}</p>}
                {item.hint && (
                  <p className="text-muted-foreground">{item.hint}</p>
                )}
              </TableCell>
              <TableCell className="text-end">
                {diagnostics.data.canTest && item.testable && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={testing !== null}
                    onClick={() => void run(item.check)}
                  >
                    {testing === item.check ? (
                      <Spinner />
                    ) : (
                      t('diagnostics.test')
                    )}
                  </Button>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

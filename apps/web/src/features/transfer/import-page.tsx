import {
  Button,
  buttonVariants,
} from '@nestjs-monorepo-template/ui/components/button';
import {
  Field,
  FieldLabel,
} from '@nestjs-monorepo-template/ui/components/field';
import {
  FileUpload,
  FileUploadDropzone,
  FileUploadItem,
  FileUploadItemDelete,
  FileUploadItemMetadata,
  FileUploadItemPreview,
  FileUploadList,
  FileUploadTrigger,
} from '@nestjs-monorepo-template/ui/components/file-upload';
import { Progress } from '@nestjs-monorepo-template/ui/components/progress';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@nestjs-monorepo-template/ui/components/select';
import { Skeleton } from '@nestjs-monorepo-template/ui/components/skeleton';
import { Spinner } from '@nestjs-monorepo-template/ui/components/spinner';
import { Switch } from '@nestjs-monorepo-template/ui/components/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@nestjs-monorepo-template/ui/components/table';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { DownloadIcon, UploadIcon, XIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { EmptyState } from '@/components/empty-state';
import { Page, PageHeader } from '@/components/page-header';
import { formatSize } from '@/components/records/panels/attachments-panel';
import {
  catalogQuery,
  startImport,
  templateUrl,
  type TransferFormat,
} from './api';
import { TransferStatus } from './transfer-status';

/**
 * Import into a subject: the columns it takes (and a template to fill), the
 * file, optionally a check without writing (`dryRun`), then the job's
 * progress and the refused rows. The API reads columns by their header name:
 * there is no mapping step.
 */
export function ImportPage(props: { name?: string }) {
  const { t, i18n } = useTranslation('transfer');
  const catalog = useQuery({ ...catalogQuery, meta: { errorToast: false } });
  const [chosen, setChosen] = useState(props.name);
  const [files, setFiles] = useState<File[]>([]);
  const [fileHeaders, setFileHeaders] = useState<string[]>([]);
  const [dryRun, setDryRun] = useState(true);
  const [matchOn, setMatchOn] = useState('');
  const [percent, setPercent] = useState<number>();
  const [jobId, setJobId] = useState<string>();
  // A refused upload (415, 413, 403) is a toast: the global handler's.
  const upload = useMutation({
    mutationFn: (input: {
      name: string;
      file: File;
      dryRun: boolean;
      matchOn?: string;
    }) => startImport(input, setPercent),
    onMutate: () => setPercent(0),
    onSettled: () => setPercent(undefined),
    onSuccess: (started) => {
      setJobId(started.id);
    },
  });

  if (catalog.isPending) return <Skeleton className="h-40 w-full" aria-busy />;
  if (catalog.isError) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {t('status.error')}
      </p>
    );
  }
  const imports = catalog.data.imports;
  // The server's catalog is authoritative: operators and tenant admins can
  // change both limits without rebuilding the web app.
  const importLimits = catalog.data.importLimits;
  const { maxBytes, maxRows } = importLimits;
  const importer = imports.find((i) => i.name === (chosen ?? imports[0]?.name));
  const matchKeys = importer?.matchKeys ?? [];
  const file = files[0];

  const start = () => {
    if (importer && file)
      upload.mutate({
        name: importer.name,
        file,
        dryRun,
        matchOn: matchOn || undefined,
      });
  };

  return (
    <Page width="narrow">
      <PageHeader
        title={t('import.title')}
        description={importer ? t('import.description') : undefined}
      />
      {!importer ? (
        <EmptyState title={t('import.nothing')} />
      ) : (
        <>
          <Field>
            <FieldLabel htmlFor="import-subject">
              {t('import.subject')}
            </FieldLabel>
            <Select
              items={imports.map((i) => ({ value: i.name, label: i.name }))}
              value={importer.name}
              onValueChange={(value) => {
                setChosen(value ?? undefined);
                setMatchOn('');
                setJobId(undefined);
              }}
            >
              <SelectTrigger id="import-subject" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {imports.map((i) => (
                  <SelectItem key={i.name} value={i.name}>
                    {i.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          {matchKeys.length > 0 && (
            <Field>
              <FieldLabel htmlFor="import-match-on">
                {t('import.matchOn')}
              </FieldLabel>
              <Select
                value={matchOn || '__insert'}
                onValueChange={(value) =>
                  setMatchOn(value === '__insert' ? '' : (value ?? ''))
                }
              >
                <SelectTrigger id="import-match-on" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__insert">
                    {t('import.insertOnly')}
                  </SelectItem>
                  {matchKeys.map((key) => (
                    <SelectItem key={key} value={key}>
                      {t('import.updateMatching', { key })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}

          <div className="overflow-hidden rounded-md border">
            <Table aria-label={t('import.columns')}>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('import.column')}</TableHead>
                  <TableHead>{t('import.type')}</TableHead>
                  <TableHead>{t('import.required')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {importer.columns.map((column) => (
                  <TableRow key={column.name}>
                    <TableCell className="font-medium">{column.name}</TableCell>
                    <TableCell>{column.type}</TableCell>
                    <TableCell>
                      {column.required ? t('import.yes') : t('import.no')}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span>{t('import.template')}</span>
            {(['csv', 'xlsx'] as TransferFormat[])
              .filter((f) => importer.formats.includes(f))
              .map((format) => (
                <a
                  key={format}
                  href={templateUrl(importer.name, format)}
                  download
                  className={buttonVariants({ variant: 'outline', size: 'sm' })}
                >
                  <DownloadIcon />
                  {t(`formats.${format}`)}
                </a>
              ))}
          </div>

          <FileUpload
            value={files}
            onValueChange={(next) => {
              const selected = next.slice(-1);
              setFiles(selected);
              setFileHeaders([]);
              setMatchOn('');
              setJobId(undefined);
              const chosenFile = selected[0];
              if (chosenFile) {
                void matchableHeaders(chosenFile).then((headers) => {
                  setFileHeaders(headers);
                  const matches = matchKeys.filter((key) =>
                    headers.includes(key),
                  );
                  if (matches.length === 1) setMatchOn(matches[0]!);
                });
              }
            }}
            maxFiles={1}
            maxSize={maxBytes}
            accept=".csv,.json,.xlsx"
            onFileReject={(rejected, message) =>
              toast.error(
                t('import.rejected', {
                  name: rejected.name,
                  reason:
                    message === 'File too large'
                      ? t('import.tooLarge', {
                          max: formatSize(maxBytes, i18n.language),
                        })
                      : message,
                }),
              )
            }
          >
            <FileUploadDropzone>
              <div className="flex flex-col items-center gap-1 text-center">
                <UploadIcon className="size-6 text-muted-foreground" />
                <p className="text-sm font-medium">{t('import.drop')}</p>
                <p className="text-xs text-muted-foreground">
                  {t('import.limit', {
                    max: formatSize(maxBytes, i18n.language),
                  })}
                </p>
              </div>
              <FileUploadTrigger
                render={<Button variant="outline" size="sm" type="button" />}
              >
                {t('import.choose')}
              </FileUploadTrigger>
            </FileUploadDropzone>
            <FileUploadList>
              {files.map((f) => (
                <FileUploadItem key={`${f.name}-${f.size}`} value={f}>
                  <FileUploadItemPreview />
                  <FileUploadItemMetadata />
                  <FileUploadItemDelete
                    render={
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        type="button"
                        aria-label={t('import.remove')}
                      />
                    }
                  >
                    <XIcon />
                  </FileUploadItemDelete>
                </FileUploadItem>
              ))}
            </FileUploadList>
          </FileUpload>
          {file && fileHeaders.length > 0 && (
            <p role="status" className="-mt-3 text-xs text-muted-foreground">
              {t('import.profile', {
                matched: importer.columns.filter((column) =>
                  fileHeaders.includes(column.name),
                ).length,
                expected: importer.columns.length,
                missing:
                  importer.columns
                    .filter((column) => !fileHeaders.includes(column.name))
                    .map((column) => column.name)
                    .join(', ') || t('import.noneMissing'),
              })}
            </p>
          )}
          {maxRows !== undefined && (
            <p className="-mt-3 text-xs text-muted-foreground">
              {t('import.rowLimit', { count: maxRows })}
            </p>
          )}

          <div className="flex items-center gap-2">
            <Switch
              id="import-dry-run"
              checked={dryRun}
              onCheckedChange={setDryRun}
            />
            <label htmlFor="import-dry-run" className="text-sm">
              {t('import.dryRun')}
            </label>
          </div>
          <p className="-mt-2 text-xs text-muted-foreground">
            {dryRun ? t('import.dryRunHint') : t('import.writeHint')}
          </p>

          <div className="flex items-center gap-2">
            <Button disabled={!file || upload.isPending} onClick={start}>
              {upload.isPending && <Spinner />}
              {dryRun ? t('import.check') : t('import.start')}
            </Button>
            <Button
              variant="outline"
              nativeButton={false}
              render={<Link to="/transfers" />}
            >
              {t('import.mine')}
            </Button>
          </div>
          {percent !== undefined && (
            <Progress
              value={percent}
              aria-label={t('import.uploading')}
              className="flex-col"
            >
              <p className="text-sm text-muted-foreground">
                {t('import.uploadingPercent', { percent })}
              </p>
            </Progress>
          )}
          {jobId && <TransferStatus id={jobId} />}
        </>
      )}
    </Page>
  );
}

async function matchableHeaders(file: File): Promise<string[]> {
  // This optional matched-import hint needs only the first JSON object/header;
  // keep it bounded so a large upload is never copied wholesale to JS memory.
  const text = await file
    .slice(0, 1024 * 1024)
    .text()
    .catch(() => '');
  if (file.name.toLowerCase().endsWith('.json')) {
    try {
      const value: unknown = JSON.parse(text);
      const first = Array.isArray(value) ? value[0] : undefined;
      return first && typeof first === 'object' ? Object.keys(first) : [];
    } catch {
      return [];
    }
  }
  if (!file.name.toLowerCase().endsWith('.csv')) return [];
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  return firstLine
    .split(',')
    .map((cell) => cell.trim().replace(/^"|"$/g, '').replaceAll('""', '"'));
}

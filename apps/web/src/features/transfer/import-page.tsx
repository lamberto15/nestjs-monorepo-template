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
import { formatSize } from '@/components/records/panels/attachments-panel';
import {
  catalogQuery,
  startImport,
  templateUrl,
  type TransferFormat,
} from './api';
import { TransferStatus } from './transfer-status';

/** The API's limit (docs/data-transfer.md); it holds the upload to it anyway (413). */
export const IMPORT_MAX_BYTES = 50 * 1024 * 1024;

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
  const [dryRun, setDryRun] = useState(true);
  const [percent, setPercent] = useState<number>();
  const [jobId, setJobId] = useState<string>();
  // A refused upload (415, 413, 403) is a toast: the global handler's.
  const upload = useMutation({
    mutationFn: (input: { name: string; file: File; dryRun: boolean }) =>
      startImport(input, setPercent),
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
  const importer = imports.find((i) => i.name === (chosen ?? imports[0]?.name));
  const file = files[0];

  const start = () => {
    if (importer && file) upload.mutate({ name: importer.name, file, dryRun });
  };

  return (
    <section className="flex max-w-3xl flex-col gap-4">
      <h1 className="text-xl font-medium">{t('import.title')}</h1>
      {!importer ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t('import.nothing')}
        </p>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            {t('import.description')}
          </p>
          <Field>
            <FieldLabel htmlFor="import-subject">
              {t('import.subject')}
            </FieldLabel>
            <Select
              items={imports.map((i) => ({ value: i.name, label: i.name }))}
              value={importer.name}
              onValueChange={(value) => {
                setChosen(value ?? undefined);
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
              setFiles(next.slice(-1));
              setJobId(undefined);
            }}
            maxFiles={1}
            maxSize={IMPORT_MAX_BYTES}
            accept=".csv,.json,.xlsx"
            onFileReject={(rejected, message) =>
              toast.error(
                t('import.rejected', {
                  name: rejected.name,
                  reason:
                    message === 'File too large'
                      ? t('import.tooLarge', {
                          max: formatSize(IMPORT_MAX_BYTES, i18n.language),
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
                    max: formatSize(IMPORT_MAX_BYTES, i18n.language),
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
    </section>
  );
}

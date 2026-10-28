import { Button } from '@nestjs-monorepo-template/ui/components/button';
import {
  Field,
  FieldLabel,
} from '@nestjs-monorepo-template/ui/components/field';
import { Input } from '@nestjs-monorepo-template/ui/components/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@nestjs-monorepo-template/ui/components/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@nestjs-monorepo-template/ui/components/table';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  deleteMapping,
  type ImportMapping,
  mappingsQuery,
  saveMapping,
} from './api';

/** A header's choice in the select: its own name, ignored, or a column. */
const SAME = '__same';
const IGNORE = '__ignore';

/**
 * The file's headers against the template's columns (docs/data-transfer.md,
 * "Column mappings"): each header with a sample value, renamed to a column,
 * ignored, or kept as it is. Only what differs goes in the mapping; the
 * server checks it again against the template and the caller's fields, and
 * the dry run shows the rows as they would import. Saved mappings are the
 * tenant's, by import.
 */
export function ColumnMapping(props: {
  importer: string;
  columns: readonly string[];
  headers: readonly string[];
  samples: readonly string[];
  mapping: ImportMapping;
  onChange: (mapping: ImportMapping) => void;
}) {
  const { t } = useTranslation('transfer');
  const client = useQueryClient();
  const saved = useQuery({
    ...mappingsQuery(props.importer),
    meta: { errorToast: false },
  });
  const [name, setName] = useState('');
  const save = useMutation({
    mutationFn: () =>
      saveMapping(props.importer, {
        name: name.trim(),
        mapping: props.mapping,
      }),
    onSuccess: () => {
      setName('');
      toast.success(t('mapping.saved'));
      void client.invalidateQueries(mappingsQuery(props.importer));
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => deleteMapping(props.importer, id),
    onSuccess: () =>
      void client.invalidateQueries(mappingsQuery(props.importer)),
  });

  const choiceOf = (header: string) => {
    if (!Object.hasOwn(props.mapping, header)) return SAME;
    return props.mapping[header] ?? IGNORE;
  };
  const choose = (header: string, value: string) => {
    const next = { ...props.mapping };
    if (value === SAME) delete next[header];
    else next[header] = value === IGNORE ? null : value;
    props.onChange(next);
  };
  // Two headers sent to one column: the server refuses it, so say it here.
  const targets = props.headers.map((header) => {
    const choice = choiceOf(header);
    return choice === SAME ? header : choice === IGNORE ? null : choice;
  });
  const twice = new Set(
    targets.filter(
      (target, index) => target !== null && targets.indexOf(target) !== index,
    ),
  );
  const items = saved.data?.items ?? [];

  return (
    <section aria-label={t('mapping.title')} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-2">
        {items.length > 0 && (
          <Field className="min-w-48 flex-1">
            <FieldLabel htmlFor="import-saved-mapping">
              {t('mapping.apply')}
            </FieldLabel>
            <Select
              items={items.map((item) => ({
                value: item.id,
                label: item.name,
              }))}
              value={null}
              onValueChange={(id) => {
                const found = items.find((item) => item.id === id);
                if (found) props.onChange({ ...found.mapping });
              }}
            >
              <SelectTrigger id="import-saved-mapping" className="w-full">
                <SelectValue placeholder={t('mapping.choose')} />
              </SelectTrigger>
              <SelectContent>
                {items.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        )}
        {items.map((item) => (
          <Button
            key={item.id}
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => remove.mutate(item.id)}
          >
            {t('mapping.delete', { name: item.name })}
          </Button>
        ))}
      </div>

      <div className="overflow-hidden rounded-md border">
        <Table aria-label={t('mapping.title')}>
          <TableHeader>
            <TableRow>
              <TableHead>{t('mapping.header')}</TableHead>
              <TableHead>{t('mapping.sample')}</TableHead>
              <TableHead>{t('mapping.column')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {props.headers.map((header, index) => {
              const choice = choiceOf(header);
              const target = targets[index];
              return (
                <TableRow key={`${header}-${index}`}>
                  <TableCell className="font-medium">{header}</TableCell>
                  <TableCell className="max-w-40 truncate text-muted-foreground">
                    {props.samples[index] ?? ''}
                  </TableCell>
                  <TableCell>
                    <Select
                      value={choice}
                      onValueChange={(value) => choose(header, value ?? SAME)}
                    >
                      <SelectTrigger
                        aria-label={t('mapping.columnOf', { header })}
                        className="w-full"
                        aria-invalid={target !== null && twice.has(target)}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={SAME}>
                          {props.columns.includes(header)
                            ? header
                            : t('mapping.asIs', { header })}
                        </SelectItem>
                        <SelectItem value={IGNORE}>
                          {t('mapping.ignore')}
                        </SelectItem>
                        {props.columns
                          .filter((column) => column !== header)
                          .map((column) => (
                            <SelectItem key={column} value={column}>
                              {column}
                            </SelectItem>
                          ))}
                      </SelectContent>
                    </Select>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
      {twice.size > 0 && (
        <p role="alert" className="text-sm text-destructive">
          {t('mapping.twice', { columns: [...twice].join(', ') })}
        </p>
      )}

      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim()) save.mutate();
        }}
      >
        <Field className="min-w-48 flex-1">
          <FieldLabel htmlFor="import-mapping-name">
            {t('mapping.name')}
          </FieldLabel>
          <Input
            id="import-mapping-name"
            value={name}
            maxLength={200}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <Button
          type="submit"
          variant="outline"
          disabled={!name.trim() || Object.keys(props.mapping).length === 0}
        >
          {t('mapping.save')}
        </Button>
      </form>
    </section>
  );
}

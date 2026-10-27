import {
  Alert,
  AlertDescription,
} from '@nestjs-monorepo-template/ui/components/alert';
import { Badge } from '@nestjs-monorepo-template/ui/components/badge';
import { Button } from '@nestjs-monorepo-template/ui/components/button';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@nestjs-monorepo-template/ui/components/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@nestjs-monorepo-template/ui/components/dialog';
import { Input } from '@nestjs-monorepo-template/ui/components/input';
import { Skeleton } from '@nestjs-monorepo-template/ui/components/skeleton';
import {
  Tabs,
  TabsList,
  TabsTrigger,
} from '@nestjs-monorepo-template/ui/components/tabs';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@nestjs-monorepo-template/ui/components/table';
import { useQuery } from '@tanstack/react-query';
import { InfoIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { OverrideEditor } from './override-editor';
import { SourceBadge } from './source-badge';
import { groupOf, matches, settingsQuery, type Setting } from './settings';
import { displayValue } from './value-input';

/**
 * Every setting and flag, grouped by key prefix, searchable, editable; the
 * "Feature flags" tab shows the flags alone, where their rollouts are set.
 */
export function AdminSettings() {
  const { t } = useTranslation('settings');
  const { data, isPending } = useQuery(settingsQuery);
  const [search, setSearch] = useState('');
  const [show, setShow] = useState<'all' | 'flags'>('all');
  const [editing, setEditing] = useState<string>();
  if (isPending) {
    return <Skeleton className="h-64 w-full" />;
  }
  const groups = new Map<string, Setting[]>();
  for (const setting of (data ?? []).filter(
    (s) => matches(s, search) && (show === 'all' || s.flag),
  )) {
    const group = groupOf(setting.key);
    groups.set(group, [...(groups.get(group) ?? []), setting]);
  }
  const current = data?.find(
    (setting) => setting.key === editing && setting.canEdit,
  );
  return (
    <div className="flex flex-col gap-6">
      <Tabs
        value={show}
        onValueChange={(next) => setShow(next === 'flags' ? 'flags' : 'all')}
      >
        <TabsList aria-label={t('show.label')}>
          <TabsTrigger value="all">{t('show.all')}</TabsTrigger>
          <TabsTrigger value="flags">{t('show.flags')}</TabsTrigger>
        </TabsList>
      </Tabs>
      {show === 'flags' && (
        <p className="text-sm text-muted-foreground">{t('show.flagsHint')}</p>
      )}
      <Input
        type="search"
        aria-label={t('search')}
        placeholder={t('search')}
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        className="max-w-sm"
      />
      {groups.size === 0 && (
        <p className="text-sm text-muted-foreground">{t('none')}</p>
      )}
      {[...groups].map(([group, settings]) => (
        <Card key={group}>
          <CardHeader>
            <CardTitle>
              {t(`groups.${group}`, { defaultValue: group })}
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('columns.setting')}</TableHead>
                  <TableHead>{t('columns.value')}</TableHead>
                  <TableHead>{t('columns.source')}</TableHead>
                  <TableHead>{t('columns.default')}</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {settings.map((setting) => (
                  <TableRow key={setting.key}>
                    <TableCell className="whitespace-normal">
                      <div className="font-medium">{setting.label}</div>
                      <code className="text-xs text-muted-foreground">
                        {setting.key}
                      </code>
                      {setting.flag && (
                        <Badge variant="outline" className="ms-2">
                          {t('flag')}
                        </Badge>
                      )}
                      {!setting.public && (
                        <Badge variant="outline" className="ms-2">
                          {t('managersOnly')}
                        </Badge>
                      )}
                      {setting.description && (
                        <p className="text-xs text-muted-foreground">
                          {setting.description}
                        </p>
                      )}
                    </TableCell>
                    <TableCell>
                      {displayValue(setting.key, setting.value, t)}
                    </TableCell>
                    <TableCell>
                      <SourceBadge source={setting.source} />
                      {setting.platform?.enforced && (
                        <Badge variant="outline" className="ms-2">
                          {t('platform.enforced')}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      {displayValue(setting.key, setting.default, t)}
                    </TableCell>
                    <TableCell>
                      {/* The API says who may set it (`canEdit`): never
                          guessed from `public` or the key. */}
                      {setting.canEdit ? (
                        <Button
                          variant="outline"
                          size="sm"
                          aria-label={t('editNamed', { label: setting.label })}
                          onClick={() => setEditing(setting.key)}
                        >
                          {t('edit')}
                        </Button>
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          {t('readOnly')}
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ))}
      <Dialog
        open={!!current}
        onOpenChange={(open) => !open && setEditing(undefined)}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          {current && (
            <>
              <DialogHeader>
                <DialogTitle>{current.label}</DialogTitle>
                <DialogDescription>
                  {current.description ?? current.key}
                </DialogDescription>
              </DialogHeader>
              {!current.public && (
                <Alert>
                  <InfoIcon />
                  <AlertDescription>{t('hiddenNote')}</AlertDescription>
                </Alert>
              )}
              <OverrideEditor setting={current} />
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

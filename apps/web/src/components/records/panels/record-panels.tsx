import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@nestjs-monorepo-template/ui/components/tabs';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useCan, type Permission } from '@/lib/features';
import { useRealtimeEvent } from '@/lib/realtime';
import type { Tag } from '@/lib/tags';
import { panelKeys } from './api';
import { AttachmentsPanel } from './attachments-panel';
import { CommentsPanel } from './comments-panel';
import { RevisionsPanel } from './revisions-panel';
import { TagsPanel } from './tags-panel';

/**
 * What the record's feature keeps (its `commentRoutes()`, `attachmentRoutes()`,
 * `tagRoutes()`, `revisionRoutes()`; docs/adding-a-feature.md). The API does
 * not publish this (backend finding: `GET /v1/lists/{subject}` could), so the
 * feature's page says it, from the `.record.ts` it generated.
 */
export type RecordCapabilities = {
  comments?: boolean;
  attachments?: boolean;
  tags?: boolean;
  revisions?: boolean;
};

/**
 * The panels of a record's detail page, each shown only when the feature
 * supports it and the user may read the record, and writable only with
 * `<Subject>.update` (the API checks the same):
 *
 *   <RecordPanels subject="Invoice" path="/v1/invoices/{id}" id={invoice.id}
 *     capabilities={{ comments: true, attachments: true, tags: true, revisions: true }}
 *     tags={invoice.tags} />
 *
 * `path` is the record's route with `{id}`; the panels' routes hang off it.
 * `tags` are the record's own (they come with it). `canUpdate` is the
 * record's own `can.update` (useRecordCan) when the page has it: the panels'
 * writes take the same check as the record's PATCH (its conditions), so a
 * record the user may not change shows its panels read-only. Left out, the
 * permission `<Subject>.update` decides. The record's queries
 * (`recordKeys`, list path = `path` without `/{id}`) are refreshed after a
 * tag change or a restore.
 */
export function RecordPanels(props: {
  subject: string;
  path: `${string}/{id}`;
  id: string;
  capabilities: RecordCapabilities;
  tags?: readonly Pick<Tag, 'id' | 'name' | 'color'>[];
  canUpdate?: boolean;
}) {
  const { t } = useTranslation('records');
  const queryClient = useQueryClient();
  const canRead = useCan(`${props.subject}.read` as Permission);
  const mayUpdate = useCan(`${props.subject}.update` as Permission);
  const canUpdate = props.canUpdate ?? mayUpdate;
  const { capabilities } = props;
  const listPath = props.path.replace(/\/\{id\}$/, '');

  // No event carries comments or attachments (backend finding): a
  // notification (mentions and watched records arrive as one) or an issued
  // document is the best hint that the panels are stale.
  const refresh = () =>
    void queryClient.invalidateQueries({
      queryKey: panelKeys.all(props.path, props.id),
    });
  useRealtimeEvent('notification', refresh);
  useRealtimeEvent('document.ready', (event) => {
    if (event.recordId === props.id) refresh();
  });

  if (!canRead) {
    return null;
  }
  const tabs = [
    capabilities.comments && 'comments',
    capabilities.attachments && 'attachments',
    capabilities.revisions && 'revisions',
  ].filter((tab): tab is 'comments' | 'attachments' | 'revisions' => !!tab);

  if (!capabilities.tags && tabs.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-6">
      {capabilities.tags && (
        <section aria-labelledby="record-tags" className="flex flex-col gap-2">
          <h2 id="record-tags" className="text-sm font-medium">
            {t('tags.title')}
          </h2>
          <TagsPanel
            subject={props.subject}
            listPath={listPath}
            base={props.path}
            id={props.id}
            tags={props.tags ?? []}
            canEdit={canUpdate}
          />
        </section>
      )}
      {tabs.length > 0 && (
        <Tabs defaultValue={tabs[0]}>
          <TabsList>
            {tabs.map((tab) => (
              <TabsTrigger key={tab} value={tab}>
                {t(`${tab}.title`)}
              </TabsTrigger>
            ))}
          </TabsList>
          {capabilities.comments && (
            <TabsContent value="comments" className="pt-4">
              <CommentsPanel
                base={props.path}
                id={props.id}
                canModerate={canUpdate}
              />
            </TabsContent>
          )}
          {capabilities.attachments && (
            <TabsContent value="attachments" className="pt-4">
              <AttachmentsPanel
                base={props.path}
                id={props.id}
                canWrite={canUpdate}
              />
            </TabsContent>
          )}
          {capabilities.revisions && (
            <TabsContent value="revisions" className="pt-4">
              <RevisionsPanel
                listPath={listPath}
                base={props.path}
                id={props.id}
                canRestore={canUpdate}
              />
            </TabsContent>
          )}
        </Tabs>
      )}
    </div>
  );
}

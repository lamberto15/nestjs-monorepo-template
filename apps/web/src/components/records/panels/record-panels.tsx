import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@nestjs-monorepo-template/ui/components/tabs';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useCan, type Permission } from '@/lib/features';
import { useListDescription } from '@/lib/list-query';
import { useRealtimeEvent } from '@/lib/realtime';
import type { Tag } from '@/lib/tags';
import { panelKeys } from './api';
import { AttachmentsPanel } from './attachments-panel';
import { CommentsPanel } from './comments-panel';
import { RevisionsPanel } from './revisions-panel';
import { TagsPanel } from './tags-panel';

/**
 * The panels of a record's detail page, each shown only when the subject
 * takes it (`capabilities` of `GET /v1/lists/{subject}`, from the feature's
 * `<item>.record.ts`) and the user may read the record, and writable only
 * with `<Subject>.update` (the API checks the same):
 *
 *   <RecordPanels subject="Invoice" path="/v1/invoices/{id}" id={invoice.id}
 *     tags={invoice.tags} canUpdate={can.update} />
 *
 * `path` is the record's route with `{id}`; the panels' routes hang off it.
 * `tags` are the record's own (they come with it). `canUpdate` is the
 * record's own `can.update` (useRecordCan) when the page has it: the panels'
 * writes take the same check as the record's PATCH (its conditions), so a
 * record the user may not change shows its panels read-only. Left out, the
 * permission `<Subject>.update` decides. The record's queries
 * (`recordKeys`, list path = `path` without `/{id}`) are refreshed after a
 * tag change or a restore. Uploads are held to the list's
 * `attachmentLimits`.
 *
 * The realtime events of the record (`record.commented`,
 * `record.attachments.changed`: docs/webhooks-and-realtime.md, "Record
 * events") reload its comments or attachments.
 */
export function RecordPanels(props: {
  subject: string;
  path: `${string}/{id}`;
  id: string;
  tags?: readonly Pick<Tag, 'id' | 'name' | 'color'>[];
  canUpdate?: boolean;
}) {
  const { t } = useTranslation('records');
  const queryClient = useQueryClient();
  const canRead = useCan(`${props.subject}.read` as Permission);
  const mayUpdate = useCan(`${props.subject}.update` as Permission);
  const canUpdate = props.canUpdate ?? mayUpdate;
  const description = useListDescription(props.subject, canRead).data;
  const listPath = props.path.replace(/\/\{id\}$/, '');

  const ours = (event: { subject: string; recordId: string }) =>
    event.subject === props.subject && event.recordId === props.id;
  useRealtimeEvent('record.commented', (event) => {
    if (ours(event)) {
      void queryClient.invalidateQueries({
        queryKey: panelKeys.comments(props.path, props.id),
      });
    }
  });
  useRealtimeEvent('record.attachments.changed', (event) => {
    if (ours(event)) {
      void queryClient.invalidateQueries({
        queryKey: panelKeys.attachments(props.path, props.id),
      });
    }
  });

  // Nothing until the subject says what it takes.
  if (!canRead || !description) {
    return null;
  }
  const { capabilities, attachmentLimits } = description;
  const tabs = [
    capabilities.comments && 'comments',
    capabilities.attachments && attachmentLimits && 'attachments',
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
          {capabilities.attachments && attachmentLimits && (
            <TabsContent value="attachments" className="pt-4">
              <AttachmentsPanel
                base={props.path}
                id={props.id}
                canWrite={canUpdate}
                limits={attachmentLimits}
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

import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@nestjs-monorepo-template/ui/components/tabs';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { EventsPanel } from './events-panel';
import { OutboxPanel } from './outbox-panel';
import { QueuesPanel } from './queues-panel';

const tabs = ['queues', 'outbox', 'events'] as const;
type Tab = (typeof tabs)[number];

/**
 * What runs in the background, for the deployment's operators: the job
 * queues, the outbox with its dead letters, and a live log of every
 * engine's events. Only the open tab is mounted, so the live stream (and
 * the polling of the other two) runs only while it is looked at.
 */
export function OpsPage() {
  const { t } = useTranslation('ops');
  const [tab, setTab] = useState<Tab>('queues');
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-medium">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('description')}</p>
      </div>
      <Tabs value={tab} onValueChange={(value) => setTab(value as Tab)}>
        <TabsList>
          {tabs.map((name) => (
            <TabsTrigger key={name} value={name}>
              {t(`tabs.${name}`)}
            </TabsTrigger>
          ))}
        </TabsList>
        {/* A panel of a tab left is unmounted (Base UI's default), so its
            stream closes and its polling stops. */}
        <TabsContent value="queues">
          <QueuesPanel />
        </TabsContent>
        <TabsContent value="outbox">
          <OutboxPanel />
        </TabsContent>
        <TabsContent value="events">
          <EventsPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}

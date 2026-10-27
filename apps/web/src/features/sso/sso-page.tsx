import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@nestjs-monorepo-template/ui/components/tabs';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Page, PageHeader } from '@/components/page-header';
import { ConnectionsSection } from './connections-section';
import { DomainsSection } from './domains-section';
import { PolicySection } from './policy-section';
import { ScimSection } from './scim-section';

const TABS = ['connections', 'domains', 'policy', 'scim'] as const;
type Tab = (typeof TABS)[number];

/**
 * Enterprise single sign-on (docs/auth.md, "Enterprise SSO"): the tenant's
 * identity-provider connections, the email domains it proves, and the SCIM
 * provisioning endpoint. Only the open tab is mounted.
 */
export function SsoPage() {
  const { t } = useTranslation('sso');
  const [tab, setTab] = useState<Tab>('connections');
  return (
    <Page>
      <PageHeader title={t('title')} description={t('description')} />
      <Tabs value={tab} onValueChange={(value) => setTab(value as Tab)}>
        <TabsList>
          {TABS.map((name) => (
            <TabsTrigger key={name} value={name}>
              {t(`tabs.${name}`)}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="connections" className="pt-4">
          {tab === 'connections' && <ConnectionsSection />}
        </TabsContent>
        <TabsContent value="domains" className="pt-4">
          {tab === 'domains' && <DomainsSection />}
        </TabsContent>
        <TabsContent value="policy" className="pt-4">
          {tab === 'policy' && <PolicySection />}
        </TabsContent>
        <TabsContent value="scim" className="pt-4">
          {tab === 'scim' && <ScimSection />}
        </TabsContent>
      </Tabs>
    </Page>
  );
}

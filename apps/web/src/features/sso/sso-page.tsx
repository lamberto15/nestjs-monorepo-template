import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@nestjs-monorepo-template/ui/components/tabs';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
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
    <div className="flex max-w-5xl flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-medium">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('description')}</p>
      </div>
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
    </div>
  );
}

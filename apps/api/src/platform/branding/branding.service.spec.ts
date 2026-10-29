import { AsyncLocalStorage } from 'node:async_hooks';
import type { ConfigService } from '@nestjs/config';
import type { TransactionHost } from '@nestjs-cls/transactional';
import { InMemoryDisk } from '@nestjs/storage';
import { ClsService, ClsServiceManager } from 'nestjs-cls';
import type { CoreEnv } from '../../core/config/core.env.js';
import type { DrizzleTransactions } from '../../core/database/transactions.js';
import { inTenantOf } from '../../core/tenancy/tenant-job.js';
import {
  NO_TENANT,
  TenantScopeMissingError,
} from '../../core/tenancy/tenant-scope.js';
import type { AuditService } from '../../iam/audit/audit.service.js';
import type { Principal } from '../../iam/auth/principal.js';
import type { SettingsService } from '../settings/settings.service.js';
import { BrandingService } from './branding.service.js';

const TENANT = '0199a000-0000-7000-8000-00000000000a';
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(32, 1),
]);

describe('BrandingService', () => {
  const key = BrandingService.logoKey(TENANT);
  let disk: InMemoryDisk;
  let service: BrandingService;

  beforeEach(() => {
    vi.spyOn(ClsServiceManager, 'getClsService').mockReturnValue(
      new ClsService(new AsyncLocalStorage()),
    );
    disk = new InMemoryDisk();
    const settings = {
      guardWrite: vi.fn(),
      get: vi.fn(async () => null),
      enabled: vi.fn(async () => false),
      canEdit: vi.fn(async () => true),
    } as unknown as SettingsService;
    // The public route's lookup of an active tenant: the select chain, answered.
    const txHost = {
      tx: {
        update: () => ({ set: () => ({ where: async () => [] }) }),
        select: () => ({
          from: () => ({ where: async () => [{ id: TENANT, logoKey: key }] }),
        }),
      },
    } as unknown as TransactionHost<DrizzleTransactions>;
    service = new BrandingService(
      settings,
      disk,
      {} as unknown as AuditService,
      {
        get: () => 'https://app.example.com',
      } as unknown as ConfigService<CoreEnv, true>,
      txHost,
    );
  });
  afterEach(() => vi.restoreAllMocks());

  const principal = { id: 'u1', kind: 'user' } as unknown as Principal;
  const inTenant = <T>(work: () => Promise<T>) =>
    inTenantOf({ tenantId: TENANT }, work);

  it('shows a caller with no tenant the defaults, not an error', async () => {
    expect(
      await inTenantOf({ tenantId: null }, () => service.view(principal)),
    ).toEqual({
      primaryColor: null,
      darkPrimaryColor: null,
      mailFromName: null,
      logoUrl: null,
      darkLogoUrl: null,
      locked: false,
      canEdit: false,
    });
    // Outside any context too (no scope at all).
    expect((await service.view(principal)).logoUrl).toBeNull();
  });

  it('refuses a write with no tenant as tenant_required (a TenantScopeMissingError), not a plain error', async () => {
    await expect(
      inTenantOf({ tenantId: null }, () => service.removeLogo(principal)),
    ).rejects.toThrow(TenantScopeMissingError);
    expect(NO_TENANT.tenantId).toBeNull();
  });

  describe('a logo another instance removed (this one still has it cached)', () => {
    /** Caches "has a logo", then removes the file behind this instance's back. */
    async function cachedThenRemoved() {
      await disk.put(key, PNG, { contentType: 'image/png' });
      expect(await inTenant(() => service.current())).toMatchObject({
        logoUrl: `https://app.example.com/v1/branding/${TENANT}/logo`,
      });
      await disk.delete(key);
    }

    it('renders a document without the logo instead of failing the job', async () => {
      await cachedThenRemoved();
      expect(await inTenant(() => service.forDocument())).toMatchObject({
        logo: null,
      });
      // The stale entry is gone: the next ask goes to the disk.
      expect((await inTenant(() => service.current()))?.logoUrl).toBeNull();
    });

    it('answers the public route with no logo (404), not a storage error', async () => {
      await cachedThenRemoved();
      expect(await service.logoFile(TENANT)).toBeNull();
      expect((await inTenant(() => service.current()))?.logoUrl).toBeNull();
    });

    it('treats a file that vanishes between the check and the read as no logo', async () => {
      // `exists()` saw the file, which is gone by the time `stat()` asks.
      vi.spyOn(disk, 'exists').mockResolvedValueOnce(true);
      expect((await inTenant(() => service.current()))?.logoUrl).toBeNull();
    });
  });

  it('still serves the logo it has', async () => {
    await disk.put(key, PNG, { contentType: 'image/png' });
    expect(await inTenant(() => service.forDocument())).toMatchObject({
      logo: expect.stringMatching(/^data:image\/png;base64,/),
    });
    expect(await service.logoFile(TENANT)).toMatchObject({
      contentType: 'image/png',
      size: PNG.length,
    });
  });

  it('keeps the dark-mode logo apart from the logo', async () => {
    const darkKey = BrandingService.logoKey(TENANT, 'current', 'dark');
    await disk.put(darkKey, PNG, { contentType: 'image/png' });
    expect(await service.logoFile(TENANT)).toBeNull();
    expect(await service.logoFile(TENANT, 'dark')).toMatchObject({
      contentType: 'image/png',
      size: PNG.length,
    });
    expect((await inTenant(() => service.view(principal))).darkLogoUrl).toBe(
      `/v1/branding/${TENANT}/logo/dark`,
    );
    // Mail and documents show the logo only.
    expect((await inTenant(() => service.current()))?.logoUrl).toBeNull();
  });
});

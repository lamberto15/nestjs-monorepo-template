import { randomBytes } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { getDrizzleToken } from '@nestjs/drizzle';
import {
  InMemoryDisk,
  LocalDisk,
  S3Disk,
  type StorageDisk,
  StorageModule,
} from '@nestjs/storage';
import {
  awsCredentials,
  type Config,
  type CoreEnv,
} from '../../core/config/core.env.js';
import {
  loadOrCreateSecret,
  type Database,
} from '../../core/database/drizzle.js';
import type { PlatformEnv } from '../platform.env.js';

/** The route that serves the local disk's signed URLs (FilesController). */
export const FILES_ROUTE = 'files';

/**
 * @nestjs/storage, global: one private disk, `files`, injected as
 * `StorageDisk`. Nothing on it is public: clients get short-lived signed URLs
 * (`disk.signedUrl(key)`, `disk.signedUpload(key, …)`). Locally the app serves
 * them at /files; on S3 they point at the bucket. Add disks here (a public
 * one behind a CDN, say) and inject them with `@InjectDisk('name')`.
 */
export const storage = () =>
  StorageModule.forRootAsync({
    inject: [ConfigService, getDrizzleToken()],
    useFactory: async (config: Config<CoreEnv & PlatformEnv>, db: Database) => {
      const keys = (
        await loadOrCreateSecret(db, 'STORAGE_SIGNING_KEYS', () =>
          randomBytes(32).toString('base64url'),
        )
      )
        .split(',')
        .map((key) => key.trim());
      const signedUrls = {
        baseUrl: `${config.get('APP_URL', { infer: true })}/${FILES_ROUTE}`,
        keys,
      };
      let files: StorageDisk;
      switch (config.get('STORAGE_DRIVER', { infer: true })) {
        case 's3': {
          const bucket = config.get('S3_BUCKET', { infer: true });
          if (!bucket) {
            throw new Error('S3_BUCKET is required with STORAGE_DRIVER=s3');
          }
          files = new S3Disk({
            bucket,
            region:
              config.get('S3_REGION', { infer: true }) ??
              config.get('AWS_REGION', { infer: true }),
            credentials: awsCredentials(config),
            endpoint: config.get('S3_ENDPOINT', { infer: true }),
            forcePathStyle: config.get('S3_FORCE_PATH_STYLE', { infer: true }),
            // Objects encrypted at rest by the store.
            serverSideEncryption: 'AES256',
            timeout: '60s',
          });
          break;
        }
        case 'memory':
          files = new InMemoryDisk({ signedUrls });
          break;
        default:
          files = new LocalDisk({
            root: config.get('STORAGE_ROOT', { infer: true }),
            signedUrls,
          });
      }
      return { default: 'files', disks: { files } };
    },
  });

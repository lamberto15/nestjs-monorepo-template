import { S3Disk } from '@nestjs/storage';
import { describe, expect, it } from 'vitest';
import { presignedUploads } from './attachment-limits.js';
import {
  detectUploadedType,
  directUploadType,
  isAllowedType,
} from './attachment-types.js';
import { UPLOAD_LINK_TTL } from './attachment-uploads.service.js';

describe('directUploadType', () => {
  it('signs for the type a browser declares, in the form we keep', () => {
    expect(directUploadType('image/png')).toBe('image/png');
    expect(directUploadType('Application/PDF')).toBe('application/pdf');
    expect(directUploadType('image/jpg')).toBe('image/jpeg');
    expect(directUploadType('image/pjpeg')).toBe('image/jpeg');
    expect(directUploadType('application/x-zip-compressed')).toBe(
      'application/zip',
    );
  });

  it('types text as the upload through the API does: plain, or CSV, with the charset', () => {
    expect(directUploadType('text/plain')).toBe('text/plain; charset=utf-8');
    expect(directUploadType('text/markdown')).toBe('text/plain; charset=utf-8');
    expect(directUploadType('text/html')).toBe('text/plain; charset=utf-8');
    expect(directUploadType('text/csv; charset=latin1')).toBe(
      'text/csv; charset=utf-8',
    );
  });

  it('has none for a client that declares nothing: the store would serve whatever it was told', () => {
    expect(directUploadType('')).toBeUndefined();
    expect(directUploadType('  ')).toBeUndefined();
    expect(directUploadType('application/octet-stream')).toBeUndefined();
  });

  it('passes nothing but a type from the allowed list on to the signer once checked', () => {
    // A header-splitting value is not one of the allowed types, so it never reaches the signature.
    const declared = directUploadType('image/png\r\nx-amz-acl: public-read')!;
    expect(isAllowedType(declared, ['image/png'])).toBe(false);
  });
});

describe('isAllowedType', () => {
  it('compares the type, not its parameters or its case', () => {
    const allowed = ['image/png', 'text/plain', 'text/csv'];
    expect(isAllowedType('text/plain; charset=utf-8', allowed)).toBe(true);
    expect(isAllowedType('IMAGE/PNG', allowed)).toBe(true);
    expect(isAllowedType('image/gif', allowed)).toBe(false);
    expect(isAllowedType('', allowed)).toBe(false);
  });
});

describe('detectUploadedType', () => {
  it('decides as the upload through the API does: signatures first, then text and zip', () => {
    expect(
      detectUploadedType(Buffer.from('%PDF-1.7\n'), 'application/pdf'),
    ).toBe('application/pdf');
    expect(detectUploadedType(Buffer.from('a,b\n1,2\n'), 'text/csv')).toBe(
      'text/csv; charset=utf-8',
    );
    expect(detectUploadedType(Buffer.from('a,b\n1,2\n'), 'text/plain')).toBe(
      'text/plain; charset=utf-8',
    );
    expect(detectUploadedType(Buffer.from([0, 1, 2, 3]), 'image/png')).toBe(
      undefined,
    );
  });
});

describe('presignedUploads', () => {
  it('is offered with the S3 driver only', () => {
    expect(presignedUploads('s3')).toBe(true);
    expect(presignedUploads('local')).toBe(false);
    expect(presignedUploads('memory')).toBe(false);
  });
});

describe('the URL an S3 disk signs for a direct upload', () => {
  it('is bound to the key, the size, the type and the encryption header, and expires in ten minutes', async () => {
    const disk = new S3Disk({
      bucket: 'bucket',
      region: 'eu-west-1',
      credentials: { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret' },
      serverSideEncryption: 'AES256',
    });
    const signed = await disk.signedUpload('tenants/t/attachments/u', {
      contentType: 'image/png',
      contentLength: 1234,
      expiresIn: UPLOAD_LINK_TTL,
    });
    const url = new URL(signed.url);
    expect(signed.method).toBe('PUT');
    expect(url.pathname).toBe('/tenants/t/attachments/u');
    expect(url.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('600');
    // What is signed is what S3 then requires of the PUT: a body of another
    // length, another Content-Type or no encryption header is refused (403).
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe(
      'content-length;content-type;host;x-amz-server-side-encryption',
    );
    expect(signed.headers).toMatchObject({
      'content-type': 'image/png',
      'content-length': '1234',
      'x-amz-server-side-encryption': 'AES256',
    });
    expect(signed.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(
      10 * 60 * 1000,
    );
    expect(signed.expiresAt.getTime() - Date.now()).toBeGreaterThan(
      9 * 60 * 1000,
    );
  });
});

import { ApiError, parseProblem } from '@nestjs-monorepo-template/api-client';
import { i18n } from '@/i18n';

/**
 * Sends a multipart form (POST, or PUT) with upload progress. Custom code, not `api.POST`:
 * fetch reports no upload progress, and the attachments' dropzone and the
 * import (files up to 50 MB) show one. So this is an XMLHttpRequest with the
 * client's conventions: the cookie, the UI language, a problem as ApiError.
 */
export function postMultipart<T>(
  url: string,
  form: FormData,
  onProgress: (percent: number) => void,
  method: 'POST' | 'PUT' = 'POST',
): Promise<T> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open(method, url);
    request.withCredentials = true;
    request.setRequestHeader('accept', 'application/json');
    request.setRequestHeader('accept-language', i18n.language);
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    };
    request.onerror = () => reject(new Error(i18n.t('auth.errors.network')));
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) {
        resolve(JSON.parse(request.responseText) as T);
        return;
      }
      reject(
        new ApiError(
          parseProblem(
            request.status,
            request.responseText,
            request.getResponseHeader('x-request-id') ?? undefined,
          ),
        ),
      );
    };
    request.send(form);
  });
}

/**
 * The browser got no answer from the object store: a bucket with no CORS rule
 * for this origin (docs/attachments.md, "Direct uploads"), a blocked host, or
 * no network. A caller that can upload another way does (through the API).
 */
export class StoreUnreachableError extends Error {
  override readonly name = 'StoreUnreachableError';
  constructor() {
    super('The object store could not be reached from this browser.');
  }
}

/**
 * The object store answered a direct upload with a refusal: the link expired,
 * or the size or type is not the one signed. The store's answer is XML, not a
 * problem; the dropzone tells the user in its own words (`attachments.storageFailed`).
 */
export class StoreRefusedError extends Error {
  override readonly name = 'StoreRefusedError';
  constructor() {
    super('The object store refused the upload.');
  }
}

/**
 * PUTs a file to the signed URL of a direct upload, with progress. Custom
 * code, as `postMultipart` is, for the same reason (fetch reports no upload
 * progress). The URL is the credential and the store is another origin: no
 * cookie, no language header, and the signed headers go as they are
 * (`Content-Length` is the browser's to set). The store answers in XML, not
 * as a problem, so a refusal is a StoreRefusedError.
 */
export function putFile(
  url: string,
  headers: Record<string, string>,
  file: Blob,
  onProgress: (percent: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('PUT', url);
    for (const [name, value] of Object.entries(headers)) {
      if (name.toLowerCase() !== 'content-length') {
        request.setRequestHeader(name, value);
      }
    }
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    };
    request.onerror = () => reject(new StoreUnreachableError());
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) {
        resolve();
        return;
      }
      reject(new StoreRefusedError());
    };
    request.send(file);
  });
}

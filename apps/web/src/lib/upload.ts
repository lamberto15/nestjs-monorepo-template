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

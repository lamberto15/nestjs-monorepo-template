import type { ProxyOptions } from 'vite';

/**
 * What the dev server (`server.proxy`) and `vite preview` (`preview.proxy`)
 * send to the API, so the browser has one origin, as behind Caddy in
 * production (`@api` in caddy/Caddyfile). `api` is the API's address. Vite
 * matches a key as a string prefix of the URL, looser than Caddy's whole
 * segments: a path that works here can still miss `@api` (docs/pitfalls.md,
 * "Every download behind Caddy").
 */
export function devProxy(api: string) {
  return {
    // `autoRewrite`: an attachment's download (and a thumbnail or preview of
    // an image: `?rendition=`) answers 302 to a signed link on the API's own
    // URL (`APP_URL`, http://localhost:3000 by default), another origin than
    // this page. An `<img>` can't load that: the API's
    // `Cross-Origin-Resource-Policy: same-origin` refuses it. The proxy
    // rewrites such a redirect's host to the page's, and `/files` below
    // sends it on (docs/attachments.md, "Image renditions").
    '/v1': { target: api, autoRewrite: true },
    '/health': api,
    // The local disk's signed links (`STORAGE_DRIVER=local`). With S3 the
    // redirect leaves for the bucket, and nothing here changes it.
    '/files': api,
    '/socket.io': { target: api, ws: true },
  } satisfies Record<string, string | ProxyOptions>;
}

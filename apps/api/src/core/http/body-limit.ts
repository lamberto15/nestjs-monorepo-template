/**
 * How large a request body may be, and what that leaves a text field.
 *
 * A JSON body over `JSON_BODY_LIMIT` is refused before validation with 413
 * `payload_too_large` (body-parser; the problem-details filter names it).
 * The limit is a byte count clients can't see in the OpenAPI document, so
 * each text field carries its own `maxLength` under it: a field of
 * `MAX_TEXT_LENGTH` characters fits the limit in any script (UTF-8 takes at
 * most 3 bytes per UTF-16 unit: 90 000 bytes), with room for the rest of
 * the body. `field.string()` and `field.text()` (platform/fields) refuse a
 * larger `max` when the declaration loads.
 */

/** The JSON body limit in bytes (body-parser's default, 100 KB, set explicitly in http-setup.ts). */
export const JSON_BODY_LIMIT = 100 * 1024;

/** The longest a text field of a body may be declared, in characters. */
export const MAX_TEXT_LENGTH = 30_000;

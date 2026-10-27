import openapi from '@nestjs-monorepo-template/api-client/openapi.json';

/** What the API's schema states of a text property. */
export type TextLimits = { minLength?: number; maxLength?: number };

type Schema = {
  $ref?: string;
  properties?: Record<string, TextLimits>;
};

const document = openapi as unknown as {
  paths: Record<
    string,
    Record<
      string,
      { requestBody?: { content: Record<string, { schema: Schema }> } }
    >
  >;
  components?: { schemas?: Record<string, Schema> };
};

/**
 * Whether the API has this route. CI's template-without-notes job removes the
 * notes' (`pnpm feature:remove notes`): a test of one skips when it is gone.
 */
export const hasRoute = (path: string) => path in document.paths;

/**
 * The properties of a route's JSON request body, with the limits the schema
 * states (a `$ref` body is looked up in `components.schemas`). The test reads
 * the typed client's document; the app does not (it would put the whole 1 MB
 * file into the bundle), which is why the forms hold their limits as constants.
 */
export function requestProperties(
  path: string,
  method: string,
): Record<string, TextLimits> {
  const body =
    document.paths[path]?.[method]?.requestBody?.content['application/json']
      ?.schema;
  const schema = body?.$ref
    ? document.components?.schemas?.[body.$ref.split('/').pop()!]
    : body;
  if (!schema?.properties) {
    throw new Error(`${method} ${path} has no JSON request properties`);
  }
  return schema.properties;
}

import type { OpenAPIObject } from '@nestjs/swagger';
import type { z } from 'zod';
import { attachmentPageSchema } from '../attachments/attachment.schemas.js';
import { commentPageSchema } from '../comments/comment.schemas.js';
import {
  revisionDiffSchema,
  revisionPageSchema,
} from '../revisions/revision.schemas.js';
import { tagPageSchema, tagRefListSchema } from '../tags/tag.schemas.js';

/**
 * The shapes every record's panel routes share (`…/{id}/comments`,
 * `/attachments`, `/tags`, `/revisions`), as the roots of the named OpenAPI
 * components `Comment`, `CommentPage`, `Attachment`, `AttachmentPage`,
 * `Tag`, `TagPage`, `TagRef`, `TagRefList`, `Revision`, `RevisionPage` and
 * `RevisionDiff`. Each schema names itself with Zod's `.meta({ id })`; the
 * routes' `standardSchema` makes @nestjs/swagger move the `$defs` of its
 * conversion into `components.schemas`, so every panel route points at the
 * same component (`$ref`), and the generated client has
 * `components['schemas']['Comment']` and the like.
 */
export const PANEL_COMPONENT_SCHEMAS: readonly z.ZodType[] = [
  commentPageSchema,
  attachmentPageSchema,
  revisionPageSchema,
  revisionDiffSchema,
  tagPageSchema,
  tagRefListSchema,
];

/**
 * Makes sure the document has the panels' components even when no feature
 * has a panel route (the last one removed by `pnpm feature:remove`, or an
 * app built with no features): @nestjs/swagger only emits a component some
 * route uses, and has no way to declare one without a route (`extraModels`
 * takes classes, not Zod schemas). So custom code: the same conversion
 * @nestjs/swagger applies to a route's `standardSchema` (Standard JSON
 * Schema, `openapi-3.0`, output), its definitions added under their ids. A
 * component a route already emitted is left alone, so the two cannot
 * differ (test/openapi.e2e-spec.ts compares them).
 */
export function addPanelComponents(document: OpenAPIObject): void {
  const schemas = (document.components ??= {}).schemas ?? {};
  document.components.schemas = schemas;
  for (const schema of PANEL_COMPONENT_SCHEMAS) {
    const converted = schema['~standard'].jsonSchema.output({
      target: 'openapi-3.0',
    }) as { definitions?: Record<string, object> };
    // `definitions`: what Zod names them for this target (`$defs` for 2020-12).
    for (const [id, definition] of Object.entries(
      converted.definitions ?? {},
    )) {
      schemas[id] ??= JSON.parse(
        JSON.stringify(definition).replaceAll(
          '"#/definitions/',
          '"#/components/schemas/',
        ),
      ) as (typeof schemas)[string];
    }
  }
}

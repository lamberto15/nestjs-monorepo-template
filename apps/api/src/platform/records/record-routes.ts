import { applyDecorators, Controller, type Type } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCookieAuth,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

/**
 * A feature's records, as their routes name them: what a feature declares
 * once (`features/<x>/<x>.routes.ts`) for the record-level routes the
 * platform builds for it (`recordRoutes()`, and each module's factory:
 * `tagRoutes()`, `commentRoutes()`, …). Static, read when the module file
 * loads: the OpenAPI dump (`preview: true`) instantiates nothing, so the
 * routes can't come from the runtime registries the targets fill.
 */
export interface RecordRouteSpec {
  /** The permission subject, and RecordRef's: `Note`. */
  subject: string;
  /** The collection's path under /v1: `notes`. */
  path: string;
  /** The Swagger tag of the feature's routes: `notes`. */
  apiTag: string;
  /** Names the controllers (`NoteTagsController`): their operationIds. */
  className: string;
  /** The record in prose: `note`. */
  noun: string;
  /** With its article: `a note` (default: "a"/"an" by the first letter). */
  aNoun?: string;
  /**
   * The operationId prefix of the routes that lived in the feature's own
   * controller (bulk, watch): `NotesController` keeps theirs. Default
   * `${className}sController`.
   */
  operationIdPrefix?: string;
}

/** A route's text, when the feature's says more than the generic one. */
export interface RouteDocs {
  summary?: string;
  description?: string;
}

/** `a note`, `an invoice`. */
export const aNounOf = (spec: RecordRouteSpec) =>
  spec.aNoun ?? `${/^[aeiou]/i.test(spec.noun) ? 'an' : 'a'} ${spec.noun}`;

/**
 * An operationId as the default factory makes it (`<Class>_<method>_v1`,
 * `_v1` from the app's `defaultVersion`), for a route that keeps the one
 * it had in the feature's own controller.
 */
export const operationIdOf = (spec: RecordRouteSpec, method: string) =>
  `${spec.operationIdPrefix ?? `${spec.className}sController`}_${method}_v1`;

/**
 * The class decorators of every record controller. `applyDecorators()`
 * applies them in this order, stacked decorators bottom-up: listed in
 * reverse of how a hand-written controller stacks them, so the security
 * schemes keep their order in the OpenAPI document.
 */
export const RecordController = (spec: RecordRouteSpec, path: string) =>
  applyDecorators(
    Controller(path),
    ApiUnauthorizedResponse({ description: 'No valid API key or session.' }),
    ApiCookieAuth('user-session'),
    ApiBearerAuth('api-key'),
    ApiTags(spec.apiTag),
  );

const names = new Set<string>();

/**
 * Names a factory-built controller (`NoteTagsController`). Not `mixin()`
 * (@nestjs/common), whose random class name would change every operationId
 * (`<Class>_<method>_v1`, @nestjs/swagger's default factory): Nest itself
 * keys controllers by class, so the name is the operationIds' and the
 * logs'. Two features with one `className` would share operationIds:
 * refused when the module file loads.
 */
export function namedController<T extends Type>(cls: T, name: string): T {
  if (names.has(name)) {
    throw new Error(
      `Two record controllers named ${name}: give each feature's RecordRouteSpec its own className.`,
    );
  }
  names.add(name);
  Object.defineProperty(cls, 'name', { value: name });
  return cls;
}

import { Injectable, type Type } from '@nestjs/common';
import type { z } from 'zod';

/** The subject's create schema, as `POST /v1/<path>` validates a body. */
export interface TemplateSource {
  readonly subject: string;
  readonly create: z.ZodObject;
  /** Whether its records take custom fields (`custom` in the body). */
  readonly custom: boolean;
}

/**
 * The subjects that take record templates, with their create schemas:
 * generated records register theirs through `recordParts()`
 * (platform/records), as they register their list (ListsRegistry).
 */
@Injectable()
export class TemplatesRegistry {
  private readonly sources = new Map<string, TemplateSource>();

  register(source: TemplateSource) {
    if (this.sources.has(source.subject)) {
      throw new Error(`Two templates are registered for "${source.subject}".`);
    }
    this.sources.set(source.subject, source);
  }

  get(subject: string) {
    return this.sources.get(subject);
  }

  subjects() {
    return [...this.sources.keys()];
  }
}

/** A provider that registers a subject's create schema for templates (recordParts). */
export function templateSource(source: TemplateSource): Type {
  @Injectable()
  class RegisteredTemplates {
    constructor(registry: TemplatesRegistry) {
      registry.register(source);
    }
  }
  Object.defineProperty(RegisteredTemplates, 'name', {
    value: `${source.subject}TemplateSource`,
  });
  return RegisteredTemplates;
}

import { Injectable } from '@nestjs/common';
import { PermissionCatalog } from '../../iam/access/permission-catalog.js';
import type { SubjectNames } from '../../iam/access/permissions.js';
import type { Principal } from '../../iam/auth/principal.js';
import { type SearchHit, SearchRegistry } from './search.registry.js';

/** A hit as GET /v1/search answers it: with its subject's names, translated. */
export interface LabelledHit extends SearchHit {
  subjectLabel: SubjectNames;
}

/**
 * The global search: every registered source (or one subject's) asked at
 * once, best matches first across them, each hit with how its subject is
 * named in the request's language (`PermissionCatalog.subjectNames()`,
 * the access catalog's texts in `permissions.json`), so clients don't
 * translate subject names themselves.
 */
@Injectable()
export class SearchService {
  constructor(
    private readonly registry: SearchRegistry,
    private readonly catalog: PermissionCatalog,
  ) {}

  async search(
    principal: Principal,
    q: string,
    { subject, limit }: { subject?: string; limit: number },
  ): Promise<LabelledHit[]> {
    const sources = subject
      ? [this.registry.get(subject)].filter((s) => s !== undefined)
      : this.registry.all();
    const hits = (
      await Promise.all(
        sources.map((source) => source.search(principal, q, limit)),
      )
    ).flat();
    hits.sort((a, b) => b.score - a.score);
    const names = new Map<string, SubjectNames>();
    return hits.slice(0, limit).map((hit) => {
      let subjectLabel = names.get(hit.subject);
      if (!subjectLabel) {
        subjectLabel = this.catalog.subjectNames(hit.subject);
        names.set(hit.subject, subjectLabel);
      }
      return { ...hit, subjectLabel };
    });
  }
}

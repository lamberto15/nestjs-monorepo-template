import { Injectable } from '@nestjs/common';
import { DATE_PARTS, type DateValues } from './naming-pattern.js';

/** What a variable is resolved for: one record's number, at its date. */
export interface NamingContext {
  /** The record's subject: `Note`. */
  readonly subject: string;
  /** The moment its date parts are taken at: now, or its date field's. */
  readonly at: Date;
  readonly date: DateValues;
  /** The create body's values, as the API takes them. */
  readonly values: Readonly<Record<string, unknown>>;
}

/**
 * A value every pattern may print (`.FY.` or `{FY}`), as Frappe's
 * `naming_series_variables` hook adds them: the platform's are FY and ABBR
 * (naming-series.service.ts); a feature declares its own from a
 * constructor with `namingSeries.declareVariable()`.
 */
export interface NamingVariable {
  /** Upper case, as patterns write it: `REGION`. */
  readonly name: string;
  /** What it prints, for the admin page: "The fiscal year: 2026-2027". */
  readonly description: string;
  /** What it prints for a record; refused with a 400 when it prints nothing. */
  readonly resolve: (context: NamingContext) => string | Promise<string>;
}

const NAME = /^[A-Z][A-Z0-9_]*$/;

@Injectable()
export class NamingVariables {
  private readonly variables = new Map<string, NamingVariable>();

  declare(variable: NamingVariable) {
    if (!NAME.test(variable.name)) {
      throw new Error(
        `Naming variable "${variable.name}": upper-case letters, digits and "_", a letter first.`,
      );
    }
    if ((DATE_PARTS as readonly string[]).includes(variable.name)) {
      throw new Error(
        `Naming variable "${variable.name}" is a date part already.`,
      );
    }
    const known = this.variables.get(variable.name);
    // The same declaration again is harmless (a provider made twice); two are a mistake.
    if (known && known.description !== variable.description) {
      throw new Error(`Two naming variables are "${variable.name}".`);
    }
    this.variables.set(variable.name, variable);
  }

  find(name: string): NamingVariable | undefined {
    return this.variables.get(name);
  }

  all() {
    return [...this.variables.values()];
  }

  names(): ReadonlySet<string> {
    return new Set(this.variables.keys());
  }
}

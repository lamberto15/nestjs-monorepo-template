/** Column types DuckDB reports (`DESCRIBE`/`SUMMARIZE`) that a chart can measure. */
// Anchored at both ends: a LIST (`INTEGER[]`) or STRUCT of numbers is not a number.
const NUMERIC =
  /^(?:U?TINYINT|U?SMALLINT|U?INTEGER|U?BIGINT|HUGEINT|FLOAT|DOUBLE|DECIMAL(?:\(\d+,\s*\d+\))?)$/i;
const TEMPORAL = /^(?:DATE|TIMESTAMP(?:_[A-Z]+)?|TIMESTAMP WITH TIME ZONE)$/i;

export const isNumericColumn = (type: string) => NUMERIC.test(type.trim());

/** A date or timestamp: what `date_trunc` buckets (see `timeSeries` in query.ts). */
export const isTemporalColumn = (type: string) => TEMPORAL.test(type.trim());

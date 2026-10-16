/** Test-only: ECB documents for the money module's unit and e2e tests. */

/** An ECB eurofxref document with these days (newest first, as the ECB writes them). */
export function ecbDocument(days: Record<string, Record<string, string>>) {
  const cubes = Object.entries(days)
    .map(
      ([day, rates]) =>
        `\t\t<Cube time='${day}'>\n${Object.entries(rates)
          .map(
            ([code, rate]) => `\t\t\t<Cube currency='${code}' rate='${rate}'/>`,
          )
          .join('\n')}\n\t\t</Cube>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">
\t<gesmes:subject>Reference rates</gesmes:subject>
\t<gesmes:Sender>
\t\t<gesmes:name>European Central Bank</gesmes:name>
\t</gesmes:Sender>
\t<Cube>
${cubes}
\t</Cube>
</gesmes:Envelope>`;
}

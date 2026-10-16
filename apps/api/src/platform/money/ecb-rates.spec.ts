import { ecbDocument } from './ecb-document.testing.js';
import { EcbFormatError, parseEcbRates } from './ecb-rates.js';

describe('parseEcbRates', () => {
  it('reads the daily document', () => {
    const xml = ecbDocument({
      '2026-10-15': { USD: '1.1652', JPY: '175.32', GBP: '0.86890' },
    });
    expect(parseEcbRates(xml)).toEqual([
      {
        day: '2026-10-15',
        rates: { USD: '1.1652', JPY: '175.32', GBP: '0.86890' },
      },
    ]);
  });

  it('reads every day of the history, each with its own rates', () => {
    const xml = ecbDocument({
      '2026-10-15': { USD: '1.1652' },
      '2026-10-14': { USD: '1.1601', JPY: '174.9' },
    });
    expect(parseEcbRates(xml)).toEqual([
      { day: '2026-10-15', rates: { USD: '1.1652' } },
      { day: '2026-10-14', rates: { USD: '1.1601', JPY: '174.9' } },
    ]);
  });

  it('reads double quotes too, and skips codes it doesn’t know', () => {
    const xml = ecbDocument({
      '2026-10-15': { USD: '1.1652', HRK: '7.5' },
    }).replaceAll("'", '"');
    expect(parseEcbRates(xml)).toEqual([
      { day: '2026-10-15', rates: { USD: '1.1652' } },
    ]);
  });

  it('refuses anything else whole', () => {
    expect(() => parseEcbRates('<html>Service unavailable</html>')).toThrow(
      EcbFormatError,
    );
    expect(() => parseEcbRates(ecbDocument({}))).toThrow(EcbFormatError);
    expect(() => parseEcbRates(ecbDocument({ '2026-10-15': {} }))).toThrow(
      EcbFormatError,
    );
    for (const rate of ['0', '-1.2', '1,2', '1e3', 'N/A', '0.0000']) {
      expect(
        () => parseEcbRates(ecbDocument({ '2026-10-15': { USD: rate } })),
        rate,
      ).toThrow(EcbFormatError);
    }
    expect(() =>
      parseEcbRates(ecbDocument({ '2026-13-45': { USD: '1.1' } })),
    ).toThrow(EcbFormatError);
  });

  it('refuses impossible and repeated days, a currency twice, and elements in any other form', () => {
    for (const day of ['2026-02-30', '2026-04-31', '2025-02-29']) {
      expect(
        () => parseEcbRates(ecbDocument({ [day]: { USD: '1.1' } })),
        day,
      ).toThrow(EcbFormatError);
    }
    const one = ecbDocument({ '2026-10-15': { USD: '1.1652' } });
    // The same day twice (the upsert would fail on it).
    const twice = one.replace(
      "<Cube time='2026-10-15'>",
      "<Cube time='2026-10-15'><Cube currency='GBP' rate='0.86'/></Cube><Cube time='2026-10-15'>",
    );
    expect(() => parseEcbRates(twice)).toThrow(/appears twice/);
    expect(() =>
      parseEcbRates(
        one.replace(
          "<Cube currency='USD' rate='1.1652'/>",
          "<Cube currency='USD' rate='1.1652'/><Cube currency='USD' rate='1.2'/>",
        ),
      ),
    ).toThrow(/USD appears twice/);
    for (const element of [
      "<Cube rate='1.1652' currency='USD'/>",
      "<Cube currency='USD' rate='1.1652' extra='x'/>",
      "<Cube currency='USD' rate='1.1652'></Cube>",
    ]) {
      const xml = one.replace(
        "<Cube currency='USD' rate='1.1652'/>",
        `<Cube currency='JPY' rate='175.32'/>${element}`,
      );
      expect(() => parseEcbRates(xml), element).toThrow(/unexpected form/);
    }
    expect(() =>
      parseEcbRates(
        one.replace(
          "<Cube time='2026-10-15'>",
          '<Cube time="2026-10-15" x="1">',
        ),
      ),
    ).toThrow(EcbFormatError);
  });
});

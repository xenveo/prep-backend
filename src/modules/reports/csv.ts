// CSV writing for admin exports (FR-REP-04), byte-compatible with the admin UI's `toCsv`:
// CRLF line breaks, empty cells for null, and text cells that look like formulas prefixed with `'`.
import { stringify } from 'csv-stringify/sync';

export type CsvCell = string | number | null | undefined;

const FORMULA = /^[=+\-@]/;
const NUMBER = /^[-+]?\d+(\.\d+)?$/;

/** Neutralise spreadsheet formulas in text cells ("=SUM(…)" → "'=SUM(…)"). */
export function neutraliseFormula(value: string): string {
  return FORMULA.test(value) && !NUMBER.test(value) ? `'${value}` : value;
}

/** Rows (first row = header) to CSV text. An empty row prints a blank line. */
export function toCsv(rows: CsvCell[][]): string {
  return stringify(rows, {
    record_delimiter: 'windows',
    quoted_match: /[\r\n]/,
    cast: { string: neutraliseFormula },
  });
}

/** `Content-Disposition` value for a download. Filenames are ASCII slugs we build ourselves. */
export const attachment = (filename: string) =>
  `attachment; filename="${filename}"`;

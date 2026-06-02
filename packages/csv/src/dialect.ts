/**
 * CSV dialect configuration - format variations like separators and quoting.
 */

export interface CsvDialect {
  readonly separator: string;
  readonly linebreak: string;
  readonly wrapper: string;
  readonly doubleWrapper: string;
}

/** Standard comma-separated values */
export const StandardDialect: CsvDialect = {
  separator: ",",
  linebreak: "\n",
  wrapper: '"',
  doubleWrapper: '""',
};

/** Tab-separated values */
export const TsvDialect: CsvDialect = {
  separator: "\t",
  linebreak: "\n",
  wrapper: '"',
  doubleWrapper: '""',
};

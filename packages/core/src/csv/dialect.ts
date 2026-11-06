/**
 * CSV dialect configuration - format variations like separators and quoting.
 */

export interface CsvDialect {
  readonly separator: string;
  /** The line break the writer ends rows with. The reader accepts CRLF, LF and CR. */
  readonly linebreak: string;
  readonly wrapper: string;
  readonly doubleWrapper: string;
}

/** Standard comma-separated values, written with LF line breaks */
export const StandardDialect: CsvDialect = {
  separator: ",",
  linebreak: "\n",
  wrapper: '"',
  doubleWrapper: '""',
};

/** Comma-separated values written with the CRLF line breaks RFC 4180 specifies */
export const Rfc4180Dialect: CsvDialect = {
  ...StandardDialect,
  linebreak: "\r\n",
};

/** Tab-separated values */
export const TsvDialect: CsvDialect = {
  separator: "\t",
  linebreak: "\n",
  wrapper: '"',
  doubleWrapper: '""',
};

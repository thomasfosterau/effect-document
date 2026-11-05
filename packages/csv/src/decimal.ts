/**
 * Reading plain decimals (`-?(0|[1-9]\d*)(\.\d+)?`) without the general
 * path's regular expression: in place in the text, in one scan, exactly as
 * `Number` reads them, and with the reader's rule that a number must hold
 * the digits it is written with (a decimal a double cannot hold stays text).
 *
 * @internal
 */

/**
 * The most digits a double always holds exactly (`DBL_DIG`): a decimal of at
 * most this many digits, with no exponent, reads back as written, so it needs
 * no check that its double holds its digits.
 */
export const exactDigits = 15;

/** Powers of ten that a double holds exactly: 10^0 to 10^22. */
const EXACT_POWERS_OF_TEN = Array.from({ length: 23 }, (_, k) => 10 ** k);

/** Veltkamp's splitter for doubles: 2^27 + 1. */
const SPLITTER = 134_217_729;

/** Results read back from the helpers below (no allocation per value). */
const scratch = {
  /** {@link twoProduct}'s rounding error. */
  error: 0,
};

/**
 * `a * b` rounded, with `scratch.error` set to its rounding error, so the two
 * sum to the exact product (Dekker's product, with Veltkamp's split).
 */
const twoProduct = (a: number, b: number): number => {
  const p = a * b;
  const ca = SPLITTER * a;
  const ah = ca - (ca - a);
  const al = a - ah;
  const cb = SPLITTER * b;
  const bh = cb - (cb - b);
  const bl = b - bh;
  scratch.error = ah * bh - p + ah * bl + al * bh + al * bl;
  return p;
};

/** 2^-53: half the gap between 1 and the next double up. */
const HALF_EPSILON = 2 ** -53;

/**
 * The gap from a positive normal double to the next one up, when it is also
 * the gap to the next one down; 0 otherwise (a power of two, whose gap below
 * is half the one above), for the caller to leave to `Number`.
 *
 * `c * 2^-53` is exact and lies in [ulp/2, ulp), at ulp/2 only when `c` is
 * a power of two: so `c` plus it rounds up to the next double, a gap of one
 * ulp, except for a power of two, where the tie rounds to `c` (its last bit
 * is even) and the gap is 0. Arithmetic, where reading and writing the
 * double's bits through a typed array cost a tenth of a long decimal's
 * reading (bench/csv.bench.ts's floats table).
 */
const ulpOf = (c: number): number => c + c * HALF_EPSILON - c;

/**
 * The double a long plain decimal reads as, when a double holds its digits
 * and both are cheap to tell; else `NaN`, which means only that the caller
 * must tell another way (`Number`, then `String`). The decimal's digits are
 * `high * 10^(total - 9) + low` (`high` its first nine digits, leading zeros
 * among them, `low` the rest), over 10^scale; it has no trailing zero.
 *
 * The double is computed from the digits rather than by `Number` (whose
 * long-decimal path costs as much as the scan): the quotient of the digits
 * by the power of ten, corrected once by its residual (the double times the
 * power, less the digits, computed exactly by Dekker's products but for two
 * small final additions), and kept only when the residual shows it within
 * half a unit in its last place of the decimal, so it is the correctly
 * rounded value, `Number`'s.
 *
 * `Number.prototype.toString` prints the shortest decimal that reads back as
 * the double, the nearest to it among those. So the double prints back as
 * written when (1) the written decimal is within half a unit of its last
 * digit of the double (else another of its length is nearer: the same
 * residual tells), and (2) neither decimal one digit shorter either side of
 * it reads back as the double (else a shorter one does; any shorter one
 * would make one of these two do so too). Those two lie a whole number of
 * tens of units from the digits, so the residual gives their distances from
 * the double exactly, and each reads back as it when within half its ulp. A
 * power of two (whose gap below is half the gap above) and every rounding
 * margin return `NaN`.
 */
const longDecimal = (
  high: number,
  low: number,
  total: number,
  scale: number,
  negative: boolean,
  exact: boolean,
): number => {
  if (scale > 22 || total > 24) return Number.NaN;
  const power = EXACT_POWERS_OF_TEN[scale] ?? 1;
  const highPart = twoProduct(high, EXACT_POWERS_OF_TEN[total - 9] ?? 1);
  const highError = scratch.error;
  let c = (highPart + low) / power;
  let r = twoProduct(c, power) - highPart - low + (scratch.error - highError);
  let halfUlp = (ulpOf(c) * power) / 2;
  if (!(Math.abs(r) < halfUlp * (1 - 1e-9))) {
    c -= r / power;
    r = twoProduct(c, power) - highPart - low + (scratch.error - highError);
    halfUlp = (ulpOf(c) * power) / 2;
  }
  // `c` is the correctly rounded value: `Number`'s, which is all a lossy read asks
  if (!(Math.abs(r) < halfUlp * (1 - 1e-9))) return Number.NaN;
  if (!exact) return negative ? -c : c;
  // and the decimal the nearest of its length to it
  if (!(Math.abs(r) < 0.5 - 1e-9)) return Number.NaN;
  // the decimals one digit shorter either side are whole tens of units from
  // the digits, at `r + last` below the double and `10 - last - r` above it:
  // one of them reads back as the double when within half its ulp
  const last = low % 10;
  const margin = halfUlp * (1 + 1e-9);
  if (r + last < margin || 10 - last - r < margin) return Number.NaN;
  return negative ? -c : c;
};

/** {@link scanDecimal}'s reading of a decimal's digits. */
const scan = {
  /** The first nine digits as an integer (leading zeros among them). */
  high: 0,
  /** The digits after the first nine as an integer. */
  low: 0,
  /** How many digits. */
  total: 0,
  /** The index of the decimal point, or -1. */
  point: -1,
};

/**
 * Read the digits and decimal point from `from` to `end` into {@link scan},
 * in one pass. False at any other character, or a second point.
 */
const scanDecimal = (raw: string, from: number, end: number): boolean => {
  let high = 0;
  let low = 0;
  let total = 0;
  let point = -1;
  let j = from;
  // oxlint-disable-next-line effect/imperative-loops -- a character scan, once per value of a number column: the measured hot path (bench/csv.bench.ts)
  for (; j < end && total < 9; j++) {
    const d = raw.charCodeAt(j) - 48;
    if (d >= 0 && d <= 9) {
      high = high * 10 + d;
      total++;
    } else if (d === -2 && point === -1) point = j;
    else return false;
  }
  // oxlint-disable-next-line effect/imperative-loops -- the digits after the first nine, as above
  for (; j < end; j++) {
    const d = raw.charCodeAt(j) - 48;
    if (d >= 0 && d <= 9) {
      low = low * 10 + d;
      total++;
    } else if (d === -2 && point === -1) point = j;
    else return false;
  }
  scan.high = high;
  scan.low = low;
  scan.total = total;
  scan.point = point;
  return true;
};

/**
 * Whether the scanned digits from `from` to `end` are a plain decimal: an
 * integer part of `0` alone or of digits not led by `0`, and digits after
 * any point.
 */
const isPlain = (raw: string, from: number, end: number): boolean => {
  const { total, point } = scan;
  const intDigits = point === -1 ? total : point - from;
  if (intDigits === 0 || (intDigits > 1 && raw.charCodeAt(from) === 48)) return false;
  return point === -1 || point < end - 1;
};

/**
 * The value of a plain decimal from its digits (`high`, `low`, `total`, as
 * the scans read them) and `scale`, or `NaN` when a double does not hold
 * them, or when that is not cheap to tell and `Number` and `String` say so
 * (the text from `start` to `end` is sliced then). Up to {@link exactDigits}
 * digits, the digits as an integer are below 2^53 and the power of ten they
 * are divided by is exact, so the one correctly rounded division gives
 * exactly what `Number` does (Clinger's fast path); a longer decimal goes to
 * {@link longDecimal}.
 */
const decimalFrom = (
  high: number,
  low: number,
  total: number,
  scale: number,
  negative: boolean,
  text: string,
  start: number,
  end: number,
  exact: boolean,
): number => {
  if (total <= exactDigits) {
    const value = total <= 9 ? high : high * (EXACT_POWERS_OF_TEN[total - 9] ?? 1) + low;
    const magnitude = scale === 0 ? value : value / (EXACT_POWERS_OF_TEN[scale] ?? 1);
    return negative ? -magnitude : magnitude;
  }
  // a trailing zero only matters to whether the digits print back
  const quick =
    exact && text.charCodeAt(end - 1) === 48
      ? Number.NaN
      : longDecimal(high, low, total, scale, negative, exact);
  if (!Number.isNaN(quick)) return quick;
  const raw = text.slice(start, end);
  return exact ? longValue(raw) : Number(raw);
};

/**
 * The number a long plain decimal spells when its double holds its digits
 * (it prints back as written, as the reader's general check would also
 * find); else `NaN`, for the general path to judge.
 */
const longValue = (raw: string): number => {
  const value = Number(raw);
  return String(value) === raw ? value : Number.NaN;
};

/**
 * The plain decimal from `start` to `end` of a string, when it is one a
 * double holds the digits of; else `NaN` (not a plain decimal, or one the
 * reader's general path must judge). With `exact` off, any plain decimal is
 * `Number` of it, its digits held or not (the reader's `exactNumbers: false`). For a value already sliced from the
 * text: {@link decimalInText} reads one in place.
 */
export const decimalAt = (text: string, start: number, end: number, exact = true): number => {
  const negative = text.charCodeAt(start) === 45;
  const from = negative ? start + 1 : start;
  if (!scanDecimal(text, from, end) || !isPlain(text, from, end)) return Number.NaN;
  const { high, low, total, point } = scan;
  const scale = point === -1 ? 0 : end - point - 1;
  return decimalFrom(high, low, total, scale, negative, text, start, end, exact);
};

/** {@link digitsInText}'s running digits, as {@link scan} holds {@link scanDecimal}'s. */
const inText = { high: 0, low: 0, total: 0 };

/**
 * The index past the run of digits from `from` (to `end` at most) of the
 * source text, with {@link inText} extended by them.
 *
 * This and {@link decimalInText} read a field in place in the text the
 * scanner holds, and only there: {@link scanDecimal} also reads values
 * sliced from it (short ones copied, long ones sliced), and a character scan
 * that meets more than one string representation runs at about half the
 * speed of one that meets only the source text's (measured on the floats
 * table of bench/csv.bench.ts, 34 against 60 ns a value).
 */
const digitsInText = (text: string, from: number, end: number): number => {
  let { high, low, total } = inText;
  let j = from;
  // oxlint-disable-next-line effect/imperative-loops -- a character scan, once per value of a number column read in place: the measured hot path (bench/csv.bench.ts)
  for (; j < end; j++) {
    const d = text.charCodeAt(j) - 48;
    if (d < 0 || d > 9) break;
    if (total < 9) high = high * 10 + d;
    else low = low * 10 + d;
    total++;
  }
  inText.high = high;
  inText.low = low;
  inText.total = total;
  return j;
};

/**
 * The plain decimal from `start` to `end` of the source text, read in place,
 * as {@link decimalAt} reads it from a string: `NaN` for anything else.
 */
export const decimalInText = (text: string, start: number, end: number, exact = true): number => {
  const negative = text.charCodeAt(start) === 45;
  const from = negative ? start + 1 : start;
  inText.high = 0;
  inText.low = 0;
  inText.total = 0;
  const intEnd = digitsInText(text, from, end);
  const intDigits = intEnd - from;
  // an integer part of `0` alone, or of digits not led by `0`
  if (intDigits === 0 || (intDigits > 1 && text.charCodeAt(from) === 48)) return Number.NaN;
  const point = intEnd < end;
  if (point && text.charCodeAt(intEnd) !== 46) return Number.NaN;
  const last = point ? digitsInText(text, intEnd + 1, end) : intEnd;
  // digits after a point, and nothing after them
  if ((point && last === intEnd + 1) || last !== end) return Number.NaN;
  const { high, low, total } = inText;
  return decimalFrom(
    high,
    low,
    total,
    point ? end - intEnd - 1 : 0,
    negative,
    text,
    start,
    end,
    exact,
  );
};

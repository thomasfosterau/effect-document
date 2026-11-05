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
/** 2^53: every integer up to it is a double. */
const TWO_53 = 9_007_199_254_740_992;

/** Results read back from the helpers below (no allocation per value). */
const scratch = {
  /** {@link twoProduct}'s rounding error. */
  error: 0,
  /** Whether {@link plainValueAt} left a long plain decimal for its caller to judge. */
  long: false,
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

/** A double's bits, for {@link ulpOf}. */
const bits = /*#__PURE__*/ new Float64Array(1);
const words = /*#__PURE__*/ new Uint32Array(bits.buffer);
/** The index of the low 32 bits of a double in {@link words}. */
const LOW = /*#__PURE__*/ new Uint8Array(new Uint16Array([1]).buffer)[0] === 1 ? 0 : 1;

/** The gap from a positive normal double to the next one up, or `NaN` across a word boundary. */
const ulpOf = (c: number): number => {
  bits[0] = c;
  const low = words[LOW] ?? 0;
  if (low === 0xff_ff_ff_ff) return Number.NaN;
  words[LOW] = low + 1;
  return (bits[0] ?? c) - c;
};

/** `digits / 10^scale` correctly rounded (`digits * 10` for scale -1): `Number` of that decimal. */
const decimalValue = (digits: number, scale: number): number =>
  scale < 0 ? digits * 10 : digits / (EXACT_POWERS_OF_TEN[scale] ?? 1);

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
 * would make one of these two do so too): two correctly rounded divisions of
 * integers below 2^53 (Clinger). Rounding margins in (1) return `NaN`.
 */
const longDecimal = (
  high: number,
  low: number,
  total: number,
  scale: number,
  negative: boolean,
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
  // `c` is the correctly rounded value, and the decimal the nearest of its length to it
  if (!(Math.abs(r) < halfUlp * (1 - 1e-9)) || !(Math.abs(r) < 0.5 - 1e-9)) return Number.NaN;
  const shorter = high * (EXACT_POWERS_OF_TEN[total - 10] ?? 1) + Math.floor(low / 10);
  if (
    shorter >= TWO_53 ||
    decimalValue(shorter, scale - 1) === c ||
    decimalValue(shorter + 1, scale - 1) === c
  )
    return Number.NaN;
  return negative ? -c : c;
};

/** {@link scanDecimal}'s reading of a decimal's digits. */
const scan = {
  /** The digits as an integer (exact up to 2^53). */
  value: 0,
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
  let value = 0;
  let high = 0;
  let low = 0;
  let total = 0;
  let point = -1;
  // oxlint-disable-next-line effect/imperative-loops -- a character scan, once per value of a number column: the measured hot path (bench/csv.bench.ts)
  for (let j = from; j < end; j++) {
    const d = raw.charCodeAt(j) - 48;
    if (d >= 0 && d <= 9) {
      value = value * 10 + d;
      if (total < 9) high = value;
      else low = low * 10 + d;
      total++;
    } else if (d === -2 && point === -1) point = j;
    else return false;
  }
  scan.value = value;
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
 * The value of the plain decimal from `start` to `end` of `raw`, read in
 * one scan, or `NaN` for anything else (an exponent, not a number), and for
 * a long decimal (more than {@link exactDigits} digits) {@link longDecimal}
 * cannot settle, which sets `scratch.long`. Up to {@link exactDigits}
 * digits, the digits as an integer are below 2^53 and the power of ten it is
 * divided by is exact, so the one correctly rounded division gives exactly
 * what `Number` does (Clinger's fast path).
 */
const plainValueAt = (raw: string, start: number, end: number): number => {
  scratch.long = false;
  const negative = raw.charCodeAt(start) === 45;
  const from = negative ? start + 1 : start;
  if (!scanDecimal(raw, from, end) || !isPlain(raw, from, end)) return Number.NaN;
  const { value, high, low, total, point } = scan;
  const scale = point === -1 ? 0 : end - point - 1;
  if (total <= exactDigits) {
    const magnitude = scale === 0 ? value : value / (EXACT_POWERS_OF_TEN[scale] ?? 1);
    return negative ? -magnitude : magnitude;
  }
  const quick =
    raw.charCodeAt(end - 1) === 48 ? Number.NaN : longDecimal(high, low, total, scale, negative);
  scratch.long = Number.isNaN(quick);
  return quick;
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
 * The plain decimal from `start` to `end` of `text`, read in place, when it
 * is one a double holds the digits of; else `NaN` (not a plain decimal, or
 * one the reader's general path must judge).
 */
export const decimalAt = (text: string, start: number, end: number): number => {
  const value = plainValueAt(text, start, end);
  return scratch.long ? longValue(text.slice(start, end)) : value;
};

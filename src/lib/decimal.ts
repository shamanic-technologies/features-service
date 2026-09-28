/**
 * EXACT MONEY ARITHMETIC ON THE PRODUCER'S OWN DECIMAL TEXT.
 *
 * runs-service states every cost as a decimal string (10 places, in cents). Summing those as floats and
 * rounding each group to the cent drifts a scope's total by a cent every few groups, which is enough to
 * make two surfaces print different cents for one cost per outcome. So a sum is taken exactly, on the
 * text, and converted to a number ONCE at the end.
 */

interface ParsedDecimal {
  neg: boolean;
  int: string;
  frac: string;
}

function parseDecimal(raw: unknown, what: string): ParsedDecimal {
  const str = String(raw);
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(str);
  if (!m) throw new Error(`${what} is not a decimal: ${JSON.stringify(raw)}`);
  return { neg: m[1] === "-", int: m[2]!, frac: m[3] ?? "" };
}

/** Exact sum of two decimal strings, rendered with the larger of their decimal counts. FAILS LOUD on a
 *  value that is not a decimal (`what` names it in the error). */
export function addDecimals(x: unknown, y: unknown, what = "cost figure"): string {
  const a = parseDecimal(x, what);
  const b = parseDecimal(y, what);
  const places = Math.max(a.frac.length, b.frac.length);
  const scaled = (p: ParsedDecimal) => {
    const v = BigInt(p.int + p.frac.padEnd(places, "0"));
    return p.neg ? -v : v;
  };
  const sum = scaled(a) + scaled(b);
  const neg = sum < 0n;
  const digits = (neg ? -sum : sum).toString().padStart(places + 1, "0");
  const int = digits.slice(0, digits.length - places);
  const frac = digits.slice(digits.length - places);
  return `${neg ? "-" : ""}${int}${places > 0 ? `.${frac}` : ""}`;
}

/**
 * A figure as plain decimal text. The producer's own strings pass through untouched; a figure that went
 * through a JS number (a comped bucket added back, `lib/pricing.ts`) can print in exponent form for a
 * value under 1e-6, which is rendered back to fixed-point here rather than rejected.
 */
export function asDecimalString(value: string | number): string {
  const str = String(value);
  return /e/i.test(str) ? Number(str).toFixed(12) : str;
}

/** Exact sum of decimal strings. `[]` is "0". */
export function sumDecimalStrings(values: readonly string[], what = "cost figure"): string {
  let total = "0";
  for (const v of values) total = addDecimals(total, asDecimalString(v), what);
  return total;
}

/** A decimal string of CENTS, as dollars — converted to a number once, never rounded. */
export function decimalCentsToUsd(cents: string): number {
  return Number(cents) / 100;
}

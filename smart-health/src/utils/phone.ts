/**
 * Phone-number helpers shared by the emergency-contacts screen and the
 * fall-call path. Comparison is format-insensitive so "+20 100 123" and
 * "+20100123" are treated as the same number.
 */

/** Strip everything except digits and a leading +. */
export function normalizePhone(p: string | undefined | null): string {
  return (p || '').replace(/[^0-9+]/g, '');
}

/** True when two phone numbers are the same once formatting is stripped. */
export function samePhone(
  a: string | undefined | null,
  b: string | undefined | null,
): boolean {
  const na = normalizePhone(a);
  return na.length > 0 && na === normalizePhone(b);
}

export interface LedgerCursor {
  readonly createdAt: Date;
  readonly id: string;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The cursor is opaque to clients but not magic: base64url of
 * `{"c":"<ISO instant>","i":"<uuid>"}`.
 *
 * Opaque so the storage format can change without breaking callers; validated
 * on the way in so a mangled cursor is a 400 rather than a SQL error or,
 * worse, a silently wrong page.
 */
export function encodeCursor(cursor: LedgerCursor): string {
  return Buffer.from(
    JSON.stringify({ c: cursor.createdAt.toISOString(), i: cursor.id }),
    'utf8',
  ).toString('base64url');
}

/** Returns null when the cursor is not one this endpoint previously produced. */
export function decodeCursor(raw: string): LedgerCursor | null {
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(raw, 'base64url').toString('utf8'),
    );

    if (typeof parsed !== 'object' || parsed === null) return null;

    const { c, i } = parsed as { c?: unknown; i?: unknown };

    if (typeof c !== 'string' || typeof i !== 'string') return null;
    if (!UUID_PATTERN.test(i)) return null;

    const createdAt = new Date(c);
    if (Number.isNaN(createdAt.getTime())) return null;

    return { createdAt, id: i };
  } catch {
    return null;
  }
}

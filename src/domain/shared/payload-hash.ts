import { createHash } from 'node:crypto';
import { canonicalJson } from './canonical-json.js';

/**
 * Algorithm: SHA-256 (64 lowercase hex chars) over the UTF-8 bytes of the
 * canonical JSON (sorted keys, no whitespace). Money always enters as
 * MoneyProps (decimal string), never as number, so 0.1 + 0.2 can never
 * produce a divergent hash.
 */
export const PAYLOAD_HASH_ALGORITHM = 'sha256';

export function sha256Hex(input: string): string {
  return createHash(PAYLOAD_HASH_ALGORITHM).update(input, 'utf8').digest('hex');
}

export function payloadHash(payload: unknown): string {
  return sha256Hex(canonicalJson(payload));
}

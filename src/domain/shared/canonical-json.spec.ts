import { canonicalJson, compareByCodeUnit } from './canonical-json.js';
import { payloadHash, sha256Hex } from './payload-hash.js';

describe('compareByCodeUnit', () => {
  it('orders by UTF-16 code unit, including the equality path', () => {
    expect(compareByCodeUnit('a', 'b')).toBe(-1);
    expect(compareByCodeUnit('b', 'a')).toBe(1);
    expect(compareByCodeUnit('a', 'a')).toBe(0);
    expect(compareByCodeUnit('Z', 'a')).toBe(-1); // 'Z' (90) < 'a' (97)
  });
});

describe('canonicalJson', () => {
  it('sorts top level keys by code unit', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('sorts nested keys recursively', () => {
    expect(canonicalJson({ z: { y: 1, x: 2 }, a: [3, { c: 1, b: 2 }] })).toBe(
      '{"a":[3,{"b":2,"c":1}],"z":{"x":2,"y":1}}',
    );
  });

  it('preserves array order', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
  });

  it('does not depend on insertion order', () => {
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
  });

  it('serializes scalars like JSON', () => {
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson('x')).toBe('"x"');
    expect(canonicalJson(true)).toBe('true');
    expect(canonicalJson(false)).toBe('false');
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'rejects non-finite number %s',
    (value) => {
      expect(() => canonicalJson({ amount: value })).toThrow('finite');
    },
  );

  it('rejects values that are not JSON scalars, objects or arrays', () => {
    expect(() => canonicalJson({ fn: () => 1 })).toThrow('unsupported value');
    expect(() => canonicalJson({ s: Symbol('x') })).toThrow(
      'unsupported value',
    );
    expect(() => canonicalJson({ b: 1n })).toThrow('unsupported value');
  });

  it('rejects undefined properties instead of silently dropping them', () => {
    expect(() => canonicalJson({ a: undefined })).toThrow('undefined');
  });

  it('rejects undefined inside arrays', () => {
    expect(() => canonicalJson([1, undefined])).toThrow('undefined');
  });
});

describe('payloadHash', () => {
  it('is a stable SHA-256 hex digest (fixed vector)', () => {
    // Fixed vector: locks the algorithm format forever.
    expect(sha256Hex('{"a":"1","b":2}')).toBe(
      'd79684d992c6150eea853d790cdef25f804d994cfe3a9198a5b012132dc46ec6',
    );
  });

  it('hashes MoneyProps in canonical form regardless of key order', () => {
    const expected =
      'd59b8d15b8bd613b4ea3b160470ac9606005734a1697c4cea5865df33e76f4bb';
    expect(payloadHash({ amount: '25.00', currency: 'BRL' })).toBe(expected);
    expect(payloadHash({ currency: 'BRL', amount: '25.00' })).toBe(expected);
  });

  it('diverges when the amount format diverges (string vs number)', () => {
    const asString = payloadHash({ amount: '0.30' });
    const asNumber = payloadHash({ amount: 0.3 });
    expect(asString).not.toBe(asNumber);
  });

  it('produces 64 lowercase hex chars', () => {
    expect(payloadHash({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });
});

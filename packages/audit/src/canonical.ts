/**
 * Deterministic Canonical JSON serialization for cryptographic hash inputs.
 * Ensures:
 * - Deterministic lexicographical object key sorting at all nested levels
 * - No whitespace variations
 * - Proper serialization of primitives, nulls, arrays, and nested structures
 */
export function canonicalJson(val: unknown): string {
  if (val === null || val === undefined) {
    return 'null';
  }

  const type = typeof val;

  if (type === 'boolean' || type === 'number') {
    return JSON.stringify(val);
  }

  if (type === 'string') {
    return JSON.stringify(val);
  }

  if (Array.isArray(val)) {
    const elements = val.map((item) => canonicalJson(item));
    return `[${elements.join(',')}]`;
  }

  if (type === 'object') {
    const obj = val as Record<string, unknown>;
    const sortedKeys = Object.keys(obj).sort();
    const pairs = sortedKeys.map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(obj[key])}`,
    );
    return `{${pairs.join(',')}}`;
  }

  return JSON.stringify(val);
}

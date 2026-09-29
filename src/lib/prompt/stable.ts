/**
 * JSON serialization with recursively sorted object keys.
 *
 * The cache meter hashes the assembled prefix. If key iteration order could leak
 * into that hash, the meter would report a false prefix change and the whole
 * accounting story would be worthless. Sorting keys removes that class of lie.
 */
export function stableStringify(value: unknown): string {
  return stringify(value, new Set<unknown>());
}

function stringify(value: unknown, seen: Set<unknown>): string {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'number':
      return Number.isFinite(value) ? String(value) : 'null';
    case 'boolean':
      return value ? 'true' : 'false';
    case 'bigint':
      return JSON.stringify(String(value));
    case 'undefined':
    case 'function':
    case 'symbol':
      return 'null';
  }

  if (seen.has(value)) throw new TypeError('stableStringify: circular reference');
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      let out = '[';
      for (let i = 0; i < value.length; i++) {
        if (i > 0) out += ',';
        out += stringify(value[i], seen);
      }
      return out + ']';
    }

    if (value instanceof Date) return JSON.stringify(value.toISOString());

    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => {
        const entry = record[key];
        return typeof entry !== 'undefined' && typeof entry !== 'function' && typeof entry !== 'symbol';
      })
      .sort();

    let out = '{';
    for (let i = 0; i < keys.length; i++) {
      if (i > 0) out += ',';
      out += JSON.stringify(keys[i]) + ':' + stringify(record[keys[i]], seen);
    }
    return out + '}';
  } finally {
    seen.delete(value);
  }
}

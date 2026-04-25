export function serializeBigInt<T>(value: T): T {
  if (typeof value === 'bigint') {
    return value.toString() as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => serializeBigInt(item)) as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = serializeBigInt(v);
    }
    return out as T;
  }
  return value;
}

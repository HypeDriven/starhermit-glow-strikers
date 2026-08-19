// Seeded deterministic random streams and stable hashing.
// Separate streams are used for rules, decoration and audiovisual variants so
// cosmetic randomness can never influence rules outcomes.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class RngStream {
  constructor(seed, stream = 0) {
    // Mix the stream tag into the seed so streams are independent.
    this.next = mulberry32(((seed >>> 0) ^ Math.imul(stream + 1, 0x9E3779B1)) >>> 0);
  }
  float() { return this.next(); }
  range(min, max) { return min + (max - min) * this.next(); }
  int(min, maxInclusive) { return min + Math.floor(this.next() * (maxInclusive - min + 1)); }
  pick(arr) { return arr[Math.floor(this.next() * arr.length)]; }
  sign() { return this.next() < 0.5 ? -1 : 1; }
}

// FNV-1a 32-bit hash of a string, returned as 8-char hex.
export function hashString(str) {
  let h = 0x811C9DC5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// Stable stringify: object keys sorted recursively so equivalent states hash equally.
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

export function hashValue(value) {
  return hashString(stableStringify(value));
}

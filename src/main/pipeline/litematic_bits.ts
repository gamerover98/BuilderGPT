/**
 * Litematica's packed block-state array, both directions.
 *
 * Its own module because it is the one part of the container that is pure
 * arithmetic and the one part both the reader and the writer need: a decoder
 * living inside `loader_formats.ts` could not be reached from `writers.ts`
 * without one of them importing the other, and two copies of a bit-packing
 * routine is how a file comes back off by one entry from some offset onward.
 *
 * ## It is not any of the three packings this app already has
 *
 * Sponge v2 packs into a **byte** stream, Sponge v3 into **varints**, and
 * modern Minecraft chunks pack into longs *without* letting an entry cross a
 * long boundary. Litematica's crosses. An entry starts at bit `i * bits`
 * counting from the least significant bit of long 0, and if it runs off the end
 * of that long the rest of it is the low bits of the next one.
 *
 * The difference is invisible for a palette whose width divides 64 -- with 8
 * bits per entry the two agree exactly, which is what the first sample file
 * here happens to be -- so it is checked at 5 and 9 bits, where they do not.
 *
 * ## The width is a function of the palette, and nothing else
 *
 * `max(2, bits needed for the largest index)`. The floor of 2 is Litematica's;
 * a schematic of nothing but air would otherwise be packed one bit per cell and
 * every reader would have to special-case it.
 *
 * Verified against two real files rather than reasoned about: a 241-entry
 * palette over 64x46x88 gives 8 bits and 32,384 longs, and a 367-entry palette
 * over 122x145x54 gives 9 bits and 134,334 longs. Both are what those files
 * contain.
 */

const MASK64 = (1n << 64n) - 1n;

/** Bits per entry for a palette of this size. Never below 2. */
export function bitsPerEntry(paletteSize: number): number {
  const largest = Math.max(1, paletteSize - 1);
  return Math.max(2, 32 - Math.clz32(largest));
}

/** How many 64-bit words hold `count` entries of `bits` bits each. */
export function longsNeeded(bits: number, count: number): number {
  return Math.ceil((bits * count) / 64);
}

/**
 * `prismarine-nbt` represents a long as `[high, low]`, both 32-bit signed.
 *
 * The `>>> 0` states the intent rather than carrying it: every long in a full
 * palette's array has its high bit set, so `high` arrives negative, and without
 * the coercion the shift would produce a negative bigint. BigInt's bitwise
 * operators work on an infinite two's-complement representation, so `& MASK64`
 * in the reader below recovers the same 64 bits either way. Written out because
 * the alternative is a reader that depends on that identity without saying so.
 */
export function longPairsToBigints(pairs: readonly (readonly [number, number])[]): bigint[] {
  return pairs.map(([high, low]) => (BigInt(high >>> 0) << 32n) | BigInt(low >>> 0));
}

/** The inverse, for the writer. Both halves come back signed, as the tag wants. */
export function bigintsToLongPairs(values: readonly bigint[]): [number, number][] {
  return values.map((value) => {
    const bits = value & MASK64;
    return [Number(BigInt.asIntN(32, bits >> 32n)), Number(BigInt.asIntN(32, bits & 0xffffffffn))];
  });
}

/**
 * Reads `count` entries out of the packed words.
 *
 * A word the array does not reach reads as zero rather than throwing: a file
 * whose array is short is a damaged file, and the useful answer there is the
 * part of the build that survived, with air where the rest was -- the same
 * choice `decodePackedBlockStates` already makes for Sponge.
 */
export function unpackLitematicStates(
  words: readonly bigint[],
  bits: number,
  count: number,
): Int32Array {
  const out = new Int32Array(count);
  const mask = (1n << BigInt(bits)) - 1n;
  const wide = BigInt(bits);
  const at = (index: number): bigint => (index < words.length ? words[index] & MASK64 : 0n);

  for (let i = 0; i < count; i += 1) {
    const start = BigInt(i) * wide;
    const first = Number(start >> 6n);
    const last = Number((start + wide - 1n) >> 6n);
    const offset = start & 63n;

    if (first === last) {
      out[i] = Number((at(first) >> offset) & mask);
    } else {
      // The tail of this word, then as much of the next one as is still wanted.
      const carried = 64n - offset;
      out[i] = Number(((at(first) >> offset) | (at(last) << carried)) & mask);
    }
  }
  return out;
}

/**
 * Packs `count` entries into words, the same way round.
 *
 * Written as the exact inverse of the reader above rather than as "the obvious
 * way": a packer that filled each word and moved on would produce a file this
 * app reads back correctly and Litematica does not, because the two would
 * disagree only where an entry straddles.
 */
export function packLitematicStates(values: ArrayLike<number>, bits: number): bigint[] {
  const count = values.length;
  const words = new Array<bigint>(longsNeeded(bits, count)).fill(0n);
  const mask = (1n << BigInt(bits)) - 1n;
  const wide = BigInt(bits);

  for (let i = 0; i < count; i += 1) {
    const value = BigInt(values[i]) & mask;
    const start = BigInt(i) * wide;
    const first = Number(start >> 6n);
    const last = Number((start + wide - 1n) >> 6n);
    const offset = start & 63n;

    words[first] = (words[first] & ~(mask << offset) & MASK64) | ((value << offset) & MASK64);

    if (first !== last) {
      const carried = 64n - offset;
      const rest = wide - carried;
      // Clear only the low `rest` bits of the next word: the entries already
      // written above them belong to somebody else.
      words[last] = (((words[last] >> rest) << rest) & MASK64) | (value >> carried);
    }
  }
  return words;
}

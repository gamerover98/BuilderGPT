/**
 * How a long loop in main lets the process do something else.
 *
 * `await` does not. It queues a microtask, and microtasks run *before* I/O, so
 * a loop of awaited work starves the event loop exactly as a synchronous one
 * would — which is what froze the window during the block warm-up: every IPC
 * call, including the one opening the schematic that triggered it, sat behind
 * it. `setImmediate` runs in the check phase, *after* I/O, and is the yield
 * that actually hands the process back.
 *
 * In its own module because two loops need it now — decoding the textures and
 * meshing the icons — and it is a rule that cost something to learn. Written
 * twice it would be corrected once.
 */

/**
 * How many iterations pass between yields.
 *
 * A yield per iteration would be correct and slow: `setImmediate` is a trip
 * through the event loop, and at nine hundred iterations that is most of the
 * budget of a loop whose real work is a fraction of a millisecond each.
 */
const YIELD_EVERY = 16;

/**
 * Reports progress and hands the process back, every `YIELD_EVERY` steps and
 * on the last one.
 *
 * `index` is zero-based; what is reported is how many are *done*.
 */
export async function breathe(
  index: number,
  total: number,
  onProgress: (done: number, total: number) => void,
): Promise<void> {
  if (index % YIELD_EVERY !== 0 && index !== total - 1) return;
  onProgress(index + 1, total);
  await new Promise<void>((resolve) => setImmediate(resolve));
}

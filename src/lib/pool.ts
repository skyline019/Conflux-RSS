/** Run async work over `items` with a fixed concurrency ceiling. */
export async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
  onResult?: (result: R, index: number, completed: number) => void | Promise<void>,
): Promise<R[]> {
  if (!items.length) return [];
  const results = new Array<R>(items.length);
  let next = 0;
  let completed = 0;
  const limit = Math.max(1, Math.min(concurrency, items.length));

  async function run() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      const value = await worker(items[i], i);
      results[i] = value;
      completed += 1;
      await onResult?.(value, i, completed);
    }
  }

  await Promise.all(Array.from({ length: limit }, () => run()));
  return results;
}

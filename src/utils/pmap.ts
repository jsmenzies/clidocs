// Parallel map utility with concurrency limit
export async function pMap<T, R>(
  items: T[],
  mapper: (item: T) => Promise<R>,
  options: { concurrency: number },
): Promise<R[]> {
  const results: R[] = [];
  const { concurrency } = options;

  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map(mapper));
    results.push(...batchResults);
  }

  return results;
}

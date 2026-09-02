/**
 * Wie Promise.all, aber es laufen nie mehr als `limit` Aufgaben gleichzeitig.
 *
 * Steht eigenständig, weil Abholen und Nachholen dieselbe Bremse brauchen: die
 * Kategorisierung geht über Gemini, und alles auf einmal loszuschicken reizt
 * die Quote aus, statt Zeit zu sparen.
 */
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;

  async function run() {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

module.exports = { mapWithConcurrency };

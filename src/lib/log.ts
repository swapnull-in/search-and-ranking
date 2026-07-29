/** Timestamped logging so you can watch queries retrieve and rank. */
export function log(...args: unknown[]): void {
  const t = new Date().toISOString().slice(11, 23);
  console.log(`[${t}]`, ...args);
}

import type { Feature } from '../shared/protocol';

/**
 * What the connected server can do (hello.features, see docs/protocol.md). The one place the UI tells an older server
 * from a newer one: everything else asks `has()`. A server that sends no list has nothing.
 */
let current: ReadonlySet<string> = new Set();

/** From every hello (a reconnect may reach another server version). */
export function setFeatures(list: readonly string[] | undefined): void {
  current = new Set(Array.isArray(list) ? list.filter((x) => typeof x === 'string') : []);
}

export function has(feature: Feature): boolean {
  return current.has(feature);
}

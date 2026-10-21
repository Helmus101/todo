/** Insert into a Map used as a cache, evicting the oldest entries past `max` (Map iterates in insertion order;
 *  re-inserting a key moves it to the end). Serverless instances live for hours — caches keyed by user/session
 *  would otherwise only ever grow. */
export function setBounded<K, V>(map: Map<K, V>, key: K, value: V, max = 1000): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) { const oldest = map.keys().next().value; if (oldest === undefined) break; map.delete(oldest); }
}

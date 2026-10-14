/**
 * The review inbox count behind the header's "Needs you" badge
 * (architecture §11.6). Counting the inbox means the cross-repository gate
 * read of services/reviewInbox.ts, far too much for every page load, so the
 * count `/inbox` already computed is remembered per user in the colo-local
 * Cache API for a few minutes, read by other app pages for no D1 work, and
 * dropped when the user decides from a page. Where the Cache API does not
 * persist (a workers.dev host), other pages simply show no inbox count.
 */

const TTL_SECONDS = 300;

export interface InboxCount {
  count: number;
  /** More changes wait beyond the counted first page. */
  more: boolean;
}

function key(userId: string): Request {
  // A synthetic, never-routed URL: the key names the user, never a credential.
  return new Request(`https://inbox-count.kvarm.invalid/${encodeURIComponent(userId)}`);
}

function cache(): Cache | null {
  return typeof caches === 'undefined' ? null : caches.default;
}

export async function rememberInboxCount(userId: string, value: InboxCount): Promise<void> {
  await cache()
    ?.put(key(userId), new Response(JSON.stringify(value), { headers: { 'cache-control': `max-age=${TTL_SECONDS}`, 'content-type': 'application/json' } }))
    .catch(() => undefined);
}

export async function cachedInboxCount(userId: string): Promise<InboxCount | null> {
  try {
    const hit = await cache()?.match(key(userId));
    if (!hit) return null;
    const v = (await hit.json()) as Partial<InboxCount>;
    return Number.isInteger(v.count) && (v.count as number) >= 0 ? { count: v.count as number, more: v.more === true } : null;
  } catch {
    return null;
  }
}

export async function forgetInboxCount(userId: string): Promise<void> {
  await cache()?.delete(key(userId)).catch(() => undefined);
}

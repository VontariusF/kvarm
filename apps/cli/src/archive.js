// @ts-check
/**
 * Snapshot archive intake (architecture §11.5). A snapshot is a ustar tar,
 * stored either plain (legacy) or gzip-compressed; the form is detected from
 * the first two bytes (1f 8b), never from headers, because proxies and
 * `fetch` may add, drop or apply Content-Encoding on the way. Every
 * extraction safety check in untar.js runs on the decompressed stream.
 *
 * Decompression is bounded so a hostile or corrupt object cannot fill the
 * disk: output past `maxBytes`, or past `maxRatio` times the compressed bytes
 * once `ratioFloor` output bytes exist, stops the transfer with a TarError.
 */

import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { TarError, extractTar } from './untar.js';

/** Largest decompressed snapshot accepted. */
export const MAX_DECOMPRESSED_BYTES = 8 * 1024 * 1024 * 1024;
/** Largest decompressed/compressed ratio accepted; real source trees stay far below it. */
export const MAX_RATIO = 1000;
/** The ratio is only judged once this much output exists, so tiny archives cannot trip it. */
export const RATIO_FLOOR = 64 * 1024 * 1024;

/**
 * @typedef {object} ArchiveLimits
 * @property {number} [maxBytes]
 * @property {number} [maxRatio]
 * @property {number} [ratioFloor]
 */

/**
 * Reads up to the first two bytes and returns whether they are the gzip
 * magic, plus a source that replays everything read.
 * @param {AsyncIterable<Uint8Array>} source
 * @returns {Promise<{ gzip: boolean, source: AsyncIterable<Uint8Array>, close: () => Promise<void> }>}
 */
async function sniff(source) {
  const it = source[Symbol.asyncIterator]();
  /** @type {Uint8Array[]} */
  const held = [];
  let have = 0;
  let ended = false;
  while (have < 2) {
    const r = await it.next();
    if (r.done) {
      ended = true;
      break;
    }
    const chunk = r.value instanceof Uint8Array ? r.value : new Uint8Array(r.value);
    held.push(chunk);
    have += chunk.length;
  }
  const head = new Uint8Array(2);
  let n = 0;
  for (const c of held) for (let i = 0; i < c.length && n < 2; i++) head[n++] = /** @type {number} */ (c[i]);
  const gzip = n === 2 && head[0] === 0x1f && head[1] === 0x8b;
  return {
    gzip,
    // An unstarted generator's return() skips its finally, so releasing the
    // body on an early failure goes through the underlying iterator.
    close: async () => {
      await it.return?.().catch(() => undefined);
    },
    source: (async function* () {
      try {
        yield* held;
        if (!ended) for (let r = await it.next(); !r.done; r = await it.next()) yield r.value;
      } finally {
        await it.return?.();
      }
    })(),
  };
}

/**
 * Gunzips a stream (concatenated members included, as the builder writes one
 * per Workflow step), enforcing the limits and counting compressed bytes.
 * @param {AsyncIterable<Uint8Array>} source
 * @param {{ compressed: number }} tally
 * @param {Required<ArchiveLimits>} limits
 * @returns {AsyncGenerator<Uint8Array>}
 */
async function* gunzipBounded(source, tally, limits) {
  const input = Readable.from(
    (async function* () {
      for await (const chunk of source) {
        tally.compressed += chunk.length;
        yield chunk;
      }
    })(),
    { objectMode: false },
  );
  const gunzip = createGunzip();
  input.on('error', (err) => gunzip.destroy(err));
  input.pipe(gunzip);
  let out = 0;
  try {
    for await (const chunk of gunzip) {
      out += chunk.length;
      if (out > limits.maxBytes) throw new TarError(`snapshot expands past ${limits.maxBytes} bytes; refusing`);
      if (out > limits.ratioFloor && out > limits.maxRatio * Math.max(tally.compressed, 1)) {
        throw new TarError(`snapshot expands more than ${limits.maxRatio}x; refusing`);
      }
      yield chunk;
    }
  } catch (err) {
    if (err instanceof TarError) throw err;
    throw new TarError(`snapshot gzip stream is truncated or corrupt: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    input.destroy();
    gunzip.destroy();
  }
}

/**
 * Extracts a plain or gzip tar snapshot into `dest`.
 *
 * @param {AsyncIterable<Uint8Array>} source the downloaded bytes
 * @param {string} dest
 * @param {ArchiveLimits} [limits]
 * @returns {Promise<{files: number, dirs: number, symlinks: number, bytes: number, tarBytes: number, compressed: boolean}>}
 *   `bytes` counts the bytes received (what the metadata `size` describes);
 *   `tarBytes` counts the tar bytes after decompression.
 */
export async function extractArchive(source, dest, limits = {}) {
  const l = {
    maxBytes: limits.maxBytes ?? MAX_DECOMPRESSED_BYTES,
    maxRatio: limits.maxRatio ?? MAX_RATIO,
    ratioFloor: limits.ratioFloor ?? RATIO_FLOOR,
  };
  const sniffed = await sniff(source);
  try {
    if (!sniffed.gzip) {
      const r = await extractTar(sniffed.source, dest);
      return { ...r, tarBytes: r.bytes, compressed: false };
    }
    // gunzip only ends once its input has ended, so by the time extractTar
    // returns the tally holds every byte of the download: the caller's size
    // check does not depend on the decoder stopping early.
    const tally = { compressed: 0 };
    const r = await extractTar(gunzipBounded(sniffed.source, tally, l), dest);
    return { ...r, bytes: tally.compressed, tarBytes: r.bytes, compressed: true };
  } finally {
    await sniffed.close();
  }
}

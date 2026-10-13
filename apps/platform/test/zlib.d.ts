// Minimal declaration for the nodejs_compat zlib used by the fake receive-pack;
// the platform tsconfig deliberately excludes @types/node.
declare module 'node:zlib' {
  /** Reads concatenated gzip members, which DecompressionStream refuses. */
  export function gunzipSync(buf: Uint8Array): Uint8Array;
  export function inflateSync(buf: Uint8Array, opts?: { info?: boolean }): Uint8Array;
}

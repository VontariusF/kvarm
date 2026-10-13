import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import { tarEnd, tarEntry, tarHeader, tarPadding } from '@kvarm/gitops';
import { extractArchive } from '../src/archive.js';
import { TarError } from '../src/untar.js';
import { chunked, diffTrees, gitCheckout, makeRepo, tarFromCommit, tempDir } from './helpers';

const root = tempDir('kvarm-cli-archive-');
afterAll(() => rmSync(root, { recursive: true, force: true }));
const repo = makeRepo(root);
const plain = tarFromCommit(repo.bare, repo.main);
const gz = new Uint8Array(gzipSync(plain));

/** The builder writes one gzip member per Workflow step; split at a block boundary to mimic that. */
function members(tar: Uint8Array, at: number): Uint8Array {
  return new Uint8Array(Buffer.concat([gzipSync(tar.subarray(0, at)), gzipSync(tar.subarray(at))]));
}

/** A gzip tar holding one zero-filled file of `size` bytes. */
function tarWithZeros(size: number): Uint8Array {
  const head = tarHeader({ path: 'zeros.bin', type: 'file', mode: 0o644, size, mtime: 0 });
  return new Uint8Array(gzipSync(Buffer.concat([head, Buffer.alloc(size + tarPadding(size)), tarEnd()])));
}

describe('extractArchive', () => {
  it('extracts a plain tar and reports it as uncompressed', async () => {
    const r = await extractArchive(chunked(plain), join(root, 'plain'));
    expect(r).toMatchObject({ compressed: false, bytes: plain.length, tarBytes: plain.length });
  });

  it('extracts a gzip tar by magic bytes and counts the received bytes', async () => {
    const r = await extractArchive(chunked(gz), join(root, 'gzip'));
    expect(r).toMatchObject({ compressed: true, bytes: gz.length, tarBytes: plain.length });
  });

  it('detects gzip even when the first chunks are single bytes', async () => {
    const r = await extractArchive(chunked(gz, [1, 1, 3, 9999]), join(root, 'gzip-onebyte'));
    expect(r.compressed).toBe(true);
  });

  it('reads multi-member gzip, one member per builder step', async () => {
    const dest = join(root, 'gzip-members');
    const r = await extractArchive(chunked(members(plain, 1024)), dest);
    expect(r).toMatchObject({ compressed: true, tarBytes: plain.length });
    gitCheckout(repo.bare, repo.main, join(root, 'expected-members'));
    expect(diffTrees(dest, join(root, 'expected-members'))).toEqual({ code: 0, out: '' });
  });

  it('produces byte-identical trees from the plain and gzip forms of the same snapshot', async () => {
    const a = join(root, 'same-plain');
    const b = join(root, 'same-gzip');
    await extractArchive(chunked(plain), a);
    await extractArchive(chunked(gz), b);
    expect(diffTrees(a, b)).toEqual({ code: 0, out: '' });
    const expected = join(root, 'same-git');
    gitCheckout(repo.bare, repo.main, expected);
    expect(diffTrees(b, expected)).toEqual({ code: 0, out: '' });
  });

  it('fails cleanly on a truncated gzip stream', async () => {
    await expect(extractArchive(chunked(gz.subarray(0, Math.floor(gz.length / 2))), join(root, 'truncated'))).rejects.toThrow(TarError);
    await expect(extractArchive(chunked(gz.subarray(0, gz.length - 4)), join(root, 'truncated-tail'))).rejects.toThrow(
      /truncated or corrupt/,
    );
  });

  it('fails cleanly on corrupt gzip data after the magic bytes', async () => {
    const bad = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    await expect(extractArchive(chunked(bad), join(root, 'corrupt'))).rejects.toThrow(/truncated or corrupt/);
  });

  it('treats a stream that ends inside the magic as plain and rejects it as a bad tar', async () => {
    await expect(extractArchive(chunked(new Uint8Array([0x1f])), join(root, 'one-byte'))).rejects.toThrow(TarError);
  });

  it('refuses output past the absolute limit', async () => {
    await expect(extractArchive(chunked(gz), join(root, 'bomb-abs'), { maxBytes: 2048 })).rejects.toThrow(/refusing/);
  });

  it('refuses a high-ratio gzip bomb with a lowered ratio floor', async () => {
    const bomb = tarWithZeros(40 * 1024 * 1024);
    expect(bomb.length).toBeLessThan(1024 * 1024);
    await expect(extractArchive(chunked(bomb), join(root, 'bomb-ratio'), { ratioFloor: 1024 * 1024 })).rejects.toThrow(
      /expands more than 250x/,
    );
  });

  it('refuses the same bomb under the default limits once it passes the ratio floor', async () => {
    const bomb = tarWithZeros(96 * 1024 * 1024);
    await expect(extractArchive(chunked(bomb), join(root, 'bomb-default'))).rejects.toThrow(/expands more than 250x/);
  });

  it('still applies the path safety checks to the decompressed stream', async () => {
    const entry = tarEntry({ path: '../escape.txt', type: 'file', mode: 0o644, size: 1, mtime: 0 }, new TextEncoder().encode('x'));
    const evil = new Uint8Array(gzipSync(Buffer.concat([entry, tarEnd()])));
    await expect(extractArchive(chunked(evil), join(root, 'evil', 'inner'))).rejects.toThrow(/unsafe archive path/);
    expect(existsSync(join(root, 'evil', 'escape.txt'))).toBe(false);
  });
});

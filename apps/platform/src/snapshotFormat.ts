/**
 * Snapshot tarball formats (architecture §11.5, issue #20). The format is part
 * of the R2 key, so the tree row's `r2_key` is the only record of it: no
 * migration, and an existing uncompressed object is never relabelled. New
 * builds write `.tar.gz`; a tree already built as `.tar` keeps serving that
 * object until the repo is deleted.
 */

export type SnapshotFormat = 'gzip' | 'tar';

/** Key of a tree's tarball in the given format. */
export function snapshotKey(repoId: string, tree: string, format: SnapshotFormat = 'gzip'): string {
  return `trees/v1/${repoId}/${tree}.${format === 'gzip' ? 'tar.gz' : 'tar'}`;
}

export function formatOfKey(key: string): SnapshotFormat {
  return key.endsWith('.tar.gz') ? 'gzip' : 'tar';
}

/** Media type and download extension served for each format. */
export const FORMAT_HTTP: Record<SnapshotFormat, { contentType: string; extension: string }> = {
  gzip: { contentType: 'application/gzip', extension: 'tar.gz' },
  tar: { contentType: 'application/x-tar', extension: 'tar' },
};

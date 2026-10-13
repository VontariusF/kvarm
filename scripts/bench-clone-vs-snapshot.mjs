#!/usr/bin/env node
/**
 * Clone-vs-snapshot checkout benchmark (VAL-SNAP-009).
 *
 * For each target it times, from a cold destination directory each run:
 *
 * - `clone`     git clone --no-checkout <url> + git checkout <ref> (full history, every branch)
 * - `shallow`   git clone --depth=1 --single-branch --branch <ref> (strongest git baseline)
 * - `snapshot`  kvarm checkout <owner/repo> <ref> <dir> (must print `source: snapshot`)
 *
 * Variants alternate within each run so drift affects all three alike. Wall
 * time is measured around the child process (process start included). Bytes:
 * the snapshot tarball size (printed by the CLI, equal to metadata `size`),
 * the received pack size for git (`.git/objects/pack/*.pack`), and the
 * checked-out tree size. The first run of each target checks that all three
 * trees are identical (`diff -r -x .git`). One extra untimed download per
 * target records how large the tarball is gzip-compressed (legacy plain
 * snapshots) or decompressed (new gzip snapshots).
 *
 * Targets:
 * - fixture  <owner>/fixture-1m at bench-head (read-only; never pushed or deleted).
 * - small    a fresh public repo m4-cli-checkout-bench-<ts> with 5 commits
 *            and ~60 source-like files on main, deleted afterwards unless --keep.
 *
 * Env (load .env.local): KVARM_PAT (KVARM_USER). Tokens
 * are never printed; git runs with `-c credential.helper=` and a
 * secret-free GIT_ASKPASS helper, using the configured git identity.
 *
 * Usage: node scripts/bench-clone-vs-snapshot.mjs [--runs=3] [--only=fixture,small] [--write] [--keep]
 *   --write   updates docs/benchmarks/clone-vs-snapshot.json and .md
 *   --render  only rewrites the .md from the committed .json (no network)
 */

import { spawnSync } from 'node:child_process';
import { request } from 'node:https';
import { createGunzip, createGzip } from 'node:zlib';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { arch, cpus, platform, release, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { withFixtureRepo } from './lib/fixture-repo.mjs';

const { values: args } = parseArgs({
  options: {
    runs: { type: 'string', default: '3' },
    only: { type: 'string', default: 'fixture,small' },
    write: { type: 'boolean', default: false },
    keep: { type: 'boolean', default: false },
    render: { type: 'boolean', default: false },
  },
});
const BASE = (process.env.KVARM_BASE_URL ?? 'http://localhost:8787').replace(/\/+$/, '');
const OWNER = process.env.KVARM_USER ?? 'admin';
const RUNS = Math.max(3, Number(args.runs) || 3);
const ONLY = new Set(args.only.split(','));
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const KVARM_BIN = join(ROOT, 'apps', 'cli', 'bin', 'kvarm.js');
const FIXTURE = { repo: 'fixture-1m', ref: 'bench-head', sha: '08333c79998f410b9c40a84cc430ce9762c29ae8' };
const PREFIX = 'm4-cli-checkout';
const READY_BOUND_MS = 15 * 60_000;
const ts = Date.now();
const DOC_JSON = join(ROOT, 'docs', 'benchmarks', 'clone-vs-snapshot.json');
const DOC_MD = join(ROOT, 'docs', 'benchmarks', 'clone-vs-snapshot.md');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const work = mkdtempSync(join(tmpdir(), 'bench-clone-vs-snapshot-'));
const askpass = join(work, 'askpass.sh');
writeFileSync(askpass, '#!/bin/sh\ncase "$1" in *sername*) echo kvarm ;; *) printenv BENCH_GIT_TOKEN ;; esac\n');
chmodSync(askpass, 0o700);
const gitEnv = { ...process.env, GIT_ASKPASS: askpass, GIT_TERMINAL_PROMPT: '0', BENCH_GIT_TOKEN: process.env.KVARM_PAT };

function run(cmd, cmdArgs, { cwd, env = gitEnv } = {}) {
  const t0 = process.hrtime.bigint();
  const r = spawnSync(cmd, cmdArgs, { cwd, env, encoding: 'utf8', maxBuffer: 64 << 20 });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return { code: r.status, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim(), ms };
}
const git = (cwd, gitArgs) => run('git', ['-c', 'credential.helper=', ...gitArgs], { cwd });

async function http(path, { method = 'GET', json } = {}) {
  const headers = { Authorization: `Bearer ${process.env.KVARM_PAT}` };
  if (json !== undefined) headers['content-type'] = 'application/json';
  const init = { method, headers };
  if (json !== undefined) init.body = JSON.stringify(json);
  const res = await fetch(`${BASE}${path}`, init);
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

/** Sum of regular-file sizes under `dir`, skipping `.git` when `skipGit`. */
function treeBytes(dir, skipGit = true) {
  let total = 0;
  for (const name of readdirSync(dir)) {
    if (skipGit && name === '.git') continue;
    const p = join(dir, name);
    const st = lstatSync(p);
    if (st.isDirectory()) total += treeBytes(p, false);
    else if (st.isFile()) total += st.size;
  }
  return total;
}

function packBytes(dir) {
  const packDir = join(dir, '.git', 'objects', 'pack');
  let total = 0;
  for (const name of readdirSync(packDir)) if (name.endsWith('.pack')) total += lstatSync(join(packDir, name)).size;
  return total;
}

/** Demands the snapshot and waits until it is ready. */
async function ensureReady(repo, ref) {
  const t0 = Date.now();
  let r = await http(`/api/v1/repos/${OWNER}/${repo}/snapshots/${ref}`, { method: 'POST' });
  while (!(r.status === 200 && r.body?.state === 'ready')) {
    if (r.status >= 400 || Date.now() - t0 > READY_BOUND_MS) throw new Error(`snapshot ${repo}@${ref} not ready: ${r.status} ${JSON.stringify(r.body)}`);
    await sleep(2000);
    r = await http(`/api/v1/repos/${OWNER}/${repo}/snapshots/${ref}`);
  }
  return r.body;
}

/**
 * Downloads the tarball once (untimed). Legacy snapshots are plain tar, so the
 * gzip -6 size is measured here; new snapshots arrive gzip-compressed (magic
 * bytes 1f 8b), so their received size is the gzip size and the tar size is
 * measured by decompressing.
 */
function gzipSize(repo, sha) {
  return new Promise((resolve, reject) => {
    const url = `${BASE}/api/v1/repos/${OWNER}/${repo}/snapshots/${sha}/download`;
    const req = request(url, { headers: { authorization: `Bearer ${process.env.KVARM_PAT}` } }, (res) => {
      if (res.statusCode !== 200) return reject(new Error(`download ${res.statusCode}`));
      let received = 0;
      let out = 0;
      let stored;
      let coder;
      res.on('data', (chunk) => {
        received += chunk.length;
        if (!coder) {
          stored = chunk[0] === 0x1f && chunk[1] === 0x8b ? 'gzip' : 'tar';
          coder = stored === 'gzip' ? createGunzip() : createGzip({ level: 6 });
          coder.on('data', (c) => (out += c.length));
          coder.on('error', reject);
          coder.on('end', () =>
            resolve(stored === 'gzip' ? { stored, tarBytes: out, gzipBytes: received } : { stored, tarBytes: received, gzipBytes: out }),
          );
        }
        coder.write(chunk);
      });
      res.on('end', () => coder?.end());
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

const VARIANTS = {
  clone(t, dir) {
    const a = git(work, ['clone', '-q', '--no-checkout', t.url, dir]);
    if (a.code !== 0) throw new Error(`git clone failed: ${a.err}`);
    const b = git(dir, ['checkout', '-q', t.ref]);
    if (b.code !== 0) throw new Error(`git checkout failed: ${b.err}`);
    const sha = git(dir, ['rev-parse', 'HEAD']).out;
    return { ms: a.ms + b.ms, sha, transferBytes: packBytes(dir) };
  },
  shallow(t, dir) {
    const a = git(work, ['clone', '-q', '--depth=1', '--single-branch', '--branch', t.ref, t.url, dir]);
    if (a.code !== 0) throw new Error(`git clone --depth=1 failed: ${a.err}`);
    const sha = git(dir, ['rev-parse', 'HEAD']).out;
    return { ms: a.ms, sha, transferBytes: packBytes(dir) };
  },
  snapshot(t, dir) {
    const env = { PATH: process.env.PATH, HOME: process.env.HOME, KVARM_BASE_URL: BASE, KVARM_PAT: process.env.KVARM_PAT };
    const r = run(process.execPath, [KVARM_BIN, 'checkout', `${OWNER}/${t.repo}`, t.ref, dir], { env });
    const first = r.out.split('\n')[0];
    if (r.code !== 0 || first !== 'source: snapshot') throw new Error(`kvarm checkout did not use the snapshot (exit ${r.code}, ${first}): ${r.err}`);
    const field = (k) => r.out.split('\n').find((l) => l.startsWith(`${k}: `))?.slice(k.length + 2);
    return { ms: r.ms, sha: field('sha'), transferBytes: Number(field('bytes')) };
  },
};

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const round = (x) => Math.round(x * 10) / 10;

async function bench(t) {
  console.log(`# ${t.name}: ${OWNER}/${t.repo}@${t.ref}`);
  const meta = await ensureReady(t.repo, t.ref);
  console.log(`#   snapshot ready: sha ${meta.sha.slice(0, 12)} size ${meta.size} files ${meta.files}`);
  const runs = [];
  for (let i = 1; i <= RUNS; i++) {
    const order = Object.keys(VARIANTS);
    if (i % 2 === 0) order.reverse();
    const dirs = {};
    for (const v of order) {
      const dir = join(work, `${t.name}-${v}-${i}`);
      const r = VARIANTS[v](t, dir);
      if (r.sha !== meta.sha) throw new Error(`${v} produced ${r.sha}, expected ${meta.sha}`);
      dirs[v] = dir;
      const row = { run: i, variant: v, ms: round(r.ms), transferBytes: r.transferBytes, treeBytes: treeBytes(dir) };
      runs.push(row);
      console.log(`#   run ${i} ${v.padEnd(8)} ${String(row.ms).padStart(9)} ms  transfer ${row.transferBytes} B  tree ${row.treeBytes} B`);
    }
    if (i === 1) {
      for (const v of ['clone', 'shallow']) {
        const d = run('diff', ['-r', '-x', '.git', dirs.snapshot, dirs[v]]);
        if (d.code !== 0) throw new Error(`snapshot and ${v} trees differ: ${d.out.slice(0, 500)}`);
      }
      console.log('#   diff -r -x .git: snapshot == clone == shallow');
    }
    for (const dir of Object.values(dirs)) rmSync(dir, { recursive: true, force: true });
  }
  const summary = {};
  for (const v of Object.keys(VARIANTS)) {
    const rows = runs.filter((r) => r.variant === v);
    const ms = rows.map((r) => r.ms);
    summary[v] = { minMs: Math.min(...ms), medianMs: median(ms), maxMs: Math.max(...ms), transferBytes: rows[0].transferBytes, treeBytes: rows[0].treeBytes };
  }
  const { stored, tarBytes, gzipBytes } = await gzipSize(t.repo, meta.sha);
  return {
    target: t.name,
    repo: `${OWNER}/${t.repo}`,
    ref: t.ref,
    sha: meta.sha,
    snapshot: { size: meta.size, stored, tarBytes, gzipBytes, files: meta.files, reused: meta.reused ?? false },
    summary,
    speedup: { vsClone: round(summary.clone.medianMs / summary.snapshot.medianMs), vsShallow: round(summary.shallow.medianMs / summary.snapshot.medianMs) },
    runs,
  };
}

function writeSmallRepo(dir) {
  git(dir, ['init', '-q', '-b', 'main']);
  for (let c = 0; c < 5; c++) {
    for (let i = 0; i < 12; i++) {
      const sub = join(dir, 'src', `mod${i % 4}`);
      mkdirSync(sub, { recursive: true });
      const lines = Array.from({ length: 80 + i * 5 }, (_, n) => `export const v${n} = ${c * 1000 + n}; // ${ts}`);
      writeFileSync(join(sub, `file${c * 12 + i}.ts`), `${lines.join('\n')}\n`);
    }
    writeFileSync(join(dir, 'README.md'), `# bench small repo\n\nrevision ${c} (${ts})\n`);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', `revision ${c}`]);
  }
}

function fmtBytes(n) {
  if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(1)} MiB`;
  if (n >= 1 << 10) return `${(n / (1 << 10)).toFixed(1)} KiB`;
  return `${n} B`;
}

/** "2.5× faster than" / "1.8× slower than" / "about as fast as", comparing medians. */
function relative(snapshotMs, otherMs) {
  const r = otherMs / snapshotMs;
  if (r >= 1.1) return `${r.toFixed(1)}× faster than`;
  if (r <= 1 / 1.1) return `${(1 / r).toFixed(1)}× slower than`;
  return 'about as fast as';
}

function markdown(record) {
  const lines = [
    '# Clone vs snapshot checkout',
    '',
    'Wall time to materialize a ref into an empty directory, from git (`git clone`)',
    'or from a Kvarm tree snapshot (`kvarm checkout`, `apps/cli`). Generated by',
    '`scripts/bench-clone-vs-snapshot.mjs --write`; raw numbers are in',
    '[`clone-vs-snapshot.json`](clone-vs-snapshot.json).',
    '',
    `Measured ${record.measuredAt} against the deployed worker from ${record.host.platform}/${record.host.arch} (${record.host.cpus} CPUs), Node ${record.host.node}, ${record.host.git}, ${record.runs} runs per variant.`,
    '',
    '## Results (median wall time)',
    '',
    '| target | files | tree bytes | `git clone` + checkout | `git clone --depth=1` | `kvarm checkout` (snapshot) | speedup vs clone | speedup vs shallow |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const t of record.targets) {
    const s = t.summary;
    lines.push(`| ${t.target} (\`${t.repo}\`@\`${t.ref}\`) | ${t.snapshot.files} | ${fmtBytes(s.snapshot.treeBytes)} | ${s.clone.medianMs} ms | ${s.shallow.medianMs} ms | ${s.snapshot.medianMs} ms | ${t.speedup.vsClone}× | ${t.speedup.vsShallow}× |`);
  }
  lines.push('', '## Bytes transferred', '', '| target | `git clone` pack | `git clone --depth=1` pack | snapshot tarball |', '| --- | ---: | ---: | ---: |');
  for (const t of record.targets) {
    const s = t.summary;
    lines.push(`| ${t.target} | ${s.clone.transferBytes.toLocaleString('en-US')} B (${fmtBytes(s.clone.transferBytes)}) | ${s.shallow.transferBytes.toLocaleString('en-US')} B (${fmtBytes(s.shallow.transferBytes)}) | ${s.snapshot.transferBytes.toLocaleString('en-US')} B (${fmtBytes(s.snapshot.transferBytes)}) |`);
  }
  lines.push('', '## Observations', '');
  for (const t of record.targets) {
    const s = t.summary;
    const vsShallow = (s.snapshot.transferBytes / s.shallow.transferBytes).toFixed(1);
    const gz = ((t.snapshot.tarBytes ?? t.snapshot.size) / t.snapshot.gzipBytes).toFixed(1);
    lines.push(
      `- **${t.target}:** the snapshot checkout is ${relative(s.snapshot.medianMs, s.clone.medianMs)} a full \`git clone\` + checkout and ${relative(s.snapshot.medianMs, s.shallow.medianMs)} a shallow clone (medians). ` +
        (t.snapshot.stored === 'gzip'
          ? `The tarball is stored gzip-compressed: ${fmtBytes(s.snapshot.transferBytes)} on the wire (${fmtBytes(t.snapshot.tarBytes)} of tar, ${gz}× smaller) versus ${fmtBytes(s.shallow.transferBytes)} for the zlib-compressed shallow pack (${vsShallow}×).`
          : `The tarball is plain ustar served uncompressed: ${fmtBytes(s.snapshot.transferBytes)} on the wire versus ${fmtBytes(s.shallow.transferBytes)} for the zlib-compressed shallow pack (${vsShallow}×). ` +
            `gzip -6 of the same tarball is ${fmtBytes(t.snapshot.gzipBytes)} (${gz}× smaller).`),
    );
  }
  lines.push('', '## All runs', '', '| target | run | variant | wall ms | transfer bytes |', '| --- | ---: | --- | ---: | ---: |');
  for (const t of record.targets) {
    for (const r of t.runs) lines.push(`| ${t.target} | ${r.run} | ${r.variant} | ${r.ms} | ${r.transferBytes} |`);
  }
  lines.push(
    '',
    '## Method',
    '',
    '- **Targets.** `fixture` is the 1M-line bench fixture `<owner>/fixture-1m` at `bench-head`',
    '  (generated by `scripts/fixture-1m.mjs`, record in `fixture-1m.json`; read-only here). Its',
    '  repository also holds the `wide-base`/`wide-head` pair, which a full clone downloads too.',
    '  `small` is a fresh public repo (`m4-cli-checkout-bench-<ts>`) with 5 commits of ~60',
    '  TypeScript-like files on `main`, created by the script and deleted afterwards.',
    '- **Variants.** `clone` = `git clone --no-checkout <url>` then `git checkout <ref>` (what the',
    '  CLI fallback does: full history, every branch). `shallow` = `git clone --depth=1',
    '  --single-branch --branch <ref>`. `snapshot` = `node apps/cli/bin/kvarm.js checkout',
    '  <owner/repo> <ref> <dir>`, which demands the snapshot (`POST …/snapshots/<ref>`, already',
    '  ready), downloads the tarball by commit SHA and extracts it; the run fails unless it prints',
    '  `source: snapshot`.',
    '- **Timing.** Each measurement starts a fresh child process into a new empty directory',
    '  (process start included). The three variants run back to back within a run, in reversed',
    '  order on even runs. Before timing, the script demands each snapshot and waits until it is',
    '  ready, so build time is not part of the snapshot numbers.',
    '- **Bytes.** Snapshot transfer = tarball bytes (equal to the metadata `size`). Git transfer =',
    '  the size of the received pack files under `.git/objects/pack` (protocol framing excluded).',
    '  Tree bytes = regular-file bytes in the checked-out tree, excluding `.git`.',
    '- **Correctness.** On the first run of each target, `diff -r -x .git` between the snapshot,',
    '  the full clone and the shallow clone must be empty, and all three must resolve to the',
    '  same commit SHA.',
    '- **Caveats.** One client host and network path; timings vary with network conditions and',
    '  the serving colo. The snapshot is the tree only: it has no `.git` and no history (see',
    '  `apps/cli/README.md` for attaching history before committing or pushing).',
    '',
    '## Reproduce',
    '',
    '```bash',
    'set -a; . ./.env.local; set +a',
    'node scripts/bench-clone-vs-snapshot.mjs --runs=3 --write',
    '```',
    '',
  );
  return lines.join('\n');
}

if (args.render) {
  writeFileSync(DOC_MD, markdown(JSON.parse(readFileSync(DOC_JSON, 'utf8'))));
  console.log('rewrote docs/benchmarks/clone-vs-snapshot.md from clone-vs-snapshot.json');
  rmSync(work, { recursive: true, force: true });
  process.exit(0);
}
if (!process.env.KVARM_PAT) throw new Error('env KVARM_PAT is not set');

const targets = [];
try {
  if (ONLY.has('fixture')) {
    targets.push(await bench({ name: 'fixture', repo: FIXTURE.repo, ref: FIXTURE.ref, url: `${BASE}/${OWNER}/${FIXTURE.repo}.git` }));
  }
  if (ONLY.has('small')) {
    const repo = `${PREFIX}-bench-${ts}`;
    const res = await withFixtureRepo({ owner: OWNER, repo, prefix: PREFIX, http, keep: args.keep, log: console.log }, async () => {
      const dir = join(work, 'small-src');
      mkdirSync(dir);
      writeSmallRepo(dir);
      git(dir, ['remote', 'add', 'origin', `${BASE}/${OWNER}/${repo}.git`]);
      let p = git(dir, ['push', '-q', 'origin', 'main']);
      for (let i = 0; i < 5 && p.code !== 0 && /503|429|warming/i.test(p.err); i++) {
        await sleep(3000);
        p = git(dir, ['push', '-q', 'origin', 'main']);
      }
      if (p.code !== 0) throw new Error(`push failed: ${p.err}`);
      return bench({ name: 'small', repo, ref: 'main', url: `${BASE}/${OWNER}/${repo}.git` });
    });
    if (!res.ok) throw new Error(res.reason);
    targets.push(res.value);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

const gitVersion = spawnSync('git', ['--version'], { encoding: 'utf8' }).stdout.trim();
const record = {
  measuredAt: new Date().toISOString(),
  runs: RUNS,
  host: { platform: `${platform()} ${release()}`, arch: arch(), cpus: cpus().length, node: process.version, git: gitVersion },
  targets,
};
for (const t of targets) {
  const s = t.summary;
  console.log(`${t.target}: clone ${s.clone.medianMs} ms, shallow ${s.shallow.medianMs} ms, snapshot ${s.snapshot.medianMs} ms (median of ${RUNS}); speedup ${t.speedup.vsClone}x / ${t.speedup.vsShallow}x`);
}
if (args.write) {
  writeFileSync(DOC_JSON, `${JSON.stringify(record, null, 2)}\n`);
  writeFileSync(DOC_MD, markdown(record));
  console.log('wrote docs/benchmarks/clone-vs-snapshot.json and docs/benchmarks/clone-vs-snapshot.md');
}

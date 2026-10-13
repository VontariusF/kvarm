/**
 * The checks-gate (architecture §0.3, invariant 5): the only place merge,
 * queue and composition code learns which checks a tree must pass.
 *
 * Producers (guard, CI) register a factory in CHECKS_PRODUCERS and answer
 * for the exact tree and config identity being published (and, for checks
 * of a change's own edits, the head it publishes). With none registered the
 * required set is empty and its state is `success`, so a merge is gated by
 * mergeability alone. Producers return only checks that are required;
 * non-required runs never reach the gate, and checks quarantined by name
 * (services/flakes.ts) are answered apart, outside the required set.
 */

export type CheckState = 'success' | 'pending' | 'failure';

export interface RequiredCheck {
  name: string;
  state: CheckState;
  /** The producer that declared the check. */
  producer: string;
  /** Producer-specific run id, for links and evidence. */
  runId?: string;
  /**
   * The run passed without inspecting everything it covers (kvarm/guard past
   * its read budgets). The state stays `success`; branch rules that require
   * guard completeness refuse it at publication (architecture §0.3).
   */
  incomplete?: true;
  /** With `incomplete`: how many changed paths went uninspected (a truncated change list adds an unknown number). */
  uninspected?: number;
  /**
   * The check is quarantined (services/flakes.ts): the gate lists it under
   * `quarantined`, never in `required`, so it neither satisfies nor blocks.
   */
  quarantined?: true;
}

export interface RequiredChecks {
  treeSha: string;
  configId: string | null;
  required: RequiredCheck[];
  /** `failure` if any required check failed, else `pending` if any is unfinished, else `success`. */
  state: CheckState;
  /**
   * Quarantined checks with their current state, outside `required` and
   * `state`. Only branch rules that name one still consult it (fail-closed).
   * Absent when there are none.
   */
  quarantined?: RequiredCheck[];
}

export interface ChecksRepo {
  id: string;
}

/**
 * The change head whose content the tree publishes (the merged or composed
 * head). Producers that judge a change's own edits rather than the exact
 * tree (the guard) answer for it; tree-exact producers ignore it.
 */
export interface ChecksSubject {
  /** The change whose edits are being published. */
  changeId: string;
  headSha: string;
  /** The tree the change's guard compared its head against. */
  guardBaseTree: string;
}

export interface ChecksProducer {
  readonly name: string;
  requiredChecksFor(repo: ChecksRepo, treeSha: string, configId: string | null, subject?: ChecksSubject): Promise<Array<Omit<RequiredCheck, 'producer'>>>;
}

export interface ChecksGate {
  requiredChecksFor(repo: ChecksRepo, treeSha: string, configId: string | null, subject?: ChecksSubject): Promise<RequiredChecks>;
}

export type ChecksProducerFactory = (env: Env) => ChecksProducer;

/** Registered producers (services/checks.ts registers the check-run producer behind kvarm/guard). */
export const CHECKS_PRODUCERS: ChecksProducerFactory[] = [];

export function rollupState(checks: readonly { state: CheckState }[]): CheckState {
  if (checks.some((c) => c.state === 'failure')) return 'failure';
  if (checks.some((c) => c.state === 'pending')) return 'pending';
  return 'success';
}

export function checksGate(producers: readonly ChecksProducer[]): ChecksGate {
  return {
    async requiredChecksFor(repo, treeSha, configId, subject) {
      const lists = await Promise.all(
        producers.map(async (p) => (await p.requiredChecksFor(repo, treeSha, configId, subject)).map((c) => ({ ...c, producer: p.name }))),
      );
      const all = lists.flat();
      const required = all.filter((c) => !c.quarantined);
      const quarantined = all.filter((c) => c.quarantined);
      return { treeSha, configId, required, state: rollupState(required), ...(quarantined.length > 0 ? { quarantined } : {}) };
    },
  };
}

/** The gate over every registered producer. */
export function defaultChecksGate(env: Env): ChecksGate {
  return checksGate(CHECKS_PRODUCERS.map((make) => make(env)));
}

/**
 * The provenance panel shared by the commit and change pages (architecture
 * §9 provenance, §11.6), and the evidence badge the review pages put next
 * to a model family. Styles: `.k-prov` and `.k-ev` in public/assets/app.css,
 * built only from the tokens of docs/brand.md.
 *
 * The prompt hash is an opaque identifier: Kvarm never stores prompts, so it
 * links nowhere; a verified record proves the signer bound that hash to the
 * commit, nothing more.
 */

import { html, raw } from '@kvarm/ui';
import type { RejectedCandidate } from '../services/decisions';
import type { EvidenceLevel } from '../services/provenance';
import { panelEmpty, type ProvenancePanel } from '../services/provenancePanel';

const LEVEL_TEXT: Record<EvidenceLevel, string> = {
  declared: 'Asserted by the caller. Nothing binds this record to the credential that submitted it.',
  authenticated: 'Submitted with the credential of the principal it names. Proves who submitted it, not which model ran.',
  verified: 'A trusted execution service signed the repository, submitter, run, model, prompt hash and commit.',
};

/** Why a record is not at a higher level, in words (reason codes from services/provenance.ts). */
const REASON_TEXT: Record<string, string> = {
  'no-signed-evidence': 'No signed evidence from a trusted execution service.',
  'agent-not-submitter': 'The record names a different agent than the one whose token submitted it.',
  'human-submitted-agent-metadata': 'A human credential wrote agent metadata.',
  'no-credential': 'No credential submitted the record.',
  'unknown-key': 'The signing key is not trusted by this repository or instance.',
  'bad-signature': 'The signature does not match the record.',
  'malformed-signature': 'The signature is malformed.',
  'legacy-payload': 'Signed under the retired payload, which binds neither repository nor submitter.',
  'unsignable-field': 'A signed field contains control characters.',
  'evidence-without-model': 'Signed evidence arrived without a model to verify.',
  'evidence-without-prompt-hash': 'Signed evidence arrived without a prompt hash to verify.',
  'note-without-evidence': 'The note on the ref was not written by Kvarm.',
  'no-evidence-record': 'Kvarm holds no evidence record for this note.',
  'evidence-not-recorded': 'Storing the evidence failed when the note was written.',
};

export function reasonText(code: string): string {
  return REASON_TEXT[code] ?? code;
}

/** The evidence label: uppercase HUD text, one quiet tone per level (no heat: evidence is not contention). */
export function evidenceBadge(level: EvidenceLevel | null, title?: string): string {
  if (level === null) return '';
  return html`<span class="k-ev k-ev-${level}" title="${title ?? LEVEL_TEXT[level]}">${level}</span>`;
}

function rejectedItem(r: RejectedCandidate): string {
  if (typeof r === 'string') return html`<li><code>${r}</code></li>`;
  return html`<li><code>${r.id}</code>${r.reason ? raw(html` <span>${r.reason}</span>`) : ''}</li>`;
}

/**
 * The panel, or the empty string when there is neither an attribution nor a
 * decision: absent provenance renders no box at all.
 */
export function provenancePanel(p: ProvenancePanel, opts: { id?: string; heading?: string } = {}): string {
  if (panelEmpty(p)) return '';
  const id = opts.id ?? 'provenance';
  const a = p.attribution;
  const facts = a
    ? html`
      <div class="k-prov-level">
        ${raw(evidenceBadge(a.evidence.level))}
        <p>${LEVEL_TEXT[a.evidence.level]}</p>
      </div>
      <dl class="k-prov-facts">
        <div><dt>Agent</dt><dd>${a.agent}</dd></div>
        <div><dt>Session</dt><dd><code>${a.session}</code></dd></div>
        <div><dt>Prompt hash</dt><dd>${raw(a.promptHash ? html`<code title="An opaque identifier: prompts are never stored">${a.promptHash}</code>` : '<span class="k-prov-none">not recorded</span>')}</dd></div>
        <div><dt>Model</dt><dd>${raw(a.model ? html`<code>${a.model}</code>` : '<span class="k-prov-none">not declared</span>')}</dd></div>
        <div><dt>Recorded by</dt><dd>${a.actor}${a.evidence.tokenKind ? raw(html` <span class="k-prov-none">via ${a.evidence.tokenKind}</span>`) : ''}</dd></div>
        <div><dt>At</dt><dd><time datetime="${a.at}">${a.at.slice(0, 16).replace('T', ' ')} UTC</time></dd></div>
        ${raw(a.evidence.principal ? html`<div><dt>Principal</dt><dd><code>${a.evidence.principal}</code></dd></div>` : '')}
        ${raw(a.evidence.tokenPrefix ? html`<div><dt>Token prefix</dt><dd><code>${a.evidence.tokenPrefix}</code></dd></div>` : '')}
        ${raw(a.evidence.runId ? html`<div><dt>Run</dt><dd><code>${a.evidence.runId}</code></dd></div>` : '')}
        ${raw(a.evidence.keyId ? html`<div><dt>Key</dt><dd><code>${a.evidence.keyId}</code></dd></div>` : '')}
      </dl>
      ${raw(
        a.evidence.reasons.length > 0
          ? html`<div class="k-prov-why"><h3 class="k-prov-sub">Why not higher</h3><ul>${raw(a.evidence.reasons.map((r) => html`<li>${reasonText(r)} <code>${r}</code></li>`).join(''))}</ul></div>`
          : '',
      )}`
    : '';
  const decisions =
    p.decisions.length > 0
      ? html`
      <div class="k-prov-decisions">
        <h3 class="k-prov-sub">Decisions</h3>
        <ol>
          ${raw(
            p.decisions
              .map(
                (d) => html`<li>
              <p class="k-prov-chosen"><span class="k-prov-key">Chosen</span> <code>${d.chosen}</code></p>
              ${raw(d.rejected.length > 0 ? html`<div class="k-prov-rejected"><span class="k-prov-key">Rejected</span><ul>${raw(d.rejected.map(rejectedItem).join(''))}</ul></div>` : '')}
              <p class="k-prov-reason">${d.reason}</p>
              <p class="k-prov-meta">${d.agent ? d.agent.name : d.actor} · <time datetime="${d.at}">${d.at.slice(0, 16).replace('T', ' ')} UTC</time>${d.task ? raw(html` · <code>${d.task}</code>`) : ''}</p>
            </li>`,
              )
              .join(''),
          )}
        </ol>
        ${raw(p.decisionsTruncated ? '<p class="k-prov-none">Older decisions are not shown; <code>get_context</code> pages through all of them.</p>' : '')}
      </div>`
      : '';
  return html`
    <section class="k-prov" id="${id}" aria-labelledby="${id}-h">
      <header class="k-prov-head"><h2 class="k-prov-title" id="${id}-h">${opts.heading ?? 'Provenance'}</h2>${raw(a ? '<span class="k-prov-src">recorded by Kvarm</span>' : '')}</header>
      ${raw(facts)}
      ${raw(decisions)}
    </section>`;
}

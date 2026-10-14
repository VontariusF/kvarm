/**
 * The human review surfaces (issue #8; architecture §0.4, §9, §11.6): the
 * review inbox at `/inbox`, the change page at `/:owner/:repo/changes/:n`
 * and the form posts that approve, request changes and resolve escalations.
 *
 * Thin adapters: the inbox, the review packet, the provenance panel and the
 * decide flow are services (services/reviewInbox.ts, services/reviews.ts,
 * services/provenancePanel.ts). Repository authority is the shared lookup
 * on the page transport, so agent tokens and non-api PATs act as anonymous
 * and a repository the viewer cannot see answers 404.
 *
 * Every form carries the session's CSRF token, and every POST checks it
 * (sessionFormRefused) right after reading the body and before any write
 * (architecture §11.1); bearer callers need none.
 *
 * Escaping convention: user data is interpolated bare into html`` (escaped
 * once); composed fragments and pre-encoded URLs go through raw().
 */

import { Hono, type Context } from 'hono';
import { html, raw, timeAgo } from '@kvarm/ui';
import { listReposForOwner, type RepoRow } from '../db/repos';
import { appLayout, csrfInput } from '../web/render';
import { evidenceBadge, provenancePanel } from '../render/provenance';
import { clientIp, requestCredential, requestSession, type ApiActor, type App } from './api';
import { notFound, resolveRepo, sessionFormRefused, type Resolved } from './repoPages';
import { resolvePageActor, resolveRepoAccess } from '../services/access';
import { changeView, parseNumber, readChange, type ChangeContext } from '../services/changes';
import { commitProvenance } from '../services/provenancePanel';
import { decideFromPage, INBOX_LIMITS, reviewInbox, type InboxItem, type InboxReason, type PageDecision } from '../services/reviewInbox';
import { getReviewPacket, staleApprovals, type EscalationView, type ReviewPacket, type ReviewView } from '../services/reviews';

/** Mounted at `/inbox`, ahead of the generic web routes. */
export const inboxPages = new Hono<App>();
/** Mounted at `/:owner/:repo`. */
export const reviewPages = new Hono<App>();

const HTML = { 'content-type': 'text/html; charset=utf-8' };

const REASON_LABEL: Record<InboxReason, string> = {
  'reviewer-disagreement': 'Reviewers disagree',
  'review-blocked': 'Changes requested',
  'protected-path': 'Protected target',
  'final-selection': 'Arena final selection',
  'approvals-required': 'Awaiting approval',
};

const REASON_HELP: Record<InboxReason, string> = {
  'reviewer-disagreement': 'One reviewer approved the head another asked to change. A human settles it.',
  'review-blocked': 'A reviewer asked for changes. Approve the head to overrule, or resolve with a note.',
  'protected-path': 'The change targets a protected branch. A human signs off before it can publish.',
  'final-selection': 'An arena picked this change as its winner. Confirm the pick before it publishes.',
  'approvals-required': 'The review policy wants more approving reviews of the current head.',
};

/** Outcome and error codes a decide post redirects with; anything else reads as a generic failure. */
const DONE_TEXT: Record<string, string> = {
  approve: 'Approved. The decision and your note are on the record.',
  'request-changes': 'Changes requested. The decision and your note are on the record.',
  resolve: 'Escalation resolved. The decision and your note are on the record.',
  acknowledge: 'Escalation acknowledged. The decision and your note are on the record.',
};

const ERROR_TEXT: Record<string, string> = {
  NOTE_REQUIRED: 'Add a note: every decision records why.',
  INVALID_NOTE: `Keep the note under ${INBOX_LIMITS.noteMax} characters.`,
  HEAD_MOVED: 'The head moved since this page loaded. Review the new head.',
  SELF_REVIEW: 'You authored this change, so another principal has to review it.',
  CHANGE_NOT_OPEN: 'The change is no longer open.',
  NO_HEAD: 'The change has no head commit yet.',
  ESCALATION_RESOLVED: 'Someone already resolved that escalation.',
  ESCALATION_NOT_FOUND: 'That escalation no longer exists.',
  INVALID_VERDICT: 'Pick approve or request changes.',
  DECISION_NOT_RECORDED: 'Your review landed, but storing the decision record failed. Record it with record_decision.',
};

const short = (sha: string | null): string => (sha ? sha.slice(0, 10) : '—');
const repoBase = (owner: string, name: string): string => `/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
const changeHref = (owner: string, name: string, n: number): string => `${repoBase(owner, name)}/changes/${n}`;
const compareHref = (owner: string, name: string, base: string, head: string | null): string =>
  `${repoBase(owner, name)}/compare/${encodeURIComponent(`${base}...${head ?? base}`)}`;

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: HTML });
}

async function csrfField(c: Context<App>): Promise<string> {
  return csrfInput((await requestSession(c))?.csrfToken);
}

/** An unparseable body reads as an empty form, which a session post then fails for its missing token. */
async function readForm(c: Context<App>): Promise<Record<string, unknown>> {
  return (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>;
}

function flash(c: Context<App>): string {
  const done = c.req.query('done');
  const error = c.req.query('error');
  if (done && DONE_TEXT[done]) return html`<div class="k-note signal" role="status">${DONE_TEXT[done]}</div>`;
  if (error) {
    return html`<div class="k-note risk" role="alert">${ERROR_TEXT[error] ?? 'The decision was not recorded.'} <code>${error}</code></div>`;
  }
  return '';
}

function reviewer(r: ReviewView): string {
  return r.reviewer.agent ? r.reviewer.agent.name : r.reviewer.login;
}

function verdictTag(r: ReviewView): string {
  return r.verdict === 'approve' ? '<span class="tag tag-approved">approve</span>' : '<span class="tag tag-failed">request changes</span>';
}

function familyLabel(family: string | null, evidence: ReviewView['modelFamilyEvidence']): string {
  if (!family) return '<span class="k-prov-none">family not declared</span>';
  return html`<code>${family}</code> ${raw(evidenceBadge(evidence))}`;
}

function staleTag(r: ReviewView, stale: ReadonlySet<ReviewView>): string {
  return !stale.has(r) ? '' : html`<span class="tag tag-stale" title="Reviewed ${short(r.headSha)}; the head has moved, so this no longer counts">stale · ${short(r.headSha)}</span>`;
}

function noteField(id: string, label: string): string {
  return html`
    <div class="k-field">
      <label for="${id}">${label} <span class="k-req">required</span></label>
      <textarea id="${id}" name="note" rows="3" required maxlength="${INBOX_LIMITS.noteMax}" placeholder="Why: this note becomes the decision's reason."></textarea>
    </div>`;
}

function reviewForm(owner: string, name: string, n: number, headSha: string | null, csrf: string, back: 'inbox' | 'change', idBase: string): string {
  return html`
    <form class="k-decide-form" method="post" action="${raw(`${changeHref(owner, name, n)}/review`)}">
      ${raw(csrf)}
      <input type="hidden" name="headSha" value="${headSha ?? ''}" />
      <input type="hidden" name="back" value="${back}" />
      ${raw(noteField(`${idBase}-review`, `Review note for ${short(headSha)}`))}
      <div class="actions">
        <button class="btn btn-primary" type="submit" name="verdict" value="approve">Approve head</button>
        <button class="btn" type="submit" name="verdict" value="request-changes">Request changes</button>
      </div>
    </form>`;
}

function resolveForm(owner: string, name: string, n: number, e: EscalationView, csrf: string, back: 'inbox' | 'change', idBase: string): string {
  return html`
    <form class="k-decide-form" method="post" action="${raw(`${changeHref(owner, name, n)}/escalations/${encodeURIComponent(e.id)}/resolve`)}">
      ${raw(csrf)}
      <input type="hidden" name="back" value="${back}" />
      ${raw(noteField(`${idBase}-${e.id}`, `Resolution note: ${REASON_LABEL[e.reason]}`))}
      <div class="actions">
        <button class="btn btn-primary" type="submit" name="resolution" value="resolve">Resolve</button>
        <button class="btn" type="submit" name="resolution" value="acknowledge">Acknowledge</button>
      </div>
    </form>`;
}

function pageHead(eyebrow: string, title: string, accent: string, human: string, agent: string, kpis: Array<{ label: string; value: string | number; warn?: boolean }>): string {
  const stats = kpis.map((k) => html`<div><span class="hud">${k.label}</span><b class="${k.warn ? 'warn' : ''}">${k.value}</b></div>`).join('');
  return html`
    <header class="k-head">
      <div class="k-head-copy">
        <span class="hud">${eyebrow}</span>
        <h1>${title}${raw(accent ? html`<br /><span class="ink">${accent}</span>` : '')}</h1>
        <p class="lede m-human">${human}</p>
        <p class="lede m-agent k-mono">${agent}</p>
      </div>
      <div class="k-head-side"><div class="k-kpis">${raw(stats)}</div></div>
    </header>`;
}

// ---------------------------------------------------------------------------
// Inbox
// ---------------------------------------------------------------------------

/** The author answers to reviewers, not for them: a change's own author gets no resolve form. */
function mayResolve(authorPrincipal: string | null, viewerId: string): boolean {
  return authorPrincipal !== `user:${viewerId}`;
}

function inboxItem(item: InboxItem, csrf: string, viewerId: string): string {
  const { owner, name } = item.repo;
  const idBase = `c-${item.id}`;
  const escalation = item.reasons[0] !== 'approvals-required';
  const reasonTags = item.reasons
    .map((r) => html`<span class="tag ${r === 'approvals-required' ? 'tag-await' : 'tag-pending'}">${REASON_LABEL[r]}</span>`)
    .join('');
  const stale = new Set(staleApprovals(item.reviews));
  const verdicts = item.reviews.length
    ? html`<ul class="k-verdicts" aria-label="Verdicts">${raw(
        item.reviews
          .map((r) => html`<li><b>${reviewer(r)}</b> ${raw(verdictTag(r))} ${raw(familyLabel(r.modelFamily, r.modelFamilyEvidence))} ${raw(staleTag(r, stale))}</li>`)
          .join(''),
      )}</ul>`
    : '<p class="k-inbox-quiet">No reviews of any head yet.</p>';
  const author = item.author.agent
    ? html`${item.author.agent.name} ${raw(familyLabel(item.author.modelFamily, item.author.modelFamilyEvidence))}`
    : html`${item.author.login ?? 'unknown'}`;
  return html`
    <article class="k-inbox-item ${escalation ? 'heat' : 'signal'}" id="${idBase}">
      <div class="k-inbox-body">
        <span class="hud">${owner}/${name} · #${item.number} · into ${item.base} · ${timeAgo(item.createdAtMs)}</span>
        <h3><a href="${raw(changeHref(owner, name, item.number))}">${item.title}</a></h3>
        <p class="k-inbox-tags">${raw(reasonTags)}<span class="tag">approvals ${item.approvals.count}/${item.approvals.required}</span>${raw(
          item.approvals.humansRequired ? html`<span class="tag">human ${item.approvals.humans}/${item.approvals.humansRequired}</span>` : '',
        )}${raw(
          item.staleApprovals ? html`<span class="tag tag-stale">${item.staleApprovals} stale</span>` : '',
        )}</p>
        <p class="k-inbox-author">By ${raw(author)} · head <code>${short(item.headSha)}</code></p>
        ${raw(verdicts)}
        <p class="k-inbox-links">
          <a href="${raw(changeHref(owner, name, item.number))}">Open change</a>
          <a href="${raw(compareHref(owner, name, item.base, item.headSha))}">Risk-ordered diff</a>
          <a href="${raw(`${changeHref(owner, name, item.number)}#verdicts`)}">All verdicts</a>
        </p>
        <details class="k-decide">
          <summary class="btn btn-sm">Decide</summary>
          <div class="k-decide-body">
            ${raw(mayResolve(item.author.principal, viewerId) ? item.openEscalations.map((e) => resolveForm(owner, name, item.number, e, csrf, 'inbox', idBase)).join('') : '')}
            ${raw(reviewForm(owner, name, item.number, item.headSha, csrf, 'inbox', idBase))}
          </div>
        </details>
      </div>
    </article>`;
}

inboxPages.get('/', async (c) => {
  const actor = await resolvePageActor(c.env, await requestCredential(c), clientIp(c));
  if (!actor) return c.redirect('/auth/sign-in?returnTo=%2Finbox');
  const [r, repos] = await Promise.all([
    reviewInbox(c.env, actor, { limit: c.req.query('limit'), cursor: c.req.query('cursor') }),
    listReposForOwner(c.env.DB, actor.user.login, 8),
  ]);
  const layout = (body: string) =>
    appLayout(c.env, { title: 'Inbox', userLogin: actor.user.login, userId: actor.user.id, repos: repos.map((x) => ({ ownerLogin: x.owner_login, name: x.name })), active: 'inbox' }, body);
  if (!r.ok) {
    return htmlResponse(await layout(html`<div class="k-content"><div class="k-note risk" role="alert">${r.error} <code>${r.code}</code></div><p><a href="/inbox">Back to the inbox</a></p></div>`), r.status);
  }
  const inbox = r.value;
  const csrf = await csrfField(c);
  const waiting = inbox.counts.changes;
  const head = pageHead(
    'INBOX · NEEDS A HUMAN',
    waiting ? `${waiting} CHANGE${waiting === 1 ? '' : 'S'}` : 'INBOX',
    waiting ? 'NEED YOU.' : 'CLEAR.',
    'Escalations and approvals across every repository you can review. Each decision takes a note, and the note goes on the record.',
    `kvarm review pending --repo <owner/repo> · ${inbox.counts.escalations} escalation · ${inbox.counts.awaitingApproval} awaiting approval`,
    [
      { label: 'Escalations', value: inbox.counts.escalations, warn: inbox.counts.escalations > 0 },
      { label: 'Awaiting approval', value: inbox.counts.awaitingApproval },
      { label: 'Stale approvals', value: inbox.counts.staleApprovals, warn: inbox.counts.staleApprovals > 0 },
      { label: 'Repositories', value: inbox.repositories },
    ],
  );
  const truncated = inbox.truncated
    ? html`<div class="k-note warn" role="note">Showing the ${INBOX_LIMITS.reposMax} most recently pushed repositories you can review; others are not scanned on this page.</div>`
    : '';
  const groups = inbox.groups
    .map(
      (g) => html`
      <section class="panel" aria-labelledby="g-${g.reason}">
        <div class="panel-head"><h2 class="hud k-panel-title" id="g-${g.reason}">${REASON_LABEL[g.reason]} · <b>${g.items.length}</b></h2></div>
        <p class="k-group-help">${REASON_HELP[g.reason]}</p>
        ${raw(g.items.map((i) => inboxItem(i, csrf, actor.user.id)).join(''))}
      </section>`,
    )
    .join('');
  const empty = html`
    <section class="panel">
      <div class="panel-head"><h2 class="hud k-panel-title">NOTHING WAITING</h2></div>
      <div class="k-empty">
        <p class="m-human">Nothing needs a human right now. When reviewers disagree, ask for changes, or a protected branch needs sign-off, the change lands here.</p>
        <pre class="k-term m-agent"><code>kvarm review pending --repo &lt;owner/repo&gt;
kvarm review approve &lt;number&gt; --repo &lt;owner/repo&gt;</code></pre>
      </div>
    </section>`;
  const pager = inbox.nextCursor
    ? html`<nav class="k-pager" aria-label="Inbox pages"><a class="btn" href="${`/inbox?cursor=${encodeURIComponent(inbox.nextCursor)}${c.req.query('limit') ? `&limit=${encodeURIComponent(c.req.query('limit')!)}` : ''}`}">Older changes</a></nav>`
    : c.req.query('cursor')
      ? '<nav class="k-pager" aria-label="Inbox pages"><a class="btn" href="/inbox">Back to newest</a></nav>'
      : '';
  const body = html`
    ${raw(head)}
    <div class="k-content">
      ${raw(flash(c))}
      ${raw(truncated)}
      ${raw(
        groups ||
          (inbox.nextCursor
            ? '<div class="k-note signal" role="status">None of the changes scanned for this page needs you. Older changes are still to check.</div>'
            : c.req.query('cursor')
              ? '<div class="k-empty">No older changes need you.</div>'
              : empty),
      )}
      ${raw(pager)}
    </div>`;
  return htmlResponse(await layout(body));
});

// ---------------------------------------------------------------------------
// Change page
// ---------------------------------------------------------------------------

async function changeShell(c: Context<App>, resolved: Resolved, title: string, body: string, status = 200): Promise<Response> {
  const repo = resolved.repo;
  const base = repoBase(repo.owner_login, repo.name);
  const tabs: Array<[string, string]> = [
    ['Code', `${base}/tree/${encodeURIComponent(repo.default_branch || 'main')}`],
    ['Commits', `${base}/commits?ref=${encodeURIComponent(repo.default_branch || 'main')}`],
    ['Compare', `${base}/compare`],
    ['Activity', `${base}/activity`],
    ['Train', `${base}/train`],
  ];
  const tabLinks = tabs.map(([label, href]) => html`<a class="k-tab" href="${raw(href)}">${label}</a>`).join('');
  const viewer = resolved.viewer;
  const owned = viewer ? await listReposForOwner(c.env.DB, viewer.user.login, 8) : [];
  const page = await appLayout(
    c.env,
    {
      title,
      userLogin: viewer?.user.login ?? null,
      userId: viewer?.user.id,
      repos: owned.map((r) => ({ ownerLogin: r.owner_login, name: r.name })),
    },
    html`
      <div class="k-repo-head"><span class="hud">REPOSITORY</span><a href="${raw(base)}">${repo.owner_login}/${repo.name}</a><span class="k-visibility">${repo.visibility}</span></div>
      <nav class="k-tabs" aria-label="Repository">${raw(tabLinks)}</nav>
      ${raw(body)}`,
  );
  return htmlResponse(page, status);
}

function verdictRows(reviews: ReviewView[]): string {
  const stale = new Set(staleApprovals(reviews));
  return reviews
    .map(
      (r) => html`<tr class="${r.current ? '' : 'k-row-stale'}">
        <td><b>${reviewer(r)}</b><small>${r.reviewer.kind}</small></td>
        <td>${raw(verdictTag(r))} ${raw(staleTag(r, stale))}</td>
        <td>${raw(familyLabel(r.modelFamily, r.modelFamilyEvidence))}${raw(r.differentFamily ? html`<small>differs from the author's · ${r.differentFamilyEvidence ?? ''}</small>` : '')}</td>
        <td class="k-cell-sha"><code>${short(r.headSha)}</code></td>
        <td class="k-cell-note">${r.body ?? ''}</td>
      </tr>`,
    )
    .join('');
}

function escalationBlock(owner: string, name: string, packet: ReviewPacket, e: EscalationView, csrf: string, canDecide: boolean): string {
  const open = e.state === 'open';
  return html`
    <div class="k-inbox-item ${open ? 'heat' : 'quiet'}">
      <div class="k-inbox-body">
        <span class="hud">${REASON_LABEL[e.reason]} · ${e.state} · opened ${timeAgo(Date.parse(e.openedAt))}${e.openedBy ? ` by ${e.openedBy}` : ''}</span>
        ${raw(e.detail ? html`<p>${e.detail}</p>` : '')}
        ${raw(!open ? html`<p class="k-inbox-quiet">${e.resolution ?? 'resolved'} by ${e.resolvedBy ?? 'unknown'}${e.note ? raw(html`: ${e.note}`) : ''}</p>` : '')}
        ${raw(open && canDecide ? resolveForm(owner, name, packet.number, e, csrf, 'change', `e`) : '')}
      </div>
    </div>`;
}

reviewPages.get('/changes/:number', async (c) => {
  const resolved = await resolveRepo(c);
  if (!resolved) return notFound(c);
  const number = parseNumber(c.req.param('number'));
  if (number === null) return notFound(c);
  const repo = resolved.repo;
  const [row, packetResult] = await Promise.all([readChange(c.env, repo.id, number), getReviewPacket(c.env, repo, String(number))]);
  if (!packetResult.ok && packetResult.status !== 404) {
    return changeShell(c, resolved, 'Change unavailable', html`<div class="k-content"><div class="k-note risk" role="alert">${packetResult.error} <code>${packetResult.code}</code></div></div>`, packetResult.status);
  }
  if (!row || !packetResult.ok) return notFound(c);
  const packet = packetResult.value;
  // The packet's head is the one the gate and verdicts describe; the panel follows it.
  const change = { ...changeView(row), headSha: packet.headSha };
  const panel = await commitProvenance(c.env, repo, packet.headSha, { admin: resolved.role === 'admin', change: number });
  const live = packet.state === 'open' || packet.state === 'conflicted';
  const canDecide = live && resolved.viewer !== null && (resolved.role === 'write' || resolved.role === 'admin');
  const canResolve = canDecide && mayResolve(packet.author.principal, resolved.viewer!.user.id);
  const csrf = canDecide ? await csrfField(c) : '';
  const owner = repo.owner_login;
  const stale = staleApprovals(packet.reviews);
  const openEscalations = packet.escalations.filter((e) => e.state === 'open');
  const author = packet.author.agent
    ? html`${packet.author.agent.name} ${raw(familyLabel(packet.author.modelFamily, packet.author.modelFamilyEvidence))}`
    : html`${packet.author.login ?? 'unknown'}`;
  const head = pageHead(
    `CHANGE #${packet.number} · ${packet.state.toUpperCase()} · ${packet.mergePolicy.toUpperCase()}`,
    change.title,
    '',
    `${change.author ?? 'Someone'} wants to merge ${change.head} into ${change.base}.`,
    `kvarm review get ${packet.number} --repo ${owner}/${repo.name} · head ${packet.headSha ?? 'none'}`,
    [
      { label: 'Approvals', value: `${packet.approvals.count}/${packet.approvals.required}` },
      { label: 'Human', value: `${packet.approvals.humans}/${packet.approvals.humansRequired}` },
      { label: 'Escalations', value: openEscalations.length, warn: openEscalations.length > 0 },
      { label: 'Stale', value: stale.length, warn: stale.length > 0 },
    ],
  );
  const gate = packet.satisfied
    ? html`<div class="k-note signal">Nothing in the review gate blocks head <code>${short(packet.headSha)}</code>.</div>`
    : html`<div class="k-note warn"><b>The review gate blocks this head.</b>${raw(packet.blockers.map((b) => html`<p>${b.error}</p>`).join(''))}</div>`;
  const staleNote = stale.length
    ? html`<div class="k-note warn" role="note">${stale.length} approval${stale.length === 1 ? '' : 's'} went stale when the head moved to <code>${short(packet.headSha)}</code>. They no longer count; the current head needs its own review.</div>`
    : '';
  const verdicts = html`
    <section class="panel" id="verdicts" aria-labelledby="verdicts-h">
      <div class="panel-head"><h2 class="hud k-panel-title" id="verdicts-h">VERDICTS · <b>${packet.reviews.length}</b></h2><span class="hud">BOUND TO THE EXACT HEAD</span></div>
      ${raw(
        packet.reviews.length
          ? html`<div class="tscroll"><table class="table"><thead><tr><th scope="col">Reviewer</th><th scope="col">Verdict</th><th scope="col">Model family</th><th scope="col">Head</th><th scope="col">Note</th></tr></thead><tbody>${raw(verdictRows(packet.reviews))}</tbody></table></div>`
          : '<div class="k-empty">No one has reviewed this change yet.</div>',
      )}
    </section>`;
  const escalations = packet.escalations.length
    ? html`<section class="panel" aria-labelledby="esc-h"><div class="panel-head"><h2 class="hud k-panel-title" id="esc-h">ESCALATIONS · <b>${openEscalations.length}</b> OPEN</h2></div>${raw(
        packet.escalations.map((e) => escalationBlock(owner, repo.name, packet, e, csrf, canResolve)).join(''),
      )}</section>`
    : '';
  const decide = canDecide
    ? html`<section class="panel" aria-labelledby="decide-h"><div class="panel-head"><h2 class="hud k-panel-title" id="decide-h">YOUR REVIEW</h2><span class="hud">HEAD ${short(packet.headSha)}</span></div><div class="k-form-body">${raw(
        reviewForm(owner, repo.name, packet.number, packet.headSha, csrf, 'change', 'd'),
      )}</div></section>`
    : '';
  const links = html`
    <section class="panel" aria-labelledby="links-h">
      <div class="panel-head"><h2 class="hud k-panel-title" id="links-h">READ THE CHANGE</h2></div>
      <ul class="k-list">
        <li><span class="k-ag">Δ</span><div><b><a href="${raw(compareHref(owner, repo.name, change.base, change.headSha))}">Risk-ordered diff</a></b><small>${change.base}…${short(change.headSha)}</small></div><span></span></li>
        ${raw(change.headSha ? html`<li><span class="k-ag">H</span><div><b><a href="${raw(`${repoBase(owner, repo.name)}/commit/${change.headSha}`)}">Head commit</a></b><small>${change.headSha}</small></div><span></span></li>` : '')}
        <li><span class="k-ag">A</span><div><b>Author</b><small>${raw(author)}</small></div><span></span></li>
      </ul>
    </section>`;
  const body = html`
    ${raw(head)}
    <div class="k-grid">
      <div class="k-col">
        ${raw(flash(c))}
        ${raw(gate)}
        ${raw(staleNote)}
        ${raw(escalations)}
        ${raw(verdicts)}
        ${raw(decide)}
      </div>
      <div class="k-col">
        ${raw(provenancePanel(panel, { heading: `Provenance · head ${short(change.headSha)}` }))}
        ${raw(links)}
      </div>
    </div>`;
  return changeShell(c, resolved, `#${packet.number} ${change.title}`, body);
});

// ---------------------------------------------------------------------------
// Decide posts
// ---------------------------------------------------------------------------

/** Write authority with the branch rules the review service's auto merge needs, on the page transport. */
async function writeAccess(c: Context<App>): Promise<{ cx: ChangeContext; actor: ApiActor } | null> {
  const access = await resolveRepoAccess(c.env, {
    owner: c.req.param('owner') ?? '',
    name: c.req.param('repo') ?? '',
    need: 'write',
    transport: 'page',
    credential: await requestCredential(c),
    clientIp: clientIp(c),
    rejectedCredentialAsAnonymous: true,
    branchRules: true,
  });
  if (!access.ok || !access.actor) return null;
  return {
    actor: access.actor,
    cx: { env: c.env, repo: access.repo, actor: access.actor, branchRules: access.branchRules ?? [], waitUntil: (p) => c.executionCtx.waitUntil(p) },
  };
}

/** Back to the inbox entry or the change page; the target is built here, never taken from the form. */
function afterDecision(c: Context<App>, repo: RepoRow, number: string, form: Record<string, unknown>, outcome: { done: string } | { error: string }): Response {
  const query = 'done' in outcome ? `done=${encodeURIComponent(outcome.done)}` : `error=${encodeURIComponent(outcome.error)}`;
  const target = form.back === 'inbox' ? `/inbox?${query}` : `${changeHref(repo.owner_login, repo.name, Number(number))}?${query}`;
  return c.redirect(target, 303);
}

async function decide(c: Context<App>, toDecision: (form: Record<string, unknown>) => PageDecision | null, label: (d: PageDecision) => string): Promise<Response> {
  const w = await writeAccess(c);
  if (!w) return notFound(c);
  const form = await readForm(c);
  const refused = await sessionFormRefused(c, w.actor, form);
  if (refused) return refused;
  const number = c.req.param('number') ?? '';
  if (parseNumber(number) === null) return notFound(c);
  const d = toDecision(form);
  if (!d) return afterDecision(c, w.cx.repo, number, form, { error: 'INVALID_VERDICT' });
  const r = await decideFromPage(w.cx, number, d, form.note);
  if (!r.ok) {
    if (r.code === 'CHANGE_NOT_FOUND') return notFound(c);
    return afterDecision(c, w.cx.repo, number, form, { error: r.code ?? 'FAILED' });
  }
  if (!r.value.decision) return afterDecision(c, w.cx.repo, number, form, { error: 'DECISION_NOT_RECORDED' });
  return afterDecision(c, w.cx.repo, number, form, { done: label(d) });
}

reviewPages.post('/changes/:number/review', (c) =>
  decide(
    c,
    (form) => {
      const verdict = form.verdict === 'approve' || form.verdict === 'request-changes' ? form.verdict : null;
      if (!verdict) return null;
      const headSha = typeof form.headSha === 'string' && form.headSha.length > 0 ? form.headSha : null;
      return { kind: 'review', verdict, headSha };
    },
    (d) => (d.kind === 'review' ? d.verdict : 'resolve'),
  ),
);

reviewPages.post('/changes/:number/escalations/:id/resolve', (c) =>
  decide(
    c,
    (form) => ({ kind: 'resolve', escalationId: c.req.param('id') ?? '', resolution: form.resolution === 'acknowledge' ? 'acknowledge' : 'resolve' }),
    (d) => (d.kind === 'resolve' ? d.resolution : 'resolve'),
  ),
);

/**
 * Streaming-ready HTML shell. One static stylesheet (zero-runtime CSS, the
 * GitHub CSS-modules lesson applied from day one); critical CSS is inlined
 * so first paint never blocks on a round-trip. Kept intentionally small.
 */

import { escapeHtml, html, raw } from '@kvarm/ui';
import { siteName } from '../config';
import { cachedInboxCount, type InboxCount } from '../services/inboxCount';

const CRITICAL_CSS = raw(`
:root{--bg:#0d1117;--bg-raised:#161b22;--bg-inset:#010409;--border:#30363d;--fg:#e6edf3;--fg-muted:#9198a1;--accent:#3fb950;--danger:#f85149;--link:#58a6ff;--radius:6px;--mono:ui-monospace,'SF Mono',Menlo,Consolas,monospace}
*{box-sizing:border-box}html,body{margin:0;padding:0;background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif}
a{color:var(--link);text-decoration:none}a:hover{text-decoration:underline}
.wrap{max-width:1012px;margin:0 auto;padding:16px}
.topbar{border-bottom:1px solid var(--border);background:var(--bg-raised)}
.topbar .wrap{display:flex;align-items:center;gap:12px;padding-top:10px;padding-bottom:10px}
.brand{font-weight:700;color:var(--fg)}
.spacer{flex:1}
.card{border:1px solid var(--border);border-radius:var(--radius);background:var(--bg-raised);padding:16px;margin:12px 0}
.btn{display:inline-block;background:#21262d;border:1px solid var(--border);border-radius:var(--radius);color:var(--fg);padding:5px 14px;font-size:14px;cursor:pointer}
.btn:hover{background:#30363d}
.btn.primary{background:var(--accent-fg,#1f6feb);border-color:#1f6feb;color:#fff}
input[type=text],input[type=url],select{width:100%;background:var(--bg-inset);border:1px solid var(--border);border-radius:var(--radius);color:var(--fg);padding:6px 10px;font-size:14px}
label{display:block;font-size:12px;color:var(--fg-muted);margin:10px 0 4px}
.muted{color:var(--fg-muted)}
pre{background:var(--bg-inset);border:1px solid var(--border);border-radius:var(--radius);padding:12px;overflow:auto}
code{font-family:var(--mono);font-size:12px}
.repo-row{display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid var(--border)}
.repo-row:last-child{border-bottom:0}
.badge{border:1px solid var(--border);border-radius:20px;padding:0 8px;font-size:11px;color:var(--fg-muted)}
.flash{border:1px solid var(--border);border-radius:var(--radius);padding:10px 14px;margin:12px 0}
.flash.ok{border-color:#238636;color:#3fb950}
.flash.err{border-color:var(--danger);color:var(--danger)}
.signout{display:inline;margin:0}
.linklike{background:none;border:0;padding:0;color:var(--link);font:inherit;cursor:pointer}
.linklike:hover{text-decoration:underline}
`);

export interface PageOptions {
  title?: string;
  /** Signed-in login, when present. */
  userLogin?: string | null;
  /** Extra <head> content. */
  head?: string;
  /** Inline script module source (deferred). */
  script?: string;
}

function publicOrigin(env: Env): string | null {
  const configured = env.APP_ORIGIN?.trim();
  if (!configured) return null;
  try {
    const url = new URL(configured);
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** Hidden CSRF field for a session's state-changing forms; empty without a session. */
export function csrfInput(token: string | null | undefined): string {
  return token ? `<input type="hidden" name="_csrf" value="${escapeHtml(token)}" />` : '';
}

export function layout(env: Env, opts: PageOptions, body: string): string {
  const name = siteName(env);
  const origin = publicOrigin(env);
  const previewImage = origin ? `${origin}/assets/brand/og.png` : null;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(opts.title ? `${opts.title} · ${name}` : name)}</title>
<style>${CRITICAL_CSS.value}</style>
<link rel="stylesheet" href="/assets/app.css">
<link rel="icon" href="/favicon.ico" sizes="32x32">
<link rel="icon" href="/assets/brand/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/assets/brand/apple-touch-icon.png">
<link rel="manifest" href="/assets/brand/site.webmanifest">
<meta name="theme-color" content="#050608">
${previewImage ? `<meta property="og:image" content="${escapeHtml(previewImage)}">
` : ''}
${opts.head ?? ''}
${opts.script ? `<script type="module" defer>${opts.script}</script>` : ''}
</head>
<body>
<header class="topbar">
  <div class="wrap">
    <a class="brand" href="/">${escapeHtml(name)}</a>
    <span class="spacer"></span>
    ${
      opts.userLogin
        ? `<a href="/${escapeHtml(opts.userLogin)}">${escapeHtml(opts.userLogin)}</a>
           <a href="/inbox">Inbox</a>
           <a href="/fleet">Fleet</a>
           <a href="/settings/tokens">Tokens</a>
           <a href="/auth/logout">Sign out</a>`
        : '<a href="/auth/login">Sign in</a>'
    }
  </div>
</header>
<main class="wrap">
${body}
</main>
</body>
</html>`;
}

export interface AppLayoutOptions extends PageOptions {
  userId?: string | null;
  /** Pending sandbox approvals; the badge adds the review inbox count. */
  needsYouCount?: number;
  /** The review inbox count, when the page just computed it (/inbox); otherwise the remembered one is read. */
  inboxCount?: InboxCount | null;
  runningCount?: number;
  repos?: Array<{ ownerLogin: string; name: string }>;
  active?: 'home' | 'inbox' | 'fleet' | 'tokens';
}

export async function appLayout(env: Env, opts: AppLayoutOptions, body: string): Promise<string> {
  const login = opts.userLogin ?? '';
  let needsYouCount = opts.needsYouCount ?? 0;
  let runningCount = opts.runningCount ?? 0;
  // Changes waiting for review join sandbox approvals: both need this human (services/inboxCount.ts).
  const inboxRead = opts.inboxCount !== undefined ? Promise.resolve(opts.inboxCount) : opts.userId ? cachedInboxCount(opts.userId) : Promise.resolve(null);
  if (opts.userId && (opts.needsYouCount === undefined || opts.runningCount === undefined)) {
    const counts = await env.DB.prepare(
      `SELECT
        (SELECT COUNT(*) FROM sandboxes
         WHERE owner_user_id = ? AND status IN ('running', 'starting')) AS running,
        (SELECT COUNT(*) FROM sandbox_approvals a
         JOIN sandboxes s ON s.id = a.sandbox_id
         WHERE s.owner_user_id = ? AND a.status = 'pending' AND a.expires_at > ?) AS approvals`,
    )
      .bind(opts.userId, opts.userId, Date.now())
      .first<{ running: number; approvals: number }>();
    if (opts.runningCount === undefined) runningCount = Number(counts?.running ?? 0);
    if (opts.needsYouCount === undefined) needsYouCount = Number(counts?.approvals ?? 0);
  }
  const inbox = await inboxRead;
  const inboxWaiting = inbox?.count ?? 0;
  // `more` qualifies a counted page; with nothing counted it says nothing.
  const plus = inboxWaiting > 0 && inbox?.more ? '+' : '';
  const badge = `${needsYouCount + inboxWaiting}${plus}`;
  const badgeHref = inboxWaiting > 0 ? '/inbox' : '/fleet#approvals';
  const badgeTitle = `${inboxWaiting}${plus} change(s) to review · ${needsYouCount} sandbox approval(s)`;
  const repos = opts.repos ?? [];
  const repoLinks = repos
    .map(
      (repo) =>
        html`<a href="${raw(`/${encodeURIComponent(repo.ownerLogin)}/${encodeURIComponent(repo.name)}`)}"><span class="k-mono">${repo.ownerLogin}/${repo.name}</span></a>`,
    )
    .join('');
  const initial = login.trim().slice(0, 1).toUpperCase() || '?';
  const name = siteName(env);

  return html`<!DOCTYPE html>
<html lang="en" class="k-app">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${opts.title ? `${opts.title} · ${name}` : name}</title>
<script>{const q=new URLSearchParams(location.search).get("mode");let m=q;try{m=m||localStorage.getItem("kvarm-mode")}catch{}document.documentElement.dataset.mode=m==="agent"?"agent":"human"}</script>
<link rel="stylesheet" href="/assets/tokens.css">
<link rel="stylesheet" href="/assets/app.css">
<link rel="stylesheet" href="/assets/console.css">
<link rel="icon" href="/favicon.ico" sizes="32x32">
<link rel="icon" href="/assets/brand/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/assets/brand/apple-touch-icon.png">
<link rel="manifest" href="/assets/brand/site.webmanifest">
<meta name="theme-color" content="#050608">
</head>
<body class="k-app">
<svg class="k-sprites" aria-hidden="true" width="0" height="0">
  <symbol id="mark" viewBox="0 0 48 48"><path fill="currentColor" d="M5 4h9v40H5zM28 18.5 42.5 4H48v5.5L33.5 24 48 38.5V44h-5.5L28 29.5 33.5 24z"/><path d="M23 17.5 29.5 24 23 30.5 16.5 24z" style="fill:var(--node,var(--signal))"/></symbol>
  <symbol id="g-node" viewBox="0 0 5 5"><path fill="currentColor" d="M1 0h3v1H1zM0 1h1v3H0zM4 1h1v3H4zM1 4h3v1H1zM2 2h1v1H2z"/></symbol>
  <symbol id="g-x" viewBox="0 0 5 5"><path fill="currentColor" d="M0 0h1v1H0zM4 0h1v1H4zM1 1h1v1H1zM3 1h1v1H3zM2 2h1v1H2zM1 3h1v1H1zM3 3h1v1H3zM0 4h1v1H0zM4 4h1v1H4z"/></symbol>
  <symbol id="g-tray" viewBox="0 0 5 5"><path fill="currentColor" d="M1 0h3v1H1zM0 1h1v4H0zM4 1h1v4H4zM1 2h1v1H1zM3 2h1v1H3zM1 4h3v1H1z"/></symbol>
  <symbol id="g-reticle" viewBox="0 0 24 24"><g fill="none" stroke="currentColor"><circle cx="12" cy="12" r="10.5"/><path d="M12 0v4M12 20v4M0 12h4M20 12h4M12 10v4M10 12h4"/></g></symbol>
</svg>
<header class="k-top">
  <a class="brand" href="/" aria-label="${name} home"><img class="mark" src="/assets/brand/mark.svg" alt="" /><img class="wordmark-sm" src="/assets/brand/wordmark.svg" alt="" /></a>
  <div class="k-mid">
    <div class="k-ws"><i>${initial}</i><span>${login || 'Account'}</span></div>
  </div>
  <div class="k-right">
    <a class="k-needs" href="${raw(badgeHref)}" title="${badgeTitle}" aria-label="Needs you: ${badge}"><span>Needs you</span><b>${badge}</b></a>
    <div class="mode" role="group" aria-label="Show this app for">
      <button type="button" data-mode-set="human" aria-pressed="true"><svg aria-hidden="true"><use href="#g-node"/></svg>Human</button>
      <button type="button" data-mode-set="agent" aria-pressed="false"><svg aria-hidden="true"><use href="#g-x"/></svg>Agent</button>
    </div>
    <a class="k-me" href="/auth/logout" aria-label="Sign out">${initial}</a>
  </div>
</header>
<p class="sr" id="mode-status" role="status" aria-live="polite"></p>
<div class="k-shell">
  <aside class="k-rail" aria-label="App">
    <nav>
      <a href="/" ${raw(opts.active === 'home' ? 'aria-current="page"' : '')}><svg aria-hidden="true"><use href="#g-reticle"/></svg>Home</a>
      <a href="/inbox" ${raw(opts.active === 'inbox' ? 'aria-current="page"' : '')}><svg aria-hidden="true"><use href="#g-tray"/></svg>Inbox</a>
      <a href="/fleet" ${raw(opts.active === 'fleet' ? 'aria-current="page"' : '')}><svg aria-hidden="true"><use href="#g-node"/></svg>Fleet<span class="n">${runningCount}</span></a>
      <a href="/settings/tokens" ${raw(opts.active === 'tokens' ? 'aria-current="page"' : '')}><svg aria-hidden="true"><use href="#g-x"/></svg>Tokens &amp; agents</a>
    </nav>
    ${raw(
      repoLinks
        ? html`<div class="k-repos"><h4 class="hud">Repos</h4>${raw(repoLinks)}</div>`
        : '',
    )}
    <div class="k-foot"><p class="hud">Signed in via WorkOS</p></div>
  </aside>
  <main class="k-main" id="main">${raw(body)}</main>
</div>
<script src="/assets/mode.js" type="module"></script>
</body>
</html>`;
}

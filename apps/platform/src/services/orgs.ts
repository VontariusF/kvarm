/**
 * Organizations and direct membership (architecture §11.1).
 *
 * - Org and user logins share one case-insensitive namespace (`account_names`).
 * - Any human account can create an org and becomes its first owner.
 * - Owners manage membership (and agent credentials); maintainers administer
 *   the org's repos; members get no implicit repo access, only explicit grants
 *   (services/grants.ts).
 * - Every org keeps at least one owner. The last-owner guard lives inside the
 *   writing statement itself, so concurrent demotions cannot both succeed.
 *
 * Mutations are one D1 batch: the guarded write plus a diagnostic read that
 * explains a write that changed nothing.
 */

import type { ServiceResult } from '../repos/service';
import { isOrgRole, type Actor, type OrgRole } from './authz';

export interface OrgRow {
  id: string;
  login: string;
  name: string | null;
  created_by: string;
  created_at: number;
}

export interface OrgMember {
  login: string;
  role: OrgRole;
  createdAt: number;
  updatedAt: number;
}

export const ORG_LOGIN_RE = /^[a-z0-9][a-z0-9-]{0,38}$/;

/** Top-level path segments and words an account login must never take. */
export const RESERVED_LOGINS: ReadonlySet<string> = new Set([
  'admin',
  'api',
  'assets',
  'auth',
  'healthz',
  'import-repo',
  // The review inbox page (routes/reviewPages.ts) is mounted ahead of account profiles.
  'inbox',
  'login',
  'logout',
  'mcp',
  'new',
  'new-repo',
  'org',
  'orgs',
  'repos',
  'root',
  'settings',
  'sign-in',
  'sign-out',
  'static',
  'system',
  'user',
  'users',
]);

export const MEMBER_PAGE_MAX = 200;

/** Owners manage membership and the org's agent credentials; nobody else does. */
export function canManageMembers(role: OrgRole | null): boolean {
  return role === 'owner';
}

export const canManageOrgCredentials = canManageMembers;

/** Owners and maintainers create and administer the org's repositories. */
export function canAdministerOrgRepos(role: OrgRole | null): boolean {
  return role === 'owner' || role === 'maintainer';
}

function fail<T>(status: number, error: string, code: string): ServiceResult<T> {
  return { ok: false, status, error, code };
}

export function validateOrgLogin(login: string): string | null {
  if (!ORG_LOGIN_RE.test(login)) return 'login must be 1-39 lowercase letters, digits or dashes, starting with a letter or digit';
  if (RESERVED_LOGINS.has(login)) return 'login is reserved';
  return null;
}

export async function createOrg(
  env: Env,
  actor: Actor,
  p: { login: string; name?: string | null },
): Promise<ServiceResult<{ org: OrgRow; role: OrgRole }>> {
  const login = p.login.trim();
  const invalid = validateOrgLogin(login);
  if (invalid) return fail(400, invalid, 'INVALID_LOGIN');
  const name = typeof p.name === 'string' ? p.name.trim().slice(0, 100) || null : null;
  const org: OrgRow = { id: crypto.randomUUID(), login, name, created_by: actor.user.id, created_at: Date.now() };
  try {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO account_names (login, kind, account_id, created_at) VALUES (?, 'org', ?, ?)").bind(
        login,
        org.id,
        org.created_at,
      ),
      env.DB.prepare('INSERT INTO orgs (id, login, name, created_by, created_at) VALUES (?, ?, ?, ?, ?)').bind(
        org.id,
        login,
        name,
        org.created_by,
        org.created_at,
      ),
      env.DB.prepare(
        "INSERT INTO org_members (org_id, user_id, role, created_at, updated_at) VALUES (?, ?, 'owner', ?, ?)",
      ).bind(org.id, actor.user.id, org.created_at, org.created_at),
    ]);
  } catch (err) {
    if (/UNIQUE|constraint/i.test(String(err))) {
      return fail(409, 'that login is already taken by a user or organization', 'NAMESPACE_TAKEN');
    }
    throw err;
  }
  return { ok: true, value: { org, role: 'owner' } };
}

type OrgWithViewer = OrgRow & { viewer_role: unknown };

function orgWithViewer(db: D1Database, login: string, userId: string | null): D1PreparedStatement {
  return db
    .prepare(
      `SELECT o.*, (SELECT role FROM org_members WHERE org_id = o.id AND user_id = ?2) AS viewer_role
         FROM orgs o WHERE o.login = ?1`,
    )
    .bind(login, userId);
}

function splitViewer(row: OrgWithViewer | undefined | null): { org: OrgRow; role: OrgRole | null } | null {
  if (!row) return null;
  const { viewer_role, ...org } = row;
  return { org, role: isOrgRole(viewer_role) ? viewer_role : null };
}

/** The org and the viewer's role in it (null for non-members and anonymous viewers). */
export async function getOrg(
  env: Env,
  login: string,
  viewer: Actor | null,
): Promise<{ org: OrgRow; role: OrgRole | null } | null> {
  return splitViewer(await orgWithViewer(env.DB, login, viewer?.user.id ?? null).first<OrgWithViewer>());
}

export async function listUserOrgs(
  env: Env,
  actor: Actor,
): Promise<{ login: string; name: string | null; role: OrgRole }[]> {
  const { results } = await env.DB.prepare(
    `SELECT o.login, o.name, m.role FROM org_members m JOIN orgs o ON o.id = m.org_id
      WHERE m.user_id = ? ORDER BY o.login LIMIT ?`,
  )
    .bind(actor.user.id, MEMBER_PAGE_MAX)
    .all<{ login: string; name: string | null; role: OrgRole }>();
  return results ?? [];
}

/** Members are visible to members; one round trip whether or not access is granted. */
export async function listMembers(
  env: Env,
  orgLogin: string,
  actor: Actor,
  page: { cursor?: string; limit?: number } = {},
): Promise<ServiceResult<{ members: OrgMember[]; nextCursor: string | null }>> {
  const limit = Math.max(1, Math.min(MEMBER_PAGE_MAX, Math.floor(page.limit ?? 100)));
  const [head, list] = await env.DB.batch([
    orgWithViewer(env.DB, orgLogin, actor.user.id),
    env.DB.prepare(
      `SELECT u.login, m.role, m.created_at, m.updated_at
         FROM orgs o JOIN org_members m ON m.org_id = o.id JOIN users u ON u.id = m.user_id
        WHERE o.login = ?1 AND u.login > ?2
          AND EXISTS (SELECT 1 FROM org_members v WHERE v.org_id = o.id AND v.user_id = ?3)
        ORDER BY u.login LIMIT ?4`,
    ).bind(orgLogin, page.cursor ?? '', actor.user.id, limit + 1),
  ]);
  const viewer = splitViewer(head?.results?.[0] as OrgWithViewer | undefined);
  if (!viewer) return fail(404, 'organization not found', 'NOT_FOUND');
  if (!viewer.role) return fail(403, 'only organization members can list members', 'FORBIDDEN');
  const rows = (list?.results ?? []) as { login: string; role: OrgRole; created_at: number; updated_at: number }[];
  const members = rows.slice(0, limit).map((r) => ({
    login: r.login,
    role: r.role,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
  const nextCursor = rows.length > limit ? (members[members.length - 1]?.login ?? null) : null;
  return { ok: true, value: { members, nextCursor } };
}

interface MembershipDiagnosis {
  org_id: string | null;
  actor_role: unknown;
  target_id: string | null;
  target_role: unknown;
}

/** Explains why a guarded membership write changed nothing. */
function diagnosisSelect(db: D1Database, orgLogin: string, actorId: string, targetLogin: string): D1PreparedStatement {
  return db
    .prepare(
      `SELECT o.id AS org_id,
              (SELECT role FROM org_members WHERE org_id = o.id AND user_id = ?2) AS actor_role,
              (SELECT id FROM users WHERE login = ?3) AS target_id,
              (SELECT m.role FROM org_members m JOIN users u ON u.id = m.user_id
                WHERE m.org_id = o.id AND u.login = ?3) AS target_role
         FROM orgs o WHERE o.login = ?1`,
    )
    .bind(orgLogin, actorId, targetLogin);
}

function explain<T>(d: MembershipDiagnosis | undefined, removing: boolean): ServiceResult<T> {
  if (!d?.org_id) return fail(404, 'organization not found', 'NOT_FOUND');
  if (d.actor_role !== 'owner') return fail(403, 'only organization owners can manage membership', 'FORBIDDEN');
  if (!d.target_id) return fail(404, 'user not found', 'USER_NOT_FOUND');
  if (removing && !isOrgRole(d.target_role)) return fail(404, 'user is not a member', 'NOT_A_MEMBER');
  return fail(409, 'an organization must keep at least one owner', 'LAST_OWNER');
}

/**
 * Adds a member or changes a member's role (owner only). Demoting the last
 * owner changes nothing and reports LAST_OWNER.
 */
export async function setMember(
  env: Env,
  actor: Actor,
  orgLogin: string,
  targetLogin: string,
  role: OrgRole,
): Promise<ServiceResult<{ member: OrgMember }>> {
  const now = Date.now();
  const [write, diag] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO org_members (org_id, user_id, role, created_at, updated_at)
       SELECT o.id, u.id, ?3, ?4, ?4 FROM orgs o, users u
        WHERE o.login = ?1 AND u.login = ?2
          AND EXISTS (SELECT 1 FROM org_members a WHERE a.org_id = o.id AND a.user_id = ?5 AND a.role = 'owner')
       ON CONFLICT (org_id, user_id) DO UPDATE SET role = excluded.role, updated_at = excluded.updated_at
        WHERE excluded.role = 'owner' OR org_members.role <> 'owner'
           OR (SELECT COUNT(*) FROM org_members c WHERE c.org_id = org_members.org_id AND c.role = 'owner') > 1
       RETURNING role, created_at, updated_at`,
    ).bind(orgLogin, targetLogin, role, now, actor.user.id),
    diagnosisSelect(env.DB, orgLogin, actor.user.id, targetLogin),
  ]);
  const row = write?.results?.[0] as { role: OrgRole; created_at: number; updated_at: number } | undefined;
  if (!row) return explain(diag?.results?.[0] as MembershipDiagnosis | undefined, false);
  return {
    ok: true,
    value: { member: { login: targetLogin, role: row.role, createdAt: row.created_at, updatedAt: row.updated_at } },
  };
}

/**
 * The removal guard, evaluated against the membership rows of `org_id`/`user_id`
 * as they stand before anything is deleted: the actor (?3) is an owner and the
 * target is not the last owner. Parameters: ?1 org login, ?2 target login,
 * ?3 actor id.
 */
const REMOVAL_GUARD = `EXISTS (SELECT 1 FROM org_members t
                  WHERE t.org_id = (SELECT id FROM orgs WHERE login = ?1)
                    AND t.user_id = (SELECT id FROM users WHERE login = ?2)
                    AND EXISTS (SELECT 1 FROM org_members a WHERE a.org_id = t.org_id AND a.user_id = ?3 AND a.role = 'owner')
                    AND (t.role <> 'owner'
                         OR (SELECT COUNT(*) FROM org_members c WHERE c.org_id = t.org_id AND c.role = 'owner') > 1))`;

/**
 * Removes a member (owner only, including an owner removing themselves while
 * another owner remains). The user's grants on the org's repos are deleted in
 * the same batch. Grants on org repos already lapse with membership
 * (services/authz.ts); the cleanup keeps a later re-invite from silently
 * restoring old access.
 *
 * Grants are deleted first, under the same guard as the membership delete, so
 * neither statement depends on membership the other has already removed (an
 * owner leaving would otherwise fail their own "actor is owner" check).
 *
 * `orgs.login` matches the route NOCASE but `repos.owner_login` is
 * case-sensitive, so repos are matched on the canonical login from `orgs`
 * (still via idx_repos_owner), never on the route spelling.
 */
export async function removeMember(
  env: Env,
  actor: Actor,
  orgLogin: string,
  targetLogin: string,
): Promise<ServiceResult<{ removed: true }>> {
  const [diag, , del] = await env.DB.batch([
    diagnosisSelect(env.DB, orgLogin, actor.user.id, targetLogin),
    env.DB.prepare(
      `DELETE FROM repo_grants
        WHERE user_id = (SELECT id FROM users WHERE login = ?2)
          AND repo_id IN (SELECT id FROM repos WHERE owner_login = (SELECT login FROM orgs WHERE login = ?1))
          AND ${REMOVAL_GUARD}`,
    ).bind(orgLogin, targetLogin, actor.user.id),
    env.DB.prepare(
      `DELETE FROM org_members
        WHERE org_id = (SELECT id FROM orgs WHERE login = ?1)
          AND user_id = (SELECT id FROM users WHERE login = ?2)
          AND ${REMOVAL_GUARD}`,
    ).bind(orgLogin, targetLogin, actor.user.id),
  ]);
  if ((del?.meta?.changes ?? 0) === 0) {
    return explain(diag?.results?.[0] as MembershipDiagnosis | undefined, true);
  }
  return { ok: true, value: { removed: true } };
}

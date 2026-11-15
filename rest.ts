/**
 * rest.ts — the REST v3 API. Thin handlers over the core domain: they shape
 * JSON, parse query strings and translate domain errors to HTTP statuses.
 *
 * Serialized issue/repo bodies are cached as Buffers on the entities
 * themselves (see core.ts); a mutation clears the cache, so a hot read path
 * like `GET /issues/{n}` pays one serialization no matter how often it runs.
 */

import {
  FORGE_EPOCH_ISO,
  ForgeError,
  type Forge,
  type Issue,
  type Label,
  type PullRequest,
  type Repo,
} from './core.ts';

export interface RestRequest {
  forge: Forge;
  method: string;
  /** Decoded path segments after `/api/v3` (trailing slash stripped). */
  segments: string[];
  query: URLSearchParams;
  /** Parsed JSON body, or undefined when no body was sent. */
  body: unknown;
  /** `http://<host>` for absolute Link URLs. */
  origin: string;
}

export interface RestResult {
  status: number;
  /** Pre-serialized body (cache hit). Mutually exclusive with `json`. */
  buffer?: Buffer;
  json?: unknown;
  headers?: Record<string, string>;
}

const notFound = (): never => {
  throw new ForgeError(404, 'Not Found');
};

// ---------------------------------------------------------------------------
// Shaping
// ---------------------------------------------------------------------------

function userJson(forge: Forge): Record<string, unknown> {
  return {
    login: forge.viewerLogin,
    id: forge.viewerId,
    node_id: forge.userGlobalId(forge.viewerLogin),
    avatar_url: '',
    type: 'User',
    site_admin: false,
    name: forge.viewerLogin,
    email: forge.viewerEmail(),
    html_url: `https://example.invalid/${forge.viewerLogin}`,
    url: `/api/v3/users/${forge.viewerLogin}`,
  };
}

function repoJson(forge: Forge, repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: forge.repoGlobalId(repo),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(forge),
    private: repo.isPrivate,
    description: repo.description,
    fork: false,
    created_at: FORGE_EPOCH_ISO,
    updated_at: FORGE_EPOCH_ISO,
    pushed_at: FORGE_EPOCH_ISO,
    homepage: null,
    language: null,
    visibility: repo.isPrivate ? 'private' : 'public',
    default_branch: repo.defaultBranch,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    clone_url: `https://example.invalid/${repo.owner}/${repo.name}.git`,
    git_url: `git://example.invalid/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@example.invalid:${repo.owner}/${repo.name}.git`,
  };
}

function cachedRepoJson(forge: Forge, repo: Repo): Buffer {
  if (!repo.jsonCache) repo.jsonCache = Buffer.from(JSON.stringify(repoJson(forge, repo)), 'utf8');
  return repo.jsonCache;
}

function labelJson(label: Label): Record<string, unknown> {
  return { id: label.id, node_id: `forge-v2:label:${label.id}`, name: label.name, color: label.color, description: null, default: false };
}

function issueJson(forge: Forge, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: forge.issueGlobalId(repo, issue),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labelNames.map((name) => labelJson(repo.labels.get(name)!)),
    user: userJson(forge),
    assignees: [],
    comments: issue.comments.length,
    created_at: FORGE_EPOCH_ISO,
    updated_at: FORGE_EPOCH_ISO,
    closed_at: issue.closedAt,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function cachedIssueJson(forge: Forge, repo: Repo, issue: Issue): Buffer {
  if (!issue.jsonCache) issue.jsonCache = Buffer.from(JSON.stringify(issueJson(forge, repo, issue)), 'utf8');
  return issue.jsonCache;
}

function pullJson(forge: Forge, repo: Repo, pull: PullRequest): Record<string, unknown> {
  const tips = forge.pullTips(repo, pull);
  const branchShape = (ref: string, sha: string): Record<string, unknown> => ({
    label: `${repo.owner}:${ref}`,
    ref,
    sha,
    user: userJson(forge),
    repo: { id: repo.id, name: repo.name, full_name: `${repo.owner}/${repo.name}` },
  });
  return {
    id: pull.id,
    node_id: forge.pullGlobalId(repo, pull),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: pull.state === 'open' ? forge.pullMergeable(repo, pull) === 'MERGEABLE' : null,
    head: branchShape(pull.headRef, tips.head),
    base: branchShape(pull.baseRef, tips.base),
    user: userJson(forge),
    assignees: [],
    created_at: FORGE_EPOCH_ISO,
    updated_at: FORGE_EPOCH_ISO,
    closed_at: pull.state === 'closed' ? FORGE_EPOCH_ISO : null,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

function commentJson(forge: Forge, comment: { id: number; body: string }): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: `forge-v2:comment:${comment.id}`,
    body: comment.body,
    user: userJson(forge),
    created_at: FORGE_EPOCH_ISO,
    updated_at: FORGE_EPOCH_ISO,
  };
}

function commitJson(forge: Forge, sha: string): Record<string, unknown> | undefined {
  const info = forge.parseCommit(sha);
  if (!info) return undefined;
  const person = (who: { name: string; email: string; time: number }): Record<string, unknown> => ({
    name: who.name,
    email: who.email,
    date: new Date(who.time * 1000).toISOString(),
  });
  return {
    sha,
    node_id: `forge-v2:commit:${sha}`,
    commit: {
      message: info.message,
      author: person(info.author),
      committer: person(info.committer),
      tree: { sha: info.tree },
    },
    parents: info.parents.map((parent) => ({ sha: parent })),
    author: null,
    committer: null,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function bodyObject(body: unknown): Record<string, unknown> {
  if (body === undefined || body === null) return {};
  if (typeof body !== 'object' || Array.isArray(body)) throw new ForgeError(422, 'Request body must be a JSON object');
  return body as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function parseNumber(segment: string): number | undefined {
  if (!/^\d+$/.test(segment)) return undefined;
  const value = Number.parseInt(segment, 10);
  return Number.isSafeInteger(value) ? value : undefined;
}

interface PageParams {
  perPage: number;
  page: number;
}

function pageParams(query: URLSearchParams): PageParams {
  const perPageRaw = Number.parseInt(query.get('per_page') ?? '', 10);
  const pageRaw = Number.parseInt(query.get('page') ?? '', 10);
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(perPageRaw, 100) : 30;
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  return { perPage, page };
}

function linkHeader(origin: string, path: string, query: URLSearchParams, params: PageParams, total: number): string | null {
  const totalPages = Math.max(1, Math.ceil(total / params.perPage));
  if (totalPages <= 1) return null;
  const build = (page: number): string => {
    const next = new URLSearchParams(query);
    next.set('per_page', String(params.perPage));
    next.set('page', String(page));
    return `<${origin}${path}?${next.toString()}>`;
  };
  const links: string[] = [];
  if (params.page < totalPages) links.push(`${build(params.page + 1)}; rel="next"`);
  if (params.page > 1) links.push(`${build(params.page - 1)}; rel="prev"`);
  links.push(`${build(1)}; rel="first"`);
  links.push(`${build(totalPages)}; rel="last"`);
  return links.join(', ');
}

function paginate<T>(items: readonly T[], params: PageParams): T[] {
  const start = (params.page - 1) * params.perPage;
  return items.slice(start, start + params.perPage);
}

type IssueLike = { state: 'open' | 'closed'; createdSeq: number; updatedSeq: number; comments: unknown[]; number: number };

function filterAndSort<T extends IssueLike>(items: readonly T[], query: URLSearchParams): T[] {
  const state = query.get('state') ?? 'open';
  const filtered = state === 'all' ? [...items] : items.filter((item) => item.state === state);
  const sort = query.get('sort') ?? 'created';
  const direction = query.get('direction') ?? 'desc';
  const key = (item: T): number =>
    sort === 'updated' ? item.updatedSeq : sort === 'comments' ? item.comments.length : item.createdSeq;
  filtered.sort((a, b) => {
    const diff = key(a) - key(b);
    if (diff !== 0) return direction === 'asc' ? diff : -diff;
    return direction === 'asc' ? a.number - b.number : b.number - a.number;
  });
  return filtered;
}

function requireRepo(forge: Forge, owner: string, name: string): Repo {
  const repo = forge.getRepo(owner, name);
  if (!repo) notFound();
  return repo!;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function handleRest(request: RestRequest): RestResult {
  const { forge, method, segments: seg, query } = request;
  const path = `/api/v3/${seg.join('/')}`;

  // API root and meta.
  if (seg.length === 0) {
    if (method !== 'GET') notFound();
    return {
      status: 200,
      json: {
        current_user_url: `${request.origin}/api/v3/user`,
        repository_url: `${request.origin}/api/v3/repos/{owner}/{repo}`,
        user_repos_url: `${request.origin}/api/v3/user/repos`,
        meta_url: `${request.origin}/api/v3/meta`,
      },
      headers: { 'X-Oauth-Scopes': 'repo' },
    };
  }
  if (seg.length === 1 && seg[0] === 'meta') {
    if (method !== 'GET') notFound();
    return { status: 200, json: { installed_version: '2.0.0' } };
  }
  if (seg.length === 1 && seg[0] === 'user') {
    if (method !== 'GET') notFound();
    return { status: 200, json: userJson(forge) };
  }

  // /user/repos
  if (seg.length === 2 && seg[0] === 'user' && seg[1] === 'repos') {
    if (method === 'GET') {
      const params = pageParams(query);
      const repos = forge.listRepos();
      const link = linkHeader(request.origin, path, query, params, repos.length);
      return {
        status: 200,
        json: paginate(repos, params).map((repo) => repoJson(forge, repo)),
        headers: link ? { Link: link } : undefined,
      };
    }
    if (method === 'POST') {
      const body = bodyObject(request.body);
      const name = asString(body.name);
      if (name === undefined) throw new ForgeError(422, 'Repository name is required');
      const repo = forge.createRepo(name, asString(body.description) ?? '', asBoolean(body.private) ?? false);
      return { status: 201, buffer: cachedRepoJson(forge, repo) };
    }
    notFound();
  }

  // /repos/{owner}/{repo}/...
  if (seg.length >= 3 && seg[0] === 'repos') {
    const repo = requireRepo(forge, seg[1]!, seg[2]!);
    const rest = seg.slice(3);

    if (rest.length === 0) {
      if (method === 'GET') return { status: 200, buffer: cachedRepoJson(forge, repo) };
      if (method === 'PATCH') {
        const body = bodyObject(request.body);
        forge.updateRepo(repo, {
          name: asString(body.name),
          description: asString(body.description),
          isPrivate: asBoolean(body.private),
        });
        return { status: 200, buffer: cachedRepoJson(forge, repo) };
      }
      if (method === 'DELETE') {
        forge.deleteRepo(repo);
        return { status: 204, json: undefined };
      }
      notFound();
    }

    const head = rest[0]!;

    if (head === 'branches') {
      if (rest.length === 1) {
        if (method !== 'GET') notFound();
        return {
          status: 200,
          json: forge.listBranches(repo).map((name) => ({
            name,
            commit: { sha: forge.branchTip(repo, name) },
            protected: false,
          })),
        };
      }
      if (method !== 'GET') notFound();
      const branch = rest.slice(1).join('/');
      const tip = forge.branchTip(repo, branch);
      if (!tip) notFound();
      return { status: 200, json: { name: branch, commit: { sha: tip }, protected: false } };
    }

    if (head === 'commits') {
      if (rest.length === 1) {
        if (method !== 'GET') notFound();
        const ref = query.get('sha') ?? repo.defaultBranch;
        const tip = forge.resolveRevToCommit(repo, ref);
        if (!tip) notFound();
        const params = pageParams(query);
        const shas = forge.historyFrom(tip!, params.page * params.perPage);
        const page = paginate(shas, params);
        const link = linkHeader(request.origin, path, query, params, shas.length);
        return {
          status: 200,
          json: page.map((sha) => commitJson(forge, sha)).filter((entry) => entry !== undefined),
          headers: link ? { Link: link } : undefined,
        };
      }
      if (method !== 'GET') notFound();
      const sha = rest.slice(1).join('/');
      const entry = commitJson(forge, sha);
      if (!entry) notFound();
      return { status: 200, json: entry };
    }

    if (head === 'git' && rest[1] === 'refs') {
      const remainder = rest.slice(2).join('/');
      if (rest.length === 2) {
        if (method === 'GET') {
          return {
            status: 200,
            json: forge.listRefs(repo).map(({ ref, oid }) => ({ ref, object: { sha: oid } })),
          };
        }
        if (method === 'POST') {
          const body = bodyObject(request.body);
          const ref = asString(body.ref);
          const sha = asString(body.sha);
          if (!ref || !sha) throw new ForgeError(422, 'ref and sha are required');
          forge.createRef(repo, ref, sha);
          return { status: 201, json: { ref, object: { sha } } };
        }
        notFound();
      }
      const fullRef = remainder.startsWith('refs/') ? remainder : `refs/${remainder}`;
      if (method === 'GET') {
        const oid = repo.refs.get(fullRef);
        if (oid) return { status: 200, json: { ref: fullRef, object: { sha: oid } } };
        const matches = forge
          .listRefs(repo)
          .filter(({ ref }) => ref.startsWith(fullRef));
        if (matches.length > 0) {
          return { status: 200, json: matches.map(({ ref, oid: sha }) => ({ ref, object: { sha } })) };
        }
        notFound();
      }
      if (method === 'DELETE') {
        if (!forge.deleteRef(repo, fullRef)) notFound();
        return { status: 204, json: undefined };
      }
      notFound();
    }

    if (head === 'contents') {
      const contentPath = rest.slice(1).join('/');
      if (method === 'GET') {
        const ref = query.get('ref') ?? undefined;
        const found = forge.readContents(repo, ref, contentPath);
        if (!found) notFound();
        if (found.kind === 'file') {
          const object = forge.getObject(found.oid);
          const data = object?.data ?? Buffer.alloc(0);
          return {
            status: 200,
            json: {
              type: 'file',
              encoding: 'base64',
              content: data.toString('base64'),
              sha: found.oid,
              size: data.length,
              name: found.name,
              path: contentPath,
            },
          };
        }
        return {
          status: 200,
          json: found.entries.map((entry) => {
            const size = entry.isDir ? 0 : (forge.getObject(entry.oid)?.data.length ?? 0);
            return { type: entry.isDir ? 'dir' : 'file', name: entry.name, path: entry.path, sha: entry.oid, size };
          }),
        };
      }
      if (method === 'PUT') {
        const body = bodyObject(request.body);
        const content = asString(body.content);
        if (content === undefined) throw new ForgeError(422, 'content is required');
        const branch = asString(body.branch) ?? repo.defaultBranch;
        const result = forge.writeContents(
          repo,
          branch,
          contentPath,
          Buffer.from(content, 'base64'),
          asString(body.message) ?? '',
          asString(body.sha),
        );
        return {
          status: result.created ? 201 : 200,
          json: {
            content: { name: contentPath.split('/').pop(), path: contentPath, sha: result.blobOid, size: Buffer.from(content, 'base64').length, type: 'file', encoding: 'base64' },
            commit: { sha: result.commitOid, message: asString(body.message) ?? '' },
          },
        };
      }
      if (method === 'DELETE') {
        const body = bodyObject(request.body);
        const branch = asString(body.branch) ?? repo.defaultBranch;
        const result = forge.deleteContents(repo, branch, contentPath, asString(body.message) ?? '', asString(body.sha));
        return { status: 200, json: { commit: { sha: result.commitOid } } };
      }
      notFound();
    }

    if (head === 'labels') {
      if (rest.length !== 1) notFound();
      if (method === 'GET') {
        return { status: 200, json: [...repo.labels.values()].map(labelJson) };
      }
      if (method === 'POST') {
        const body = bodyObject(request.body);
        const name = asString(body.name);
        if (!name) throw new ForgeError(422, 'Label name is required');
        const label = forge.createLabel(repo, name, asString(body.color) ?? 'ededed');
        return { status: 201, json: labelJson(label) };
      }
      notFound();
    }

    if (head === 'issues') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const params = pageParams(query);
          const issues = filterAndSort([...repo.issues.values()], query);
          const link = linkHeader(request.origin, path, query, params, issues.length);
          return {
            status: 200,
            json: paginate(issues, params).map((issue) => issueJson(forge, repo, issue)),
            headers: link ? { Link: link } : undefined,
          };
        }
        if (method === 'POST') {
          const body = bodyObject(request.body);
          const title = asString(body.title);
          if (title === undefined) throw new ForgeError(422, 'Issue title is required');
          const labels = Array.isArray(body.labels)
            ? body.labels.filter((entry): entry is string => typeof entry === 'string')
            : [];
          const issue = forge.createIssue(repo, title, asString(body.body) ?? '', labels);
          return { status: 201, buffer: cachedIssueJson(forge, repo, issue) };
        }
        notFound();
      }
      const number = parseNumber(rest[1]!);
      if (number === undefined) notFound();
      const issue = repo.issues.get(number!);
      if (rest.length === 2) {
        if (!issue) notFound();
        if (method === 'GET') return { status: 200, buffer: cachedIssueJson(forge, repo, issue!) };
        if (method === 'PATCH') {
          const body = bodyObject(request.body);
          const state = asString(body.state);
          if (state !== undefined && state !== 'open' && state !== 'closed') {
            throw new ForgeError(422, `Invalid state ${JSON.stringify(state)}`);
          }
          const labels = Array.isArray(body.labels)
            ? body.labels.filter((entry): entry is string => typeof entry === 'string')
            : undefined;
          const updated = forge.patchIssue(repo, issue!, {
            title: asString(body.title),
            body: asString(body.body),
            state: state as 'open' | 'closed' | undefined,
            labelNames: labels,
          });
          return { status: 200, buffer: cachedIssueJson(forge, repo, updated) };
        }
        notFound();
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (!issue) notFound();
        if (method === 'GET') {
          return { status: 200, json: issue!.comments.map((comment) => commentJson(forge, comment)) };
        }
        if (method === 'POST') {
          const body = bodyObject(request.body);
          const text = asString(body.body);
          if (text === undefined) throw new ForgeError(422, 'Comment body is required');
          const comment = forge.addIssueComment(repo, issue!, text);
          return { status: 201, json: commentJson(forge, comment) };
        }
        notFound();
      }
      notFound();
    }

    if (head === 'pulls') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const params = pageParams(query);
          const pulls = filterAndSort([...repo.pulls.values()], query);
          const link = linkHeader(request.origin, path, query, params, pulls.length);
          return {
            status: 200,
            json: paginate(pulls, params).map((pull) => pullJson(forge, repo, pull)),
            headers: link ? { Link: link } : undefined,
          };
        }
        if (method === 'POST') {
          const body = bodyObject(request.body);
          const title = asString(body.title);
          const headRef = asString(body.head);
          const baseRef = asString(body.base);
          if (title === undefined) throw new ForgeError(422, 'Pull request title is required');
          if (!headRef || !baseRef) throw new ForgeError(422, 'head and base are required');
          const pull = forge.createPull(repo, title, asString(body.body) ?? '', headRef, baseRef);
          return { status: 201, json: pullJson(forge, repo, pull) };
        }
        notFound();
      }
      const number = parseNumber(rest[1]!);
      if (number === undefined) notFound();
      const pull = repo.pulls.get(number!);
      if (rest.length === 2) {
        if (!pull) notFound();
        if (method !== 'GET') notFound();
        return { status: 200, json: pullJson(forge, repo, pull!) };
      }
      if (rest.length === 3 && rest[2] === 'files') {
        if (!pull) notFound();
        if (method !== 'GET') notFound();
        return {
          status: 200,
          json: forge.pullFiles(repo, pull!).map((change) => ({
            filename: change.filename,
            status: change.status,
            additions: change.additions,
            deletions: change.deletions,
            changes: change.changes,
          })),
        };
      }
      if (rest.length === 3 && rest[2] === 'merge') {
        if (!pull) notFound();
        if (method !== 'PUT') notFound();
        const body = bodyObject(request.body);
        const mergeMethod = asString(body.merge_method) ?? 'squash';
        if (mergeMethod !== 'squash' && mergeMethod !== 'merge') {
          throw new ForgeError(422, `Unsupported merge method ${JSON.stringify(mergeMethod)}`);
        }
        const { sha } = forge.mergePull(repo, pull!, mergeMethod);
        return { status: 200, json: { sha, merged: true, message: 'Pull request successfully merged' } };
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (!pull) notFound();
        if (method === 'GET') {
          return { status: 200, json: pull!.comments.map((comment) => commentJson(forge, comment)) };
        }
        if (method === 'POST') {
          const body = bodyObject(request.body);
          const text = asString(body.body);
          if (text === undefined) throw new ForgeError(422, 'Comment body is required');
          const comment = forge.addPullComment(repo, pull!, text);
          return { status: 201, json: commentJson(forge, comment) };
        }
        notFound();
      }
      notFound();
    }

    notFound();
  }

  notFound();
}

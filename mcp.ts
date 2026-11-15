/**
 * mcp.ts — the MCP endpoint (Streamable HTTP, JSON-RPC 2.0).
 *
 * Two eras are served from one dispatcher:
 * - Modern (2026-07-28): `server/discover` answers the supported revisions,
 *   no handshake or session is needed.
 * - Legacy (2025-11-25 and older): `initialize` + `notifications/initialized`
 *   handshakes work the same way.
 *
 * Tools act on the same core store as REST, so every surface agrees. The
 * tool definitions are a single frozen constant, which makes `tools/list`
 * byte-identical across calls.
 */

import { ForgeError, type Forge, type Issue, type PullRequest, type Repo } from './core.ts';

export interface McpResult {
  status: number;
  json?: unknown;
  empty?: boolean;
}

const SERVER_NAME = 'forge-v2';
const SERVER_VERSION = '2.0.0';
const MODERN_REVISION = '2026-07-28';

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string; enum?: string[] }>;
    required: string[];
  };
}

function tool(
  name: string,
  description: string,
  properties: ToolDefinition['inputSchema']['properties'],
  required: string[],
): ToolDefinition {
  return { name, description, inputSchema: { type: 'object', properties, required } };
}

const OWNER_PROP = { type: 'string', description: 'The owner of the repository.' };
const REPO_PROP = { type: 'string', description: 'The name of the repository.' };

const TOOLS: readonly ToolDefinition[] = Object.freeze([
  tool(
    'create_repo',
    'Create a new repository owned by the authenticated user.',
    {
      name: { type: 'string', description: 'The name of the repository.' },
      description: { type: 'string', description: 'A short description of the repository.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    },
    ['name'],
  ),
  tool(
    'get_repo',
    'Get a repository by owner and name.',
    { owner: OWNER_PROP, repo: REPO_PROP },
    ['owner', 'repo'],
  ),
  tool(
    'create_issue',
    'Create an issue in a repository.',
    {
      owner: OWNER_PROP,
      repo: REPO_PROP,
      title: { type: 'string', description: 'The title of the issue.' },
      body: { type: 'string', description: 'The body of the issue.' },
    },
    ['owner', 'repo', 'title'],
  ),
  tool(
    'list_issues',
    'List issues in a repository.',
    {
      owner: OWNER_PROP,
      repo: REPO_PROP,
      state: { type: 'string', description: 'Filter by state: open, closed, or all.', enum: ['open', 'closed', 'all'] },
    },
    ['owner', 'repo'],
  ),
  tool(
    'create_pull_request',
    'Create a pull request in a repository.',
    {
      owner: OWNER_PROP,
      repo: REPO_PROP,
      title: { type: 'string', description: 'The title of the pull request.' },
      body: { type: 'string', description: 'The body of the pull request.' },
      head: { type: 'string', description: 'The head branch name.' },
      base: { type: 'string', description: 'The base branch name.' },
    },
    ['owner', 'repo', 'title', 'head', 'base'],
  ),
  tool(
    'merge_pull_request',
    'Merge a pull request with a squash merge.',
    {
      owner: OWNER_PROP,
      repo: REPO_PROP,
      pull_number: { type: 'number', description: 'The pull request number.' },
    },
    ['owner', 'repo', 'pull_number'],
  ),
  tool(
    'get_issue',
    'Get a single issue by number.',
    {
      owner: OWNER_PROP,
      repo: REPO_PROP,
      issue_number: { type: 'number', description: 'The issue number.' },
    },
    ['owner', 'repo', 'issue_number'],
  ),
  tool(
    'list_pull_requests',
    'List pull requests in a repository.',
    {
      owner: OWNER_PROP,
      repo: REPO_PROP,
      state: { type: 'string', description: 'Filter by state: open, closed, or all.', enum: ['open', 'closed', 'all'] },
    },
    ['owner', 'repo'],
  ),
  tool(
    'get_file_contents',
    'Read a file from a repository at a ref.',
    {
      owner: OWNER_PROP,
      repo: REPO_PROP,
      path: { type: 'string', description: 'The file path within the repository.' },
      ref: { type: 'string', description: 'The branch, tag or commit (defaults to the default branch).' },
    },
    ['owner', 'repo', 'path'],
  ),
  tool(
    'add_issue_comment',
    'Add a comment to an issue.',
    {
      owner: OWNER_PROP,
      repo: REPO_PROP,
      issue_number: { type: 'number', description: 'The issue number.' },
      body: { type: 'string', description: 'The comment body.' },
    },
    ['owner', 'repo', 'issue_number', 'body'],
  ),
]);

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

class McpArgumentError extends Error {}
class McpDomainError extends Error {}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function requiredString(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== 'string' || value === '') throw new McpArgumentError(`Argument "${name}" is required`);
  return value;
}

function optionalString(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  return typeof value === 'string' ? value : undefined;
}

function requiredNumber(args: Record<string, unknown>, name: string): number {
  const value = args[name];
  const coerced = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(coerced)) throw new McpArgumentError(`Argument "${name}" must be a number`);
  return coerced;
}

function resolveRepo(forge: Forge, args: Record<string, unknown>): Repo {
  let owner = optionalString(args, 'owner');
  let name = optionalString(args, 'repo') ?? optionalString(args, 'repository') ?? optionalString(args, 'repo_name');
  const fullName = optionalString(args, 'full_name');
  if ((!owner || !name) && fullName) {
    const slash = fullName.indexOf('/');
    if (slash > 0) {
      owner = fullName.slice(0, slash);
      name = fullName.slice(slash + 1);
    }
  }
  if (!owner) owner = forge.viewerLogin;
  if (!name) throw new McpArgumentError('Argument "repo" is required');
  const repo = forge.getRepo(owner, name);
  if (!repo) throw new McpDomainError(`Repository ${owner}/${name} not found`);
  return repo;
}

function repoShape(forge: Forge, repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
  };
}

function issueShape(forge: Forge, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullShape(forge: Forge, repo: Repo, pull: PullRequest): Record<string, unknown> {
  const tips = forge.pullTips(repo, pull);
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    head: { ref: pull.headRef, sha: tips.head },
    base: { ref: pull.baseRef, sha: tips.base },
  };
}

type ToolHandler = (forge: Forge, args: Record<string, unknown>) => unknown;

const TOOL_HANDLERS: Record<string, ToolHandler> = {
  create_repo: (forge, args) => {
    const name = requiredString(args, 'name');
    const description = optionalString(args, 'description') ?? '';
    const isPrivate = args.private === true;
    try {
      const repo = forge.createRepo(name, description, isPrivate);
      return repoShape(forge, repo);
    } catch (error) {
      if (error instanceof ForgeError) throw new McpDomainError(error.message);
      throw error;
    }
  },
  get_repo: (forge, args) => repoShape(forge, resolveRepo(forge, args)),
  create_issue: (forge, args) => {
    const repo = resolveRepo(forge, args);
    const title = requiredString(args, 'title');
    const body = optionalString(args, 'body') ?? optionalString(args, 'description') ?? '';
    try {
      const issue = forge.createIssue(repo, title, body, []);
      return issueShape(forge, repo, issue);
    } catch (error) {
      if (error instanceof ForgeError) throw new McpDomainError(error.message);
      throw error;
    }
  },
  list_issues: (forge, args) => {
    const repo = resolveRepo(forge, args);
    const state = optionalString(args, 'state') ?? 'open';
    const issues = [...repo.issues.values()]
      .filter((issue) => state === 'all' || issue.state === state)
      .sort((a, b) => b.number - a.number);
    return { issues: issues.map((issue) => issueShape(forge, repo, issue)) };
  },
  create_pull_request: (forge, args) => {
    const repo = resolveRepo(forge, args);
    const title = requiredString(args, 'title');
    const head = requiredString(args, 'head');
    const base = requiredString(args, 'base');
    const body = optionalString(args, 'body') ?? '';
    try {
      const pull = forge.createPull(repo, title, body, head, base);
      return pullShape(forge, repo, pull);
    } catch (error) {
      if (error instanceof ForgeError) throw new McpDomainError(error.message);
      throw error;
    }
  },
  merge_pull_request: (forge, args) => {
    const repo = resolveRepo(forge, args);
    const number = requiredNumber(args, 'pull_number');
    const pull = repo.pulls.get(number);
    if (!pull) throw new McpDomainError(`Pull request #${number} not found`);
    try {
      const { sha } = forge.mergePull(repo, pull, 'squash');
      return { sha, merged: true, message: 'Pull request successfully merged' };
    } catch (error) {
      if (error instanceof ForgeError) throw new McpDomainError(error.message);
      throw error;
    }
  },
  get_issue: (forge, args) => {
    const repo = resolveRepo(forge, args);
    const number = requiredNumber(args, 'issue_number');
    const issue = repo.issues.get(number);
    if (!issue) throw new McpDomainError(`Issue #${number} not found`);
    return issueShape(forge, repo, issue);
  },
  list_pull_requests: (forge, args) => {
    const repo = resolveRepo(forge, args);
    const state = optionalString(args, 'state') ?? 'open';
    const pulls = [...repo.pulls.values()]
      .filter((pull) => state === 'all' || pull.state === state)
      .sort((a, b) => b.number - a.number);
    return { pull_requests: pulls.map((pull) => pullShape(forge, repo, pull)) };
  },
  get_file_contents: (forge, args) => {
    const repo = resolveRepo(forge, args);
    const path = requiredString(args, 'path');
    const ref = optionalString(args, 'ref');
    const found = forge.readContents(repo, ref, path);
    if (!found || found.kind !== 'file') throw new McpDomainError(`File ${path} not found`);
    const object = forge.getObject(found.oid);
    const data = object?.data ?? Buffer.alloc(0);
    return { path, sha: found.oid, size: data.length, encoding: 'base64', content: data.toString('base64') };
  },
  add_issue_comment: (forge, args) => {
    const repo = resolveRepo(forge, args);
    const number = requiredNumber(args, 'issue_number');
    const body = requiredString(args, 'body');
    const issue = repo.issues.get(number);
    if (!issue) throw new McpDomainError(`Issue #${number} not found`);
    const comment = forge.addIssueComment(repo, issue, body);
    return { id: comment.id, body: comment.body };
  },
};

function findHandler(name: string): ToolHandler | undefined {
  if (TOOL_HANDLERS[name]) return TOOL_HANDLERS[name];
  // Tolerate a server prefix (`github__create_issue`).
  const suffix = name.split('__').pop()!;
  if (suffix !== name && TOOL_HANDLERS[suffix]) return TOOL_HANDLERS[suffix];
  return undefined;
}

// ---------------------------------------------------------------------------
// JSON-RPC dispatcher
// ---------------------------------------------------------------------------

type JsonRpcId = string | number | null;

function rpcResult(id: JsonRpcId, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: JsonRpcId, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

export function handleMcp(forge: Forge, bodyText: string): McpResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { status: 400, json: rpcError(null, -32700, 'Parse error: request body is not valid JSON') };
  }
  if (Array.isArray(parsed)) {
    return { status: 400, json: rpcError(null, -32600, 'Batch requests are not supported') };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { status: 400, json: rpcError(null, -32600, 'Request must be a JSON-RPC object') };
  }
  const request = parsed as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
  const hasId = 'id' in request && request.id !== undefined;
  const id: JsonRpcId = hasId ? (request.id as string | number) : null;
  if (typeof request.method !== 'string') {
    if (!hasId) return { status: 202, empty: true };
    return { status: 200, json: rpcError(id, -32600, 'Request method must be a string') };
  }
  const method = request.method;
  const params = asRecord(request.params);

  // Notifications (no id) are acknowledged without a body.
  if (!hasId) {
    return { status: 202, empty: true };
  }

  switch (method) {
    case 'server/discover': {
      const serverInfo = { name: SERVER_NAME, version: SERVER_VERSION };
      return {
        status: 200,
        json: rpcResult(id, {
          supportedVersions: [MODERN_REVISION],
          capabilities: { tools: {} },
          serverInfo,
          _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
        }),
      };
    }
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const protocolVersion = /^\d{4}-\d{2}-\d{2}$/.test(requested) ? requested : '2025-11-25';
      return {
        status: 200,
        json: rpcResult(id, {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        }),
      };
    }
    case 'ping':
      return { status: 200, json: rpcResult(id, {}) };
    case 'tools/list':
      return { status: 200, json: rpcResult(id, { tools: TOOLS }) };
    case 'tools/call': {
      const name = params.name;
      if (typeof name !== 'string' || name === '') {
        return { status: 200, json: rpcError(id, -32602, 'tools/call requires a tool name') };
      }
      const handler = findHandler(name);
      if (!handler) {
        return { status: 200, json: rpcError(id, -32602, `Unknown tool ${JSON.stringify(name)}`) };
      }
      const args = asRecord(params.arguments);
      try {
        const output = handler(forge, args);
        const text = typeof output === 'string' ? output : JSON.stringify(output);
        return {
          status: 200,
          json: rpcResult(id, {
            content: [{ type: 'text', text }],
            structuredContent: output,
          }),
        };
      } catch (error) {
        if (error instanceof McpArgumentError) {
          return { status: 200, json: rpcError(id, -32602, error.message) };
        }
        if (error instanceof McpDomainError) {
          return {
            status: 200,
            json: rpcResult(id, {
              content: [{ type: 'text', text: error.message }],
              structuredContent: { error: error.message },
              isError: true,
            }),
          };
        }
        throw error;
      }
    }
    default:
      return { status: 200, json: rpcError(id, -32601, `Method not found: ${method}`) };
  }
}

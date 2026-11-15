/**
 * graphql.ts — a self-contained GraphQL implementation: tokenizer, parser,
 * schema-driven validator and executor.
 *
 * One schema table drives everything: validation (unknown fields are
 * rejected with the field's name in the message), introspection (`__type`
 * reads the same table) and execution (a resolver map per type). Values flow
 * as small wrappers carrying their runtime type (`__kind`), which is what
 * lets `node(id:)` and inline fragments resolve interface types correctly.
 *
 * Supported: queries, mutations, variables, aliases, named + inline
 * fragments, lists/objects/enums/null literals, batched operations.
 * Directives are parsed and ignored; subscriptions are rejected.
 */

import {
  FORGE_EPOCH_ISO,
  ForgeError,
  type Forge,
  type Issue,
  type PullRequest,
  type Repo,
} from './core.ts';

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type TokenKind = 'name' | 'int' | 'float' | 'string' | 'punct' | 'eof';

interface Token {
  kind: TokenKind;
  value: string;
}

export class GqlSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GqlSyntaxError';
  }
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (ch: string): boolean => /[A-Za-z_]/.test(ch);
  const isNameChar = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch);
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '﻿') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|&'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let value = '';
      i += 1;
      let closed = false;
      while (i < source.length) {
        const c = source[i]!;
        if (c === '"') {
          closed = true;
          i += 1;
          break;
        }
        if (c === '\\') {
          const next = source[i + 1];
          if (next === undefined) break;
          const escapes: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
          if (next === 'u') {
            const hex = source.slice(i + 2, i + 6);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new GqlSyntaxError('Invalid unicode escape in string');
            value += String.fromCharCode(Number.parseInt(hex, 16));
            i += 6;
          } else if (next in escapes) {
            value += escapes[next]!;
            i += 2;
          } else {
            throw new GqlSyntaxError(`Invalid escape \\${next} in string`);
          }
          continue;
        }
        if (c === '\n') throw new GqlSyntaxError('Unterminated string');
        value += c;
        i += 1;
      }
      if (!closed) throw new GqlSyntaxError('Unterminated string');
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (isNameStart(ch)) {
      let j = i + 1;
      while (j < source.length && isNameChar(source[j]!)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (ch === '-' || /[0-9]/.test(ch)) {
      const match = /^-?(?:0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(source.slice(i));
      if (!match) throw new GqlSyntaxError(`Invalid number at offset ${i}`);
      const text = match[0];
      tokens.push({ kind: match[1] || match[2] ? 'float' : 'int', value: text });
      i += text.length;
      continue;
    }
    throw new GqlSyntaxError(`Unexpected character ${JSON.stringify(ch)} at offset ${i}`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// ---------------------------------------------------------------------------
// AST + parser
// ---------------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'enum'; value: string }
  | { kind: 'null' }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface ArgumentNode {
  name: string;
  value: ValueNode;
}

type SelectionNode =
  | { kind: 'field'; alias: string | undefined; name: string; args: ArgumentNode[]; selections: SelectionNode[] }
  | { kind: 'fragmentSpread'; name: string; selections: SelectionNode[] }
  | { kind: 'inlineFragment'; typeCondition: string | undefined; selections: SelectionNode[] };

interface VariableDefinition {
  name: string;
  defaultValue: ValueNode | undefined;
}

interface OperationDefinition {
  kind: 'operation';
  operation: 'query' | 'mutation' | 'subscription';
  name: string | undefined;
  variableDefinitions: VariableDefinition[];
  selections: SelectionNode[];
}

interface FragmentDefinition {
  kind: 'fragment';
  name: string;
  typeCondition: string;
  selections: SelectionNode[];
}

type Definition = OperationDefinition | FragmentDefinition;

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private next(): Token {
    const token = this.tokens[this.pos]!;
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new GqlSyntaxError(`Expected "${value}" but got ${JSON.stringify(token.value)}`);
    }
  }

  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name') throw new GqlSyntaxError(`Expected a name but got ${JSON.stringify(token.value)}`);
    if (value !== undefined && token.value !== value) throw new GqlSyntaxError(`Expected "${value}" but got "${token.value}"`);
    return token.value;
  }

  private skipDirectives(): void {
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseArguments();
    }
  }

  parseDocument(): Definition[] {
    const definitions: Definition[] = [];
    while (this.peek().kind !== 'eof') definitions.push(this.parseDefinition());
    return definitions;
  }

  private parseDefinition(): Definition {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '{') {
      return { kind: 'operation', operation: 'query', name: undefined, variableDefinitions: [], selections: this.parseSelectionSet() };
    }
    if (token.kind === 'name' && token.value === 'fragment') {
      this.next();
      const name = this.expectName();
      if (name === 'on') throw new GqlSyntaxError('Fragment name cannot be "on"');
      this.expectName('on');
      const typeCondition = this.expectName();
      this.skipDirectives();
      return { kind: 'fragment', name, typeCondition, selections: this.parseSelectionSet() };
    }
    if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
      const operation = this.next().value as 'query' | 'mutation' | 'subscription';
      let name: string | undefined;
      if (this.peek().kind === 'name') name = this.next().value;
      let variableDefinitions: VariableDefinition[] = [];
      if (this.peek().kind === 'punct' && this.peek().value === '(') variableDefinitions = this.parseVariableDefinitions();
      this.skipDirectives();
      return { kind: 'operation', operation, name, variableDefinitions, selections: this.parseSelectionSet() };
    }
    throw new GqlSyntaxError(`Unexpected token ${JSON.stringify(token.value)} at document level`);
  }

  private parseVariableDefinitions(): VariableDefinition[] {
    this.expectPunct('(');
    const definitions: VariableDefinition[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      this.parseType();
      let defaultValue: ValueNode | undefined;
      if (this.peek().kind === 'punct' && this.peek().value === '=') {
        this.next();
        defaultValue = this.parseValue(true);
      }
      this.skipDirectives();
      definitions.push({ name, defaultValue });
    }
    this.expectPunct(')');
    return definitions;
  }

  private parseType(): void {
    if (this.peek().kind === 'punct' && this.peek().value === '[') {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.peek().kind === 'punct' && this.peek().value === '!') this.next();
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.peek().kind === 'punct' && this.peek().value === '...') {
      this.next();
      if (this.peek().kind === 'name' && this.peek().value !== 'on') {
        const name = this.next().value;
        this.skipDirectives();
        return { kind: 'fragmentSpread', name, selections: [] };
      }
      let typeCondition: string | undefined;
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        typeCondition = this.expectName();
      }
      this.skipDirectives();
      return { kind: 'inlineFragment', typeCondition, selections: this.parseSelectionSet() };
    }
    const first = this.expectName();
    let alias: string | undefined;
    let name = first;
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      alias = first;
      name = this.expectName();
    }
    let args: ArgumentNode[] = [];
    if (this.peek().kind === 'punct' && this.peek().value === '(') args = this.parseArguments();
    this.skipDirectives();
    let selections: SelectionNode[] = [];
    if (this.peek().kind === 'punct' && this.peek().value === '{') selections = this.parseSelectionSet();
    return { kind: 'field', alias, name, args, selections };
  }

  private parseArguments(): ArgumentNode[] {
    this.expectPunct('(');
    const args: ArgumentNode[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue(false) });
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(isConst: boolean): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$' && !isConst) {
      return { kind: 'variable', name: this.expectName() };
    }
    if (token.kind === 'int') return { kind: 'int', value: token.value };
    if (token.kind === 'float') return { kind: 'float', value: token.value };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) values.push(this.parseValue(isConst));
      this.next();
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue(isConst) });
      }
      this.next();
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new GqlSyntaxError(`Unexpected value token ${JSON.stringify(token.value)}`);
  }
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

type TypeKind = 'object' | 'interface' | 'enum' | 'scalar';

interface TypeDef {
  kind: TypeKind;
  /** Field name -> return type ('String', '[Issue]', ...). */
  fields?: Record<string, string>;
  values?: string[];
}

const SCALARS = ['String', 'Int', 'Boolean', 'ID'];

const SCHEMA: Record<string, TypeDef> = {
  Query: {
    kind: 'object',
    fields: {
      viewer: 'User',
      repository: 'Repository',
      node: 'Node',
      __type: '__Type',
      __schema: '__Schema',
      rateLimit: 'RateLimit',
    },
  },
  Mutation: {
    kind: 'object',
    fields: {
      createIssue: 'CreateIssuePayload',
      closeIssue: 'CloseIssuePayload',
      createPullRequest: 'CreatePullRequestPayload',
      mergePullRequest: 'MergePullRequestPayload',
      addComment: 'AddCommentPayload',
    },
  },
  Node: { kind: 'interface', fields: { id: 'ID' } },
  Repository: {
    kind: 'object',
    fields: {
      id: 'ID',
      databaseId: 'Int',
      name: 'String',
      nameWithOwner: 'String',
      owner: 'User',
      defaultBranchRef: 'Ref',
      viewerPermission: 'RepositoryPermission',
      hasIssuesEnabled: 'Boolean',
      issue: 'Issue',
      issues: 'IssueConnection',
      pullRequests: 'PullRequestConnection',
      pullRequest: 'PullRequest',
      description: 'String',
      isPrivate: 'Boolean',
      url: 'String',
      labels: 'LabelConnection',
    },
  },
  User: { kind: 'object', fields: { login: 'String', id: 'ID', name: 'String', email: 'String' } },
  Ref: { kind: 'object', fields: { name: 'String' } },
  Issue: {
    kind: 'object',
    fields: {
      id: 'ID',
      number: 'Int',
      title: 'String',
      state: 'IssueState',
      body: 'String',
      labels: 'LabelConnection',
      comments: 'IssueCommentConnection',
      author: 'User',
      createdAt: 'String',
      closedAt: 'String',
    },
  },
  IssueConnection: { kind: 'object', fields: { nodes: '[Issue]', pageInfo: 'PageInfo', totalCount: 'Int' } },
  PullRequest: {
    kind: 'object',
    fields: {
      id: 'ID',
      number: 'Int',
      title: 'String',
      state: 'PullRequestState',
      merged: 'Boolean',
      headRefName: 'String',
      baseRefName: 'String',
      mergeable: 'MergeableState',
      files: 'PullRequestChangedFileConnection',
      body: 'String',
      author: 'User',
      mergedAt: 'String',
    },
  },
  PullRequestConnection: { kind: 'object', fields: { nodes: '[PullRequest]', pageInfo: 'PageInfo', totalCount: 'Int' } },
  PullRequestChangedFileConnection: { kind: 'object', fields: { nodes: '[PullRequestChangedFile]', pageInfo: 'PageInfo', totalCount: 'Int' } },
  PullRequestChangedFile: {
    kind: 'object',
    fields: { path: 'String', additions: 'Int', deletions: 'Int', changeType: 'String' },
  },
  PageInfo: {
    kind: 'object',
    fields: { hasNextPage: 'Boolean', hasPreviousPage: 'Boolean', startCursor: 'String', endCursor: 'String' },
  },
  LabelConnection: { kind: 'object', fields: { nodes: '[Label]', totalCount: 'Int' } },
  Label: { kind: 'object', fields: { id: 'ID', name: 'String', color: 'String' } },
  IssueCommentConnection: { kind: 'object', fields: { nodes: '[IssueComment]', pageInfo: 'PageInfo', totalCount: 'Int' } },
  IssueComment: { kind: 'object', fields: { id: 'ID', body: 'String', author: 'User' } },
  IssueCommentEdge: { kind: 'object', fields: { node: 'IssueComment', cursor: 'String' } },
  CreateIssuePayload: { kind: 'object', fields: { issue: 'Issue' } },
  CloseIssuePayload: { kind: 'object', fields: { issue: 'Issue' } },
  CreatePullRequestPayload: { kind: 'object', fields: { pullRequest: 'PullRequest' } },
  MergePullRequestPayload: { kind: 'object', fields: { pullRequest: 'PullRequest' } },
  AddCommentPayload: { kind: 'object', fields: { commentEdge: 'IssueCommentEdge' } },
  RateLimit: {
    kind: 'object',
    fields: { limit: 'Int', cost: 'Int', remaining: 'Int', resetAt: 'String', used: 'Int' },
  },
  __Schema: {
    kind: 'object',
    fields: { queryType: '__Type', mutationType: '__Type', subscriptionType: '__Type', types: '[__Type]', directives: '[__Directive]' },
  },
  __Type: {
    kind: 'object',
    fields: { name: 'String', kind: 'String', description: 'String', fields: '[__Field]', enumValues: '[__EnumValue]' },
  },
  __Field: {
    kind: 'object',
    fields: { name: 'String', description: 'String', type: '__Type', args: '[__InputValue]' },
  },
  __InputValue: { kind: 'object', fields: { name: 'String', description: 'String', type: '__Type' } },
  __EnumValue: { kind: 'object', fields: { name: 'String', description: 'String' } },
  __Directive: {
    kind: 'object',
    fields: { name: 'String', description: 'String', locations: '[String]', args: '[__InputValue]' },
  },
  IssueState: { kind: 'enum', values: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'enum', values: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'enum', values: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  PullRequestMergeMethod: { kind: 'enum', values: ['MERGE', 'SQUASH', 'REBASE'] },
  RepositoryPermission: { kind: 'enum', values: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  SearchType: { kind: 'enum', values: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE'] },
  IssueOrderField: { kind: 'enum', values: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  OrderDirection: { kind: 'enum', values: ['ASC', 'DESC'] },
};

for (const scalar of SCALARS) SCHEMA[scalar] = { kind: 'scalar' };

const NODE_TYPES = new Set(['Repository', 'Issue', 'PullRequest', 'User']);

function isComposite(typeName: string): boolean {
  const def = SCHEMA[typeName];
  return def !== undefined && (def.kind === 'object' || def.kind === 'interface');
}

function unwrapList(typeName: string): { inner: string; isList: boolean } {
  if (typeName.startsWith('[') && typeName.endsWith(']')) {
    return { inner: typeName.slice(1, -1), isList: true };
  }
  return { inner: typeName, isList: false };
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

type Variables = Record<string, unknown>;

function valueFromAst(node: ValueNode, variables: Variables): unknown {
  switch (node.kind) {
    case 'variable': {
      const value = variables[node.name];
      return value === undefined ? null : value;
    }
    case 'int':
      return Number.parseInt(node.value, 10);
    case 'float':
      return Number.parseFloat(node.value);
    case 'string':
    case 'boolean':
    case 'enum':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.values.map((child) => valueFromAst(child, variables));
    case 'object': {
      const result: Record<string, unknown> = {};
      for (const field of node.fields) result[field.name] = valueFromAst(field.value, variables);
      return result;
    }
  }
}

function argValue(args: Record<string, unknown>, name: string): unknown {
  return args[name];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export class GqlFieldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GqlFieldError';
  }
}

function validateSelections(
  selections: readonly SelectionNode[],
  typeName: string,
  fragments: Map<string, FragmentDefinition>,
  errors: string[],
  visitedFragments: Set<string>,
): void {
  const def = SCHEMA[typeName];
  if (!def) {
    errors.push(`Unknown type "${typeName}".`);
    return;
  }
  for (const selection of selections) {
    if (selection.kind === 'field') {
      const fieldName = selection.name;
      if (fieldName === '__typename') {
        if (selection.selections.length > 0) errors.push(`Field "__typename" must not have a selection set.`);
        continue;
      }
      const returnType = def.fields?.[fieldName];
      if (returnType === undefined) {
        errors.push(`Cannot query field "${fieldName}" on type "${typeName}".`);
        continue;
      }
      const { inner } = unwrapList(returnType);
      if (isComposite(inner)) {
        if (selection.selections.length === 0) {
          errors.push(`Field "${fieldName}" of type "${returnType}" must have a selection of subfields.`);
        } else {
          validateSelections(selection.selections, inner, fragments, errors, new Set(visitedFragments));
        }
      } else if (selection.selections.length > 0) {
        errors.push(`Field "${fieldName}" must not have a selection of subfields.`);
      }
      continue;
    }
    if (selection.kind === 'fragmentSpread') {
      const fragment = fragments.get(selection.name);
      if (!fragment) {
        errors.push(`Unknown fragment "${selection.name}".`);
        continue;
      }
      if (visitedFragments.has(selection.name)) continue;
      visitedFragments.add(selection.name);
      validateSelections(fragment.selections, fragment.typeCondition, fragments, errors, visitedFragments);
      continue;
    }
    // Inline fragment.
    const condition = selection.typeCondition ?? typeName;
    if (!SCHEMA[condition]) {
      errors.push(`Unknown type "${condition}".`);
      continue;
    }
    validateSelections(selection.selections, condition, fragments, errors, new Set(visitedFragments));
  }
}

// ---------------------------------------------------------------------------
// Execution values + cursors
// ---------------------------------------------------------------------------

type GqlValue = Record<string, unknown> & { __kind: string };

function encodeCursor(tag: string, key: string): string {
  return Buffer.from(`cursor:${tag}:${key}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string, tag: string): string | null {
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const prefix = `cursor:${tag}:`;
    return raw.startsWith(prefix) ? raw.slice(prefix.length) : null;
  } catch {
    return null;
  }
}

interface Page<T> {
  window: T[];
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  startCursor: string | null;
  endCursor: string | null;
}

function paginate<T>(items: readonly T[], keyOf: (item: T) => string, tag: string, first: number | undefined, after: string | null | undefined): Page<T> {
  let startIndex = 0;
  if (typeof after === 'string' && after !== '') {
    const key = decodeCursor(after, tag);
    if (key !== null) {
      const index = items.findIndex((item) => keyOf(item) === key);
      if (index >= 0) startIndex = index + 1;
    }
  }
  const limit = first === undefined || first === null ? items.length : Math.max(0, first);
  const window = items.slice(startIndex, startIndex + limit);
  const endIndex = startIndex + window.length;
  return {
    window,
    hasNextPage: endIndex < items.length,
    hasPreviousPage: startIndex > 0,
    startCursor: window.length > 0 ? encodeCursor(tag, keyOf(window[0]!)) : null,
    endCursor: window.length > 0 ? encodeCursor(tag, keyOf(window[window.length - 1]!)) : null,
  };
}

function pageInfoValue(page: Page<unknown>): GqlValue {
  return {
    __kind: 'PageInfo',
    hasNextPage: page.hasNextPage,
    hasPreviousPage: page.hasPreviousPage,
    startCursor: page.startCursor,
    endCursor: page.endCursor,
  };
}

// ---------------------------------------------------------------------------
// Resolvers
// ---------------------------------------------------------------------------

interface Ctx {
  forge: Forge;
  variables: Variables;
}

type Resolver = (parent: GqlValue, args: Record<string, unknown>, ctx: Ctx) => unknown;

function userValue(forge: Forge, login: string): GqlValue {
  return { __kind: 'User', login, id: forge.userGlobalId(login) };
}

function issueValue(repo: Repo, issue: Issue): GqlValue {
  return { __kind: 'Issue', repo, issue };
}

function pullValue(repo: Repo, pull: PullRequest): GqlValue {
  return { __kind: 'PullRequest', repo, pull };
}

function repoValue(repo: Repo): GqlValue {
  return { __kind: 'Repository', repo };
}

function orderIssues(issues: Issue[], orderBy: unknown): Issue[] {
  const input = asRecord(orderBy);
  const field = typeof input?.field === 'string' ? input.field : 'CREATED_AT';
  const direction = typeof input?.direction === 'string' ? input.direction : 'DESC';
  const key = (issue: Issue): number =>
    field === 'UPDATED_AT' ? issue.updatedSeq : field === 'COMMENTS' ? issue.comments.length : issue.createdSeq;
  const sorted = [...issues];
  sorted.sort((a, b) => {
    const diff = key(a) - key(b);
    if (diff !== 0) return direction === 'ASC' ? diff : -diff;
    return direction === 'ASC' ? a.number - b.number : b.number - a.number;
  });
  return sorted;
}

function orderPulls(pulls: PullRequest[], orderBy: unknown): PullRequest[] {
  const input = asRecord(orderBy);
  const field = typeof input?.field === 'string' ? input.field : 'CREATED_AT';
  const direction = typeof input?.direction === 'string' ? input.direction : 'DESC';
  const key = (pull: PullRequest): number =>
    field === 'UPDATED_AT' ? pull.updatedSeq : field === 'COMMENTS' ? pull.comments.length : pull.createdSeq;
  const sorted = [...pulls];
  sorted.sort((a, b) => {
    const diff = key(a) - key(b);
    if (diff !== 0) return direction === 'ASC' ? diff : -diff;
    return direction === 'ASC' ? a.number - b.number : b.number - a.number;
  });
  return sorted;
}

function decodeEntityId(forge: Forge, id: unknown, expectedKind: string): { repo: Repo; number: number } | { repo: Repo } | null {
  if (typeof id !== 'string') return null;
  const decoded = forge.decodeGlobalId(id);
  if (!decoded || decoded.kind !== expectedKind) return null;
  const repo = forge.getRepo(forge.viewerLogin, decoded.parts[0] ?? '');
  if (!repo) return null;
  if (expectedKind === 'Repository') return { repo };
  const number = Number.parseInt(decoded.parts[1] ?? '', 10);
  if (!Number.isFinite(number)) return null;
  return { repo, number };
}

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: (_parent, _args, ctx) => userValue(ctx.forge, ctx.forge.viewerLogin),
    repository: (_parent, args, ctx) => {
      const owner = argValue(args, 'owner');
      const name = argValue(args, 'name');
      if (typeof owner !== 'string' || typeof name !== 'string') return null;
      const repo = ctx.forge.getRepo(owner, name);
      return repo ? repoValue(repo) : null;
    },
    node: (_parent, args, ctx) => {
      const id = argValue(args, 'id');
      if (typeof id !== 'string') return null;
      const decoded = ctx.forge.decodeGlobalId(id);
      if (!decoded) return null;
      if (decoded.kind === 'Repository') {
        const repo = ctx.forge.getRepo(ctx.forge.viewerLogin, decoded.parts[0] ?? '');
        return repo ? repoValue(repo) : null;
      }
      if (decoded.kind === 'User') {
        return userValue(ctx.forge, decoded.parts[0] ?? ctx.forge.viewerLogin);
      }
      if (decoded.kind === 'Issue' || decoded.kind === 'PullRequest') {
        const repo = ctx.forge.getRepo(ctx.forge.viewerLogin, decoded.parts[0] ?? '');
        if (!repo) return null;
        const number = Number.parseInt(decoded.parts[1] ?? '', 10);
        if (decoded.kind === 'Issue') {
          const issue = repo.issues.get(number);
          return issue ? issueValue(repo, issue) : null;
        }
        const pull = repo.pulls.get(number);
        return pull ? pullValue(repo, pull) : null;
      }
      return null;
    },
    __type: (_parent, args, _ctx) => {
      const name = argValue(args, 'name');
      if (typeof name !== 'string' || !SCHEMA[name]) return null;
      return { __kind: '__Type', name };
    },
    __schema: () => ({ __kind: '__Schema' }),
    rateLimit: () => ({ __kind: 'RateLimit' }),
  },
  Mutation: {
    createIssue: (_parent, args, ctx) => {
      const input = asRecord(argValue(args, 'input'));
      if (!input) throw new GqlFieldError('createIssue requires an input object');
      const target = decodeEntityId(ctx.forge, input.repositoryId, 'Repository');
      if (!target) throw new GqlFieldError('repositoryId does not identify a repository');
      const title = typeof input.title === 'string' ? input.title : '';
      const body = typeof input.body === 'string' ? input.body : '';
      try {
        const issue = ctx.forge.createIssue(target.repo, title, body, []);
        return { __kind: 'CreateIssuePayload', repo: target.repo, issue };
      } catch (error) {
        if (error instanceof ForgeError) throw new GqlFieldError(error.message);
        throw error;
      }
    },
    closeIssue: (_parent, args, ctx) => {
      const input = asRecord(argValue(args, 'input'));
      if (!input) throw new GqlFieldError('closeIssue requires an input object');
      const target = decodeEntityId(ctx.forge, input.issueId, 'Issue') as { repo: Repo; number: number } | null;
      if (!target) throw new GqlFieldError('issueId does not identify an issue');
      const issue = target.repo.issues.get(target.number);
      if (!issue) throw new GqlFieldError('issueId does not identify an issue');
      ctx.forge.patchIssue(target.repo, issue, { state: 'closed' });
      return { __kind: 'CloseIssuePayload', repo: target.repo, issue };
    },
    createPullRequest: (_parent, args, ctx) => {
      const input = asRecord(argValue(args, 'input'));
      if (!input) throw new GqlFieldError('createPullRequest requires an input object');
      const target = decodeEntityId(ctx.forge, input.repositoryId, 'Repository');
      if (!target) throw new GqlFieldError('repositoryId does not identify a repository');
      const title = typeof input.title === 'string' ? input.title : '';
      const body = typeof input.body === 'string' ? input.body : '';
      const headRefName = typeof input.headRefName === 'string' ? input.headRefName : '';
      const baseRefName = typeof input.baseRefName === 'string' ? input.baseRefName : '';
      try {
        const pull = ctx.forge.createPull(target.repo, title, body, headRefName, baseRefName);
        return { __kind: 'CreatePullRequestPayload', repo: target.repo, pull };
      } catch (error) {
        if (error instanceof ForgeError) throw new GqlFieldError(error.message);
        throw error;
      }
    },
    mergePullRequest: (_parent, args, ctx) => {
      const input = asRecord(argValue(args, 'input'));
      if (!input) throw new GqlFieldError('mergePullRequest requires an input object');
      const target = decodeEntityId(ctx.forge, input.pullRequestId, 'PullRequest') as { repo: Repo; number: number } | null;
      if (!target) throw new GqlFieldError('pullRequestId does not identify a pull request');
      const pull = target.repo.pulls.get(target.number);
      if (!pull) throw new GqlFieldError('pullRequestId does not identify a pull request');
      const method = typeof input.mergeMethod === 'string' ? input.mergeMethod : 'SQUASH';
      if (method !== 'SQUASH' && method !== 'MERGE') {
        throw new GqlFieldError(`Merge method ${method} is not supported`);
      }
      try {
        ctx.forge.mergePull(target.repo, pull, method === 'MERGE' ? 'merge' : 'squash');
      } catch (error) {
        if (error instanceof ForgeError) throw new GqlFieldError(error.message);
        throw error;
      }
      return { __kind: 'MergePullRequestPayload', repo: target.repo, pull };
    },
    addComment: (_parent, args, ctx) => {
      const input = asRecord(argValue(args, 'input'));
      if (!input) throw new GqlFieldError('addComment requires an input object');
      const body = typeof input.body === 'string' ? input.body : '';
      const subjectId = input.subjectId;
      if (typeof subjectId !== 'string') throw new GqlFieldError('subjectId is required');
      const decoded = ctx.forge.decodeGlobalId(subjectId);
      if (!decoded) throw new GqlFieldError('subjectId is not a valid global id');
      const repo = ctx.forge.getRepo(ctx.forge.viewerLogin, decoded.parts[0] ?? '');
      if (!repo) throw new GqlFieldError('subjectId does not identify a repository');
      const number = Number.parseInt(decoded.parts[1] ?? '', 10);
      if (decoded.kind === 'Issue') {
        const issue = repo.issues.get(number);
        if (!issue) throw new GqlFieldError('subjectId does not identify an issue');
        const comment = ctx.forge.addIssueComment(repo, issue, body);
        return {
          __kind: 'AddCommentPayload',
          commentEdge: { __kind: 'IssueCommentEdge', repo, ownerNumber: number, comment, cursor: encodeCursor('comment', String(comment.id)) },
        };
      }
      if (decoded.kind === 'PullRequest') {
        const pull = repo.pulls.get(number);
        if (!pull) throw new GqlFieldError('subjectId does not identify a pull request');
        const comment = ctx.forge.addPullComment(repo, pull, body);
        return {
          __kind: 'AddCommentPayload',
          commentEdge: { __kind: 'IssueCommentEdge', repo, ownerNumber: number, comment, cursor: encodeCursor('comment', String(comment.id)) },
        };
      }
      throw new GqlFieldError('subjectId must identify an issue or a pull request');
    },
  },
  Repository: {
    id: (parent, _args, ctx) => ctx.forge.repoGlobalId(parent.repo as Repo),
    databaseId: (parent) => (parent.repo as Repo).id,
    name: (parent) => (parent.repo as Repo).name,
    nameWithOwner: (parent) => `${(parent.repo as Repo).owner}/${(parent.repo as Repo).name}`,
    owner: (_parent, _args, ctx) => userValue(ctx.forge, ctx.forge.viewerLogin),
    defaultBranchRef: (parent, _args, ctx) => {
      const repo = parent.repo as Repo;
      if (!ctx.forge.branchTip(repo, repo.defaultBranch)) return null;
      return { __kind: 'Ref', name: repo.defaultBranch };
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    issue: (parent, args) => {
      const repo = parent.repo as Repo;
      const number = argValue(args, 'number');
      if (typeof number !== 'number') return null;
      const issue = repo.issues.get(number);
      return issue ? issueValue(repo, issue) : null;
    },
    issues: (parent, args) => {
      const repo = parent.repo as Repo;
      const states = argValue(args, 'states');
      let issues = [...repo.issues.values()];
      if (Array.isArray(states) && states.length > 0) {
        const wanted = new Set(states.filter((entry): entry is string => typeof entry === 'string'));
        issues = issues.filter((issue) => wanted.has(issue.state === 'open' ? 'OPEN' : 'CLOSED'));
      }
      const ordered = orderIssues(issues, argValue(args, 'orderBy'));
      const first = argValue(args, 'first');
      const after = argValue(args, 'after');
      const page = paginate(ordered, (issue) => String(issue.number), 'issue', typeof first === 'number' ? first : undefined, typeof after === 'string' ? after : null);
      return { __kind: 'IssueConnection', repo, page, total: ordered.length };
    },
    pullRequests: (parent, args) => {
      const repo = parent.repo as Repo;
      const states = argValue(args, 'states');
      let pulls = [...repo.pulls.values()];
      if (Array.isArray(states) && states.length > 0) {
        const wanted = new Set(states.filter((entry): entry is string => typeof entry === 'string'));
        pulls = pulls.filter((pull) => {
          const state = pull.merged ? 'MERGED' : pull.state === 'closed' ? 'CLOSED' : 'OPEN';
          return wanted.has(state);
        });
      }
      const ordered = orderPulls(pulls, argValue(args, 'orderBy'));
      const first = argValue(args, 'first');
      const after = argValue(args, 'after');
      const page = paginate(ordered, (pull) => String(pull.number), 'pull', typeof first === 'number' ? first : undefined, typeof after === 'string' ? after : null);
      return { __kind: 'PullRequestConnection', repo, page, total: ordered.length };
    },
    pullRequest: (parent, args) => {
      const repo = parent.repo as Repo;
      const number = argValue(args, 'number');
      if (typeof number !== 'number') return null;
      const pull = repo.pulls.get(number);
      return pull ? pullValue(repo, pull) : null;
    },
    description: (parent) => (parent.repo as Repo).description,
    isPrivate: (parent) => (parent.repo as Repo).isPrivate,
    url: (parent) => `https://example.invalid/${(parent.repo as Repo).owner}/${(parent.repo as Repo).name}`,
    labels: (parent, args) => {
      const repo = parent.repo as Repo;
      const labels = [...repo.labels.values()];
      const first = argValue(args, 'first');
      const window = typeof first === 'number' ? labels.slice(0, Math.max(0, first)) : labels;
      return { __kind: 'LabelConnection', labels: window, totalCount: labels.length };
    },
  },
  User: {
    login: (parent) => parent.login as string,
    id: (parent) => parent.id as string,
    name: (parent) => parent.login as string,
    email: (parent) => `${parent.login as string}@example.invalid`,
  },
  Ref: {
    name: (parent) => parent.name as string,
  },
  Issue: {
    id: (parent, _args, ctx) => ctx.forge.issueGlobalId(parent.repo as Repo, parent.issue as Issue),
    number: (parent) => (parent.issue as Issue).number,
    title: (parent) => (parent.issue as Issue).title,
    state: (parent) => ((parent.issue as Issue).state === 'open' ? 'OPEN' : 'CLOSED'),
    body: (parent) => (parent.issue as Issue).body,
    labels: (parent) => {
      const repo = parent.repo as Repo;
      const issue = parent.issue as Issue;
      const labels = issue.labelNames.map((name) => repo.labels.get(name)!).filter(Boolean);
      return { __kind: 'LabelConnection', labels, totalCount: labels.length };
    },
    comments: (parent, args) => {
      const repo = parent.repo as Repo;
      const issue = parent.issue as Issue;
      const first = argValue(args, 'first');
      const after = argValue(args, 'after');
      const page = paginate(issue.comments, (comment) => String(comment.id), 'comment', typeof first === 'number' ? first : undefined, typeof after === 'string' ? after : null);
      return { __kind: 'IssueCommentConnection', repo, ownerNumber: issue.number, page, total: issue.comments.length };
    },
    author: (_parent, _args, ctx) => userValue(ctx.forge, ctx.forge.viewerLogin),
    createdAt: () => FORGE_EPOCH_ISO,
    closedAt: (parent) => (parent.issue as Issue).closedAt,
  },
  IssueConnection: {
    nodes: (parent) => {
      const page = parent.page as Page<Issue>;
      return page.window.map((issue) => issueValue(parent.repo as Repo, issue));
    },
    pageInfo: (parent) => pageInfoValue(parent.page as Page<unknown>),
    totalCount: (parent) => parent.total as number,
  },
  PullRequest: {
    id: (parent, _args, ctx) => ctx.forge.pullGlobalId(parent.repo as Repo, parent.pull as PullRequest),
    number: (parent) => (parent.pull as PullRequest).number,
    title: (parent) => (parent.pull as PullRequest).title,
    state: (parent) => {
      const pull = parent.pull as PullRequest;
      return pull.merged ? 'MERGED' : pull.state === 'closed' ? 'CLOSED' : 'OPEN';
    },
    merged: (parent) => (parent.pull as PullRequest).merged,
    headRefName: (parent) => (parent.pull as PullRequest).headRef,
    baseRefName: (parent) => (parent.pull as PullRequest).baseRef,
    mergeable: (parent, _args, ctx) => ctx.forge.pullMergeable(parent.repo as Repo, parent.pull as PullRequest),
    files: (parent, args, ctx) => {
      const repo = parent.repo as Repo;
      const pull = parent.pull as PullRequest;
      const changes = ctx.forge.pullFiles(repo, pull);
      const first = argValue(args, 'first');
      const after = argValue(args, 'after');
      const page = paginate(changes, (change) => change.filename, 'file', typeof first === 'number' ? first : undefined, typeof after === 'string' ? after : null);
      return { __kind: 'PullRequestChangedFileConnection', page, total: changes.length };
    },
    body: (parent) => (parent.pull as PullRequest).body,
    author: (_parent, _args, ctx) => userValue(ctx.forge, ctx.forge.viewerLogin),
    mergedAt: (parent) => (parent.pull as PullRequest).mergedAt,
  },
  PullRequestConnection: {
    nodes: (parent) => {
      const page = parent.page as Page<PullRequest>;
      return page.window.map((pull) => pullValue(parent.repo as Repo, pull));
    },
    pageInfo: (parent) => pageInfoValue(parent.page as Page<unknown>),
    totalCount: (parent) => parent.total as number,
  },
  PullRequestChangedFileConnection: {
    nodes: (parent) => {
      const page = parent.page as Page<{ filename: string; status: string; additions: number; deletions: number }>;
      return page.window.map((change) => ({ __kind: 'PullRequestChangedFile', change }));
    },
    pageInfo: (parent) => pageInfoValue(parent.page as Page<unknown>),
    totalCount: (parent) => parent.total as number,
  },
  PullRequestChangedFile: {
    path: (parent) => (parent.change as { filename: string }).filename,
    additions: (parent) => (parent.change as { additions: number }).additions,
    deletions: (parent) => (parent.change as { deletions: number }).deletions,
    changeType: (parent) => {
      const status = (parent.change as { status: string }).status;
      return status === 'added' ? 'ADDED' : status === 'removed' ? 'DELETED' : 'MODIFIED';
    },
  },
  PageInfo: {
    hasNextPage: (parent) => parent.hasNextPage as boolean,
    hasPreviousPage: (parent) => parent.hasPreviousPage as boolean,
    startCursor: (parent) => parent.startCursor as string | null,
    endCursor: (parent) => parent.endCursor as string | null,
  },
  LabelConnection: {
    nodes: (parent) => (parent.labels as Array<{ id: number; name: string; color: string }>).map((label) => ({ __kind: 'Label', label })),
    totalCount: (parent) => parent.totalCount as number,
  },
  Label: {
    id: (parent) => `forge-v2:label:${(parent.label as { id: number }).id}`,
    name: (parent) => (parent.label as { name: string }).name,
    color: (parent) => (parent.label as { color: string }).color,
  },
  IssueCommentConnection: {
    nodes: (parent) => {
      const page = parent.page as Page<{ id: number; body: string; authorLogin: string; seq: number }>;
      return page.window.map((comment) => ({ __kind: 'IssueComment', repo: parent.repo as Repo, ownerNumber: parent.ownerNumber as number, comment }));
    },
    pageInfo: (parent) => pageInfoValue(parent.page as Page<unknown>),
    totalCount: (parent) => parent.total as number,
  },
  IssueComment: {
    id: (parent, _args, ctx) =>
      ctx.forge.commentGlobalId(parent.repo as Repo, parent.ownerNumber as number, parent.comment as { id: number; body: string; authorLogin: string; seq: number }),
    body: (parent) => (parent.comment as { body: string }).body,
    author: (_parent, _args, ctx) => userValue(ctx.forge, ctx.forge.viewerLogin),
  },
  IssueCommentEdge: {
    node: (parent) => ({ __kind: 'IssueComment', repo: parent.repo as Repo, ownerNumber: parent.ownerNumber as number, comment: parent.comment }),
    cursor: (parent) => parent.cursor as string,
  },
  CreateIssuePayload: {
    issue: (parent) => issueValue(parent.repo as Repo, parent.issue as Issue),
  },
  CloseIssuePayload: {
    issue: (parent) => issueValue(parent.repo as Repo, parent.issue as Issue),
  },
  CreatePullRequestPayload: {
    pullRequest: (parent) => pullValue(parent.repo as Repo, parent.pull as PullRequest),
  },
  MergePullRequestPayload: {
    pullRequest: (parent) => pullValue(parent.repo as Repo, parent.pull as PullRequest),
  },
  AddCommentPayload: {
    commentEdge: (parent) => parent.commentEdge as GqlValue,
  },
  RateLimit: {
    limit: () => 5000,
    cost: () => 1,
    remaining: () => 4999,
    resetAt: () => FORGE_EPOCH_ISO,
    used: () => 1,
  },
  __Schema: {
    queryType: () => ({ __kind: '__Type', name: 'Query' }),
    mutationType: () => ({ __kind: '__Type', name: 'Mutation' }),
    subscriptionType: () => null,
    types: () => Object.keys(SCHEMA).sort().map((name) => ({ __kind: '__Type', name })),
    directives: () => [],
  },
  __Type: {
    name: (parent) => parent.name as string,
    kind: (parent) => {
      const def = SCHEMA[parent.name as string]!;
      return def.kind === 'object' ? 'OBJECT' : def.kind === 'interface' ? 'INTERFACE' : def.kind === 'enum' ? 'ENUM' : 'SCALAR';
    },
    description: () => null,
    fields: (parent) => {
      const def = SCHEMA[parent.name as string]!;
      if (!def.fields) return [];
      return Object.keys(def.fields).map((fieldName) => ({ __kind: '__Field', typeName: parent.name as string, fieldName }));
    },
    enumValues: (parent) => {
      const def = SCHEMA[parent.name as string]!;
      if (!def.values) return [];
      return def.values.map((value) => ({ __kind: '__EnumValue', name: value }));
    },
  },
  __Field: {
    name: (parent) => parent.fieldName as string,
    description: () => null,
    type: (parent) => {
      const def = SCHEMA[parent.typeName as string]!;
      const returnType = def.fields![parent.fieldName as string]!;
      const { inner } = unwrapList(returnType);
      return { __kind: '__Type', name: inner };
    },
    args: () => [],
  },
  __InputValue: {
    name: (parent) => parent.name as string,
    description: () => null,
    type: () => ({ __kind: '__Type', name: 'String' }),
  },
  __EnumValue: {
    name: (parent) => parent.name as string,
    description: () => null,
  },
  __Directive: {
    name: (parent) => parent.name as string,
    description: () => null,
    locations: () => [],
    args: () => [],
  },
  Node: {
    id: (parent, _args, ctx) => {
      if (parent.__kind === 'Repository') return ctx.forge.repoGlobalId(parent.repo as Repo);
      if (parent.__kind === 'Issue') return ctx.forge.issueGlobalId(parent.repo as Repo, parent.issue as Issue);
      if (parent.__kind === 'PullRequest') return ctx.forge.pullGlobalId(parent.repo as Repo, parent.pull as PullRequest);
      return parent.id as string;
    },
  },
};

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

interface ExecutionState {
  errors: Array<{ message: string; path: Array<string | number> }>;
}

function fragmentApplies(condition: string | undefined, runtimeType: string): boolean {
  if (condition === undefined) return true;
  if (condition === runtimeType) return true;
  if (condition === 'Node' && NODE_TYPES.has(runtimeType)) return true;
  return false;
}

function executeSelections(
  typeName: string,
  value: GqlValue,
  selections: readonly SelectionNode[],
  ctx: Ctx,
  fragments: Map<string, FragmentDefinition>,
  state: ExecutionState,
  path: Array<string | number>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const runtimeType = value.__kind;
  for (const selection of selections) {
    if (selection.kind === 'field') {
      const responseKey = selection.alias ?? selection.name;
      const fieldPath = [...path, responseKey];
      if (selection.name === '__typename') {
        result[responseKey] = runtimeType;
        continue;
      }
      const returnType = SCHEMA[typeName]?.fields?.[selection.name] ?? SCHEMA[runtimeType]?.fields?.[selection.name];
      if (returnType === undefined) {
        state.errors.push({ message: `Cannot query field "${selection.name}" on type "${typeName}".`, path: fieldPath });
        result[responseKey] = null;
        continue;
      }
      const args: Record<string, unknown> = {};
      for (const arg of selection.args) args[arg.name] = valueFromAst(arg.value, ctx.variables);
      let resolved: unknown;
      try {
        const resolver = RESOLVERS[runtimeType]?.[selection.name] ?? RESOLVERS[typeName]?.[selection.name];
        if (!resolver) throw new GqlFieldError(`No resolver for field "${selection.name}" on type "${runtimeType}"`);
        resolved = resolver(value, args, ctx);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Field resolution failed';
        state.errors.push({ message, path: fieldPath });
        result[responseKey] = null;
        continue;
      }
      const { inner, isList } = unwrapList(returnType);
      if (resolved === null || resolved === undefined) {
        result[responseKey] = null;
        continue;
      }
      if (isList) {
        if (!Array.isArray(resolved)) {
          state.errors.push({ message: `Field "${selection.name}" did not return a list.`, path: fieldPath });
          result[responseKey] = null;
          continue;
        }
        if (isComposite(inner)) {
          result[responseKey] = resolved.map((element, index) => {
            if (element === null || element === undefined) return null;
            const elementValue = element as GqlValue;
            return executeSelections(inner, elementValue, selection.selections, ctx, fragments, state, [...fieldPath, index]);
          });
        } else {
          result[responseKey] = resolved;
        }
        continue;
      }
      if (isComposite(inner)) {
        const elementValue = resolved as GqlValue;
        result[responseKey] = executeSelections(inner, elementValue, selection.selections, ctx, fragments, state, fieldPath);
        continue;
      }
      result[responseKey] = resolved;
    } else if (selection.kind === 'fragmentSpread') {
      const fragment = fragments.get(selection.name);
      if (!fragment) {
        state.errors.push({ message: `Unknown fragment "${selection.name}".`, path });
        continue;
      }
      if (!fragmentApplies(fragment.typeCondition, runtimeType)) continue;
      const merged = executeSelections(fragment.typeCondition, value, fragment.selections, ctx, fragments, state, path);
      Object.assign(result, merged);
    } else {
      if (!fragmentApplies(selection.typeCondition, runtimeType)) continue;
      const merged = executeSelections(selection.typeCondition ?? typeName, value, selection.selections, ctx, fragments, state, path);
      Object.assign(result, merged);
    }
  }
  return result;
}

function executeOperation(
  forge: Forge,
  operation: OperationDefinition,
  fragments: Map<string, FragmentDefinition>,
  variables: Variables,
): { data: unknown; errors?: Array<{ message: string; path?: Array<string | number> }> } {
  if (operation.operation === 'subscription') {
    return { data: null, errors: [{ message: 'Subscriptions are not supported.' }] };
  }
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const ctx: Ctx = { forge, variables };
  // Apply variable defaults for missing variables.
  const effectiveVariables: Variables = { ...variables };
  for (const definition of operation.variableDefinitions) {
    if (!(definition.name in effectiveVariables) || effectiveVariables[definition.name] === undefined) {
      if (definition.defaultValue !== undefined) {
        effectiveVariables[definition.name] = valueFromAst(definition.defaultValue, variables);
      }
    }
  }
  ctx.variables = effectiveVariables;
  const errors: string[] = [];
  validateSelections(operation.selections, rootType, fragments, errors, new Set());
  if (errors.length > 0) {
    return { data: null, errors: errors.map((message) => ({ message })) };
  }
  const state: ExecutionState = { errors: [] };
  const root: GqlValue = { __kind: rootType };
  const data = executeSelections(rootType, root, operation.selections, ctx, fragments, state, []);
  if (state.errors.length > 0) return { data, errors: state.errors };
  return { data };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface GraphQLRequestBody {
  query?: unknown;
  variables?: unknown;
  operationName?: unknown;
}

export function handleGraphQL(forge: Forge, body: unknown): unknown {
  const bodies = Array.isArray(body) ? body : [body];
  const responses = bodies.map((item) => executeRequest(forge, item));
  return Array.isArray(body) ? responses : responses[0];
}

function executeRequest(forge: Forge, item: unknown): unknown {
  if (typeof item !== 'object' || item === null || Array.isArray(item)) {
    return { data: null, errors: [{ message: 'Request body must be a JSON object.' }] };
  }
  const request = item as GraphQLRequestBody;
  if (typeof request.query !== 'string') {
    return { data: null, errors: [{ message: 'Request must include a query string.' }] };
  }
  let definitions: Definition[];
  try {
    definitions = new Parser(tokenize(request.query)).parseDocument();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Syntax error';
    return { data: null, errors: [{ message: `Syntax Error: ${message}` }] };
  }
  const fragments = new Map<string, FragmentDefinition>();
  const operations: OperationDefinition[] = [];
  for (const definition of definitions) {
    if (definition.kind === 'fragment') fragments.set(definition.name, definition);
    else operations.push(definition);
  }
  let operation: OperationDefinition | undefined;
  if (typeof request.operationName === 'string' && request.operationName !== '') {
    operation = operations.find((candidate) => candidate.name === request.operationName);
    if (!operation) {
      return { data: null, errors: [{ message: `Unknown operation named "${request.operationName}".` }] };
    }
  } else if (operations.length === 1) {
    operation = operations[0];
  } else if (operations.length === 0) {
    return { data: null, errors: [{ message: 'No operation was provided.' }] };
  } else {
    return { data: null, errors: [{ message: 'Must provide an operation name when multiple operations are present.' }] };
  }
  const variables =
    typeof request.variables === 'object' && request.variables !== null && !Array.isArray(request.variables)
      ? (request.variables as Variables)
      : {};
  return executeOperation(forge, operation, fragments, variables);
}

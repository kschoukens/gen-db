// GenDB as a Model Context Protocol server.
//
// A surface already describes itself completely: fields with meaning and bounds, actions with typed
// parameters, the rules the database enforces, and refusals that say how to repair the call. That is
// exactly what an MCP tool definition needs, so no glue has to be written per database: every
// surface an actor is granted becomes tools, derived from its contract on every tools/list.
//
//   <surface>             read the surface: rows, per-row affordances, summary. Always as audience
//                         'model', so fields marked pii come back redacted.
//   <surface>__<action>   one tool per action, $edit included. inputSchema is derived from the contract.
//
// A refusal from the database is not a protocol error. It comes back as a tool result with
// isError: true and the structured GenDBError (code, repair, violations, didYouMean) as its content,
// because that is what lets the model fix its call without a human in between.
//
// Protocol: dual-era, chosen per request.
//   2026-07-28 (stateless)  a request whose params._meta carries io.modelcontextprotocol/protocolVersion.
//                           No handshake: version, client capabilities and client info come with every
//                           request; results carry resultType and serverInfo in _meta; server/discover
//                           and tools/list carry ttlMs and cacheScope; tools/list_changed is delivered
//                           only on a subscriptions/listen stream.
//   2025-11-25, 2025-06-18  everything else: the initialize handshake, then tools/list and tools/call;
//                           tools/list_changed goes to every listener once the client is initialized.
//
// Implemented: initialize, notifications/initialized, ping (handshake era); server/discover,
// subscriptions/listen with its acknowledgment and graceful closing response, the
// UnsupportedProtocolVersion error (stateless era); tools/list, tools/call, tools/list_changed and
// notifications/cancelled for a subscription (both). Transport-agnostic and synchronous:
// handle(message) takes one parsed JSON-RPC message and returns the response, or null.
//
// Deliberately not implemented: resources, prompts, completions, logging, sampling, elicitation,
// roots, tasks, progress, multi round-trip requests (no tool ever needs more input than its
// arguments), cancelling a call (calls are synchronous, so there is nothing to cancel), pagination
// (every tool fits in one page), outputSchema (a tool's structuredContent is either its result or a
// refusal, and one schema for both would say nothing), JSON-RPC batches (removed from MCP in
// 2025-06-18), the Streamable HTTP transport with its headers and status codes, and authorization.
//
// Provenance: every write carries the actor this server was created for, `via` the surface, an
// intent and a model label. The intent is an optional `intent` argument on every action tool, in the
// user's words. The model label comes from the client info: initialize's clientInfo in the handshake
// era, the request's own _meta clientInfo in the stateless era. MCP does not tell a server which
// model is calling, so the label names the client application, prefixed with "mcp:".

import { createHash } from 'node:crypto';
import { GenDBError, didYouMean } from './errors.js';

export const STATELESS_VERSIONS = ['2026-07-28'];
export const HANDSHAKE_VERSIONS = ['2025-11-25', '2025-06-18'];
export const SUPPORTED_VERSIONS = [...STATELESS_VERSIONS, ...HANDSHAKE_VERSIONS];
const STATELESS_ONLY = new Set(['server/discover', 'subscriptions/listen']);

// Reserved _meta keys (2026-07-28).
const PROTOCOL_VERSION = 'io.modelcontextprotocol/protocolVersion';
const CLIENT_INFO = 'io.modelcontextprotocol/clientInfo';
const CLIENT_CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities';
const SERVER_INFO = 'io.modelcontextprotocol/serverInfo';
const SUBSCRIPTION_ID = 'io.modelcontextprotocol/subscriptionId';

// JSON-RPC 2.0 error codes, and the one MCP-specific code used here.
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;
const UNSUPPORTED_PROTOCOL_VERSION = -32022;

// -- tool names -------------------------------------------------------------------------------------
// Tool names may only use A-Z a-z 0-9 _ - . (at most 128 characters). Surface and action names may
// contain anything ($edit, Run.log). Every other character, `_` included, is escaped as `_` plus two
// hex digits per UTF-8 byte. An escaped name therefore never contains `__`, which makes `__` a safe
// separator and the encoding injective: two different (surface, action) pairs never share a name,
// and a name always says which surface and action it is, independent of what else exists.

const SAFE = /[A-Za-z0-9.-]/;
const MAX_NAME = 128;

const escapeName = (s) => [...String(s)].map((ch) => (SAFE.test(ch)
  ? ch
  : [...Buffer.from(ch, 'utf8')].map((b) => `_${b.toString(16).padStart(2, '0')}`).join(''))).join('');

const unescapeName = (s) => {
  const bytes = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '_') { bytes.push(parseInt(s.slice(i + 1, i + 3), 16)); i += 2; } else bytes.push(s.charCodeAt(i));
  }
  return Buffer.from(bytes).toString('utf8');
};

/** The tool name for reading a surface (no action) or for one of its actions. */
export function toolName(surface, action) {
  const full = action === undefined ? escapeName(surface) : `${escapeName(surface)}__${escapeName(action)}`;
  if (full.length <= MAX_NAME) return full;
  // Still stable and unique, but no longer decodable: the server resolves names through its tool table.
  return `${full.slice(0, MAX_NAME - 13)}-${createHash('sha256').update(full).digest('hex').slice(0, 12)}`;
}

/** The inverse of toolName() for names that were not shortened. */
export function parseToolName(name) {
  const at = name.indexOf('__');
  return at === -1 ? { surface: unescapeName(name) } : { surface: unescapeName(name.slice(0, at)), action: unescapeName(name.slice(at + 2)) };
}

// -- contract to tool definitions ---------------------------------------------------------------------

const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ''));

const range = (f) => {
  if (f.min != null && f.max != null) return `${f.min} to ${f.max}`;
  if (f.min != null) return `at least ${f.min}`;
  if (f.max != null) return `at most ${f.max}`;
  return null;
};

/** One line per field, for the read tool's description. */
function fieldLine(f) {
  const type = f.type === 'enum' ? `one of ${f.values.join(' | ')}` : f.type === 'ref' ? `id of a ${f.ref}` : f.type === 'date' ? 'date (YYYY-MM-DD)' : f.type;
  const facts = [type, f.unit && `in ${f.unit}`, range(f), f.maxLength != null && `max ${f.maxLength} chars`,
    f.required && 'required', f.editable && 'editable', f.pii && 'personal data, shown to you as ‹pii›'].filter(Boolean);
  return `- ${f.name} "${f.label}": ${facts.join(', ')}.${f.description ? ` ${f.description}.` : ''}`;
}

/** JSON Schema for one field or parameter of the contract. */
function valueSchema(f, { nullable = false } = {}) {
  const s = {};
  if (f.type === 'string') { s.type = 'string'; if (f.maxLength != null) s.maxLength = f.maxLength; }
  if (f.type === 'number') { s.type = 'number'; if (f.min != null) s.minimum = f.min; if (f.max != null) s.maximum = f.max; }
  if (f.type === 'boolean') s.type = 'boolean';
  if (f.type === 'date') { s.type = 'string'; s.format = 'date'; }
  if (f.type === 'datetime') { s.type = 'string'; s.format = 'date-time'; }
  if (f.type === 'enum') s.enum = [...f.values];
  if (f.type === 'ref') s.type = 'string';
  if (nullable) {
    if (s.type) s.type = [s.type, 'null'];
    if (s.enum) s.enum.push(null);
  }
  const about = [
    `${f.label}${f.description ? `: ${f.description}` : ''}.`,
    f.unit && `Unit: ${f.unit}.`,
    f.type === 'date' && 'Format YYYY-MM-DD.',
    f.type === 'ref' && `The id of an existing ${f.ref}.`,
    nullable && 'null clears it.',
    f.example !== undefined && `Example: ${JSON.stringify(f.example)}.`,
  ].filter(Boolean).join(' ');
  return clean({ ...s, description: about, examples: f.example !== undefined ? [f.example] : undefined });
}

const INTENT = {
  type: 'string',
  description: 'Why you are doing this, in the user\'s words. Recorded with the change, so it can be reviewed and undone by intent.',
};

const rulesText = (contract) => (contract.rules.length
  ? `\nRules the database enforces on every write:\n${contract.rules.map((r) => `- ${r.description}`).join('\n')}`
  : '');

function readTool(contract) {
  const actions = contract.actions.map((a) => toolName(contract.name, a.name));
  const description = [
    `${contract.intent ?? contract.label}. Each row is one ${contract.entity.type}${contract.entity.description ? `: ${contract.entity.description}` : ''}.`,
    `Fields:\n${contract.fields.map(fieldLine).join('\n')}`,
    rulesText(contract).trim(),
    contract.summary && `The summary (${contract.summary.measures.map((m) => m.label).join(', ')}) always covers all rows, also when rows are trimmed to budget_tokens.`,
    contract.actions.some((a) => a.scope === 'row')
      ? 'Returns the rows with their values and, per row, which actions are enabled right now and why not. Only call a row action where it is enabled.'
      : 'Returns the rows with their values.',
    actions.length ? `Actions: ${actions.join(', ')}.` : 'This surface is read-only.',
  ].filter(Boolean).join('\n\n');
  return {
    name: toolName(contract.name),
    title: contract.label,
    description,
    inputSchema: {
      type: 'object',
      properties: {
        budget_tokens: { type: 'integer', minimum: 1, description: 'Optional. Trim rows to fit about this many tokens; the result says how many were left out.' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  };
}

function actionTool(contract, action) {
  const row = action.scope === 'row';
  const isEdit = action.name === '$edit';
  const fieldRequired = (p) => contract.fields.find((f) => f.name === p.name)?.required;

  const params = {
    type: 'object',
    properties: Object.fromEntries(action.params.map((p) => [p.name, valueSchema(p, { nullable: isEdit && !fieldRequired(p) })])),
    additionalProperties: false,
  };
  const requiredParams = action.params.filter((p) => p.required).map((p) => p.name);
  if (requiredParams.length) params.required = requiredParams;
  if (isEdit) { params.minProperties = 1; params.description = 'The fields to change; leave out what stays the same.'; }

  const properties = {};
  if (row) properties.id = { type: 'string', description: `The id of the row, as returned by ${toolName(contract.name)} (rows[].id).` };
  if (action.params.length) properties.params = params;
  properties.intent = INTENT;
  const required = [...(row ? ['id'] : []), ...(requiredParams.length || isEdit ? ['params'] : [])];

  const description = [
    `${contract.label}: ${action.label}. ${action.description ?? ''}`.trim(),
    row ? `Acts on one row: pass its id from ${toolName(contract.name)}.` : `Creates a new ${contract.entity.type} in this surface.`,
    action.availableWhen && `Only possible when ${action.availableWhen}${action.otherwise ? `; otherwise refused because ${action.otherwise}` : ''}. ${toolName(contract.name)} says per row whether it is enabled.`,
    action.destructive && 'Destructive: removes the row.',
    action.kind !== 'delete' && rulesText(contract).trim(),
    'A refusal comes back as an error result with a code, a message and a repair hint. Fix the call and try again.',
  ].filter(Boolean).join('\n');

  return {
    name: toolName(contract.name, action.name),
    title: `${contract.label}: ${action.label}`,
    description,
    inputSchema: { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false },
    // Following the contract: only deletes are destructive. An edit overwrites a value, but the fact
    // log keeps the old one, and undo restores it.
    annotations: {
      readOnlyHint: false,
      destructiveHint: !!action.destructive,
      idempotentHint: isEdit || action.kind === 'delete',
      openWorldHint: false,
    },
  };
}

// -- the server -------------------------------------------------------------------------------------

const rpcError = (id, code, message, data) => ({ jsonrpc: '2.0', id: id ?? null, error: clean({ code, message, data }) });
const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const modelLabel = (client) => `mcp:${client?.name ?? 'unknown-client'}${client?.version ? `@${client.version}` : ''}`;

const toolResult = (structured, isError = false) => ({
  content: [{ type: 'text', text: JSON.stringify(structured) }],
  structuredContent: structured,
  ...(isError ? { isError: true } : {}),
});

/** A problem with the shape of a tool's arguments, reported like any other refusal so the model can fix it. */
const argumentError = (code, message, details) => new GenDBError(code, message, details);

export function createMcpServer(db, { actor, branch = 'main', name = 'gendb', version = 'dev' } = {}) {
  if (!actor) throw new GenDBError('ACTOR_REQUIRED', 'An MCP server acts for one actor.', { repair: 'Pass { actor: "user:…" } or { actor: "agent:…" }.' });

  const serverInfo = { name, version };
  const capabilities = { tools: { listChanged: true } };
  const instructions = `GenDB for ${actor}. Each tool without "__" reads one surface: its description is the contract, ` +
    'its result the rows and, per row, which actions are enabled. The other tools are that surface\'s actions. ' +
    'Pass intent with every action, in the user\'s words. When a call is refused, read code, repair and didYouMean, fix the call and retry.';

  let session = null; // handshake era: { protocolVersion, model } once initialize has been answered
  let ready = false; // handshake era: notifications/initialized received
  const subscriptions = new Map(); // stateless era: id of an open subscriptions/listen → accepted filter
  const listeners = new Set();
  const emit = (message) => { for (const listener of [...listeners]) listener(message); };

  /** The tool table: name → { tool, surface, action }. Derived from the contract every time. */
  function table() {
    const out = new Map();
    for (const { name: surface } of db.surfaces({ actor, branch })) {
      const contract = db.open(surface, { actor, branch }).describe();
      const add = (tool, action) => {
        // Only reachable through a hash collision of a shortened name; refuse to guess between two tools.
        if (out.has(tool.name)) throw new Error(`Tool name collision: "${tool.name}" for ${surface}/${action ?? 'read'}.`);
        out.set(tool.name, { tool, surface, action });
      };
      add(readTool(contract));
      for (const action of contract.actions) add(actionTool(contract, action), action.name);
    }
    return out;
  }

  const tools = () => [...table().values()].map((t) => t.tool);

  // tools/list_changed: only schema commits on our branch can change the tools, so only those are compared.
  let snapshot = JSON.stringify(tools());
  const unsubscribe = db.store.subscribe((tx) => {
    if (tx.branch !== branch || !tx.facts.some((f) => f.e.startsWith('$'))) return;
    const next = JSON.stringify(tools());
    if (next === snapshot) return;
    snapshot = next;
    if (ready) emit({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
    for (const [id, filter] of subscriptions) {
      if (filter.toolsListChanged) emit({ jsonrpc: '2.0', method: 'notifications/tools/list_changed', params: { _meta: { [SUBSCRIPTION_ID]: id } } });
    }
  });

  function listTools(params) {
    return params?.cursor !== undefined
      ? { error: [INVALID_PARAMS, 'Invalid cursor: this server never paginates.'] }
      : { result: { tools: tools() } };
  }

  function callTool(params, model) {
    if (!isObject(params) || typeof params.name !== 'string') return { error: [INVALID_PARAMS, 'tools/call needs params.name.'] };
    if (params.arguments !== undefined && !isObject(params.arguments)) return { error: [INVALID_PARAMS, 'tools/call params.arguments must be an object.'] };
    const args = params.arguments ?? {};
    const all = table();
    const entry = all.get(params.name);
    if (!entry) return { error: [INVALID_PARAMS, `Unknown tool: ${params.name}`, { didYouMean: didYouMean(params.name, all.keys()) }] };

    try {
      const surface = db.open(entry.surface, { actor, branch });
      const allowed = Object.keys(entry.tool.inputSchema.properties);
      for (const key of Object.keys(args)) {
        if (allowed.includes(key)) continue;
        const isParam = entry.tool.inputSchema.properties.params?.properties?.[key];
        throw argumentError('UNKNOWN_ARGUMENT', `Tool "${params.name}" has no argument "${key}".`, {
          didYouMean: didYouMean(key, allowed),
          repair: isParam ? `"${key}" is a parameter: put it inside "params".` : `Arguments are: ${allowed.join(', ')}.`,
        });
      }

      if (entry.action === undefined) {
        const tokens = args.budget_tokens;
        if (tokens !== undefined && !(Number.isInteger(tokens) && tokens >= 1)) {
          throw argumentError('INVALID_ARGUMENT', 'budget_tokens must be a positive integer.', { repair: 'Send a whole number such as 800, or leave it out.' });
        }
        return { result: toolResult(surface.read({ audience: 'model', budget: tokens ? { tokens } : undefined })) };
      }

      if (args.params !== undefined && !isObject(args.params)) {
        throw argumentError('INVALID_ARGUMENT', '"params" must be an object.', { repair: 'Send params as { "name": value, … }.' });
      }
      if (args.intent !== undefined && typeof args.intent !== 'string') {
        throw argumentError('INVALID_ARGUMENT', '"intent" must be text.', { repair: 'Describe in a sentence why you are doing this, or leave it out.' });
      }
      const result = surface.act(entry.action, { id: args.id, params: args.params ?? {} }, { intent: args.intent, model });
      return { result: toolResult(result) };
    } catch (err) {
      if (err instanceof GenDBError) return { result: toolResult(err.toJSON(), true) };
      throw err;
    }
  }

  // -- handshake era: 2025-11-25, 2025-06-18 ----------------------------------------------------------

  const handshake = {
    initialize(params) {
      if (session) return { error: [INVALID_REQUEST, 'Already initialized.'] };
      if (typeof params?.protocolVersion !== 'string') return { error: [INVALID_PARAMS, 'initialize needs params.protocolVersion.'] };
      session = {
        protocolVersion: HANDSHAKE_VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : HANDSHAKE_VERSIONS[0],
        model: modelLabel(isObject(params.clientInfo) ? params.clientInfo : null),
      };
      return { result: { protocolVersion: session.protocolVersion, capabilities, serverInfo, instructions } };
    },
    ping: () => ({ result: {} }),
    'tools/list': listTools,
    'tools/call': (params) => callTool(params, session.model),
  };

  function handleHandshake(id, method, params) {
    if (STATELESS_ONLY.has(method)) return rpcError(id, INVALID_PARAMS, `${method} needs _meta["${PROTOCOL_VERSION}"]: it exists only in protocol 2026-07-28.`);
    if (!Object.hasOwn(handshake, method)) return rpcError(id, METHOD_NOT_FOUND, `Method not found: ${method}`);
    if (!session && method !== 'initialize' && method !== 'ping') return rpcError(id, INVALID_REQUEST, 'Server not initialized: send initialize first.');
    const out = handshake[method](params);
    return out.error ? rpcError(id, ...out.error) : { jsonrpc: '2.0', id, result: out.result };
  }

  // -- stateless era: 2026-07-28 ----------------------------------------------------------------------
  // Nothing here reads `session`: everything a request needs is in the request.

  const stateless = {
    // Capabilities never change while the process runs. The instructions name the actor, so private.
    'server/discover': () => ({
      result: { supportedVersions: SUPPORTED_VERSIONS, capabilities, instructions, ttlMs: 3_600_000, cacheScope: 'private' },
    }),
    // The tools differ per actor (private) and change whenever a branch is merged, which the server
    // cannot foresee. Hence ttlMs 0; subscriptions/listen says when to fetch again.
    'tools/list': (params) => {
      const out = listTools(params);
      return out.error ? out : { result: { ...out.result, ttlMs: 0, cacheScope: 'private' } };
    },
    'tools/call': (params, meta) => callTool(params, modelLabel(isObject(meta[CLIENT_INFO]) ? meta[CLIENT_INFO] : null)),
    'subscriptions/listen': (params, meta, id) => {
      if (!isObject(params.notifications)) return { error: [INVALID_PARAMS, 'subscriptions/listen needs params.notifications.'] };
      if (subscriptions.has(id)) return { error: [INVALID_REQUEST, `Subscription ${JSON.stringify(id)} is still open; use a new request id.`] };
      // Only tools exist here, so toolsListChanged is the only type that can be honoured; the
      // acknowledgment leaves out everything else that was asked for.
      const accepted = params.notifications.toolsListChanged === true ? { toolsListChanged: true } : {};
      subscriptions.set(id, accepted);
      emit({ jsonrpc: '2.0', method: 'notifications/subscriptions/acknowledged', params: { _meta: { [SUBSCRIPTION_ID]: id }, notifications: accepted } });
      return { open: true }; // the response only comes when the server ends the subscription; see close()
    },
  };

  function handleStateless(id, method, params) {
    const meta = params._meta;
    const requested = meta[PROTOCOL_VERSION];
    if (typeof requested !== 'string') return rpcError(id, INVALID_PARAMS, `_meta["${PROTOCOL_VERSION}"] must be a string.`);
    if (!STATELESS_VERSIONS.includes(requested)) {
      return rpcError(id, UNSUPPORTED_PROTOCOL_VERSION, 'Unsupported protocol version', { supported: SUPPORTED_VERSIONS, requested });
    }
    if (!isObject(meta[CLIENT_CAPABILITIES])) return rpcError(id, INVALID_PARAMS, `_meta["${CLIENT_CAPABILITIES}"] is required.`);
    if (!Object.hasOwn(stateless, method)) return rpcError(id, METHOD_NOT_FOUND, `Method not found: ${method}`);
    // No method here needs a client capability, so MissingRequiredClientCapability (-32021) never applies.
    const out = stateless[method](params, meta, id);
    if (out.error) return rpcError(id, ...out.error);
    if (out.open) return null;
    return { jsonrpc: '2.0', id, result: { resultType: 'complete', ...out.result, _meta: { [SERVER_INFO]: serverInfo } } };
  }

  /**
   * Takes one parsed JSON-RPC message. Returns the response, or null for notifications, for responses,
   * and for subscriptions/listen, whose acknowledgment goes to the onMessage listeners.
   */
  function handle(message) {
    if (!isObject(message) || message.jsonrpc !== '2.0') return rpcError(message?.id, INVALID_REQUEST, 'Expected a single JSON-RPC 2.0 message object.');
    if (message.method === undefined && ('result' in message || 'error' in message)) return null; // we never send requests
    if (typeof message.method !== 'string') return rpcError(message.id, INVALID_REQUEST, 'Missing method.');

    if (!('id' in message)) {
      if (message.method === 'notifications/initialized' && session) ready = true;
      // Cancelling a subscriptions/listen ends it, without a response. Any other request has been
      // answered before its cancellation can arrive, so there is nothing else to stop.
      if (message.method === 'notifications/cancelled') subscriptions.delete(message.params?.requestId);
      return null;
    }
    const { id, method, params } = message;
    if (typeof id !== 'string' && typeof id !== 'number') return rpcError(null, INVALID_REQUEST, 'Request ids must be a string or a number.');
    if (params !== undefined && !isObject(params)) return rpcError(id, INVALID_PARAMS, 'params must be an object.');

    try {
      // A request naming a handshake version in _meta is served as a handshake request, initialize
      // first: those versions have no stateless form. 2026-07-28 does not say what to do with this case.
      const requested = isObject(params?._meta) ? params._meta[PROTOCOL_VERSION] : undefined;
      return requested !== undefined && !HANDSHAKE_VERSIONS.includes(requested)
        ? handleStateless(id, method, params)
        : handleHandshake(id, method, params);
    } catch (err) {
      return rpcError(id, INTERNAL_ERROR, `Internal error: ${err.message}`);
    }
  }

  return {
    handle,
    /**
     * Messages the server sends on its own: tools/list_changed (both eras), and for subscriptions/listen
     * its acknowledgment and its closing response. Returns a function that unregisters.
     */
    onMessage(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /**
     * Stops watching the database and ends open subscriptions gracefully, with their listen response.
     * 2026-07-28 is not consistent here: its cancellation page says a server MUST send
     * notifications/cancelled when it tears a subscription down, its subscriptions page and the schema
     * say it SHOULD answer the listen request instead. Cancelling a request and then answering it
     * contradicts itself, so only the response is sent.
     */
    close() {
      unsubscribe();
      for (const id of subscriptions.keys()) {
        emit({ jsonrpc: '2.0', id, result: { resultType: 'complete', _meta: { [SUBSCRIPTION_ID]: id, [SERVER_INFO]: serverInfo } } });
      }
      subscriptions.clear();
      listeners.clear();
    },
  };
}

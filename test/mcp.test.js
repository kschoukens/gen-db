import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createMcpServer, toolName, parseToolName } from '../src/mcp.js';
import { createDatabase, agentKneePain, KIM, SAM, KNEE_BRANCH } from '../demo/scenario.js';

const NOW = '2026-11-23T10:00:00.000Z';
const today = NOW.slice(0, 10);
const CLIENT = { name: 'test-client', version: '1.0.0' };

/** A server for `actor`, initialized like a client would, plus small helpers to drive it. */
function connect(actor = KIM, db = createDatabase({ now: () => NOW })) {
  const server = createMcpServer(db, { actor, name: 'gendb-test', version: '0.0.1' });
  let id = 0;
  const request = (method, params) => server.handle({ jsonrpc: '2.0', id: ++id, method, ...(params ? { params } : {}) });
  const init = request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: CLIENT });
  server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const call = (name, args) => request('tools/call', { name, arguments: args }).result;
  const tools = () => request('tools/list').result.tools;
  return { db, server, request, call, tools, init };
}

test('mcp: initialize negotiates the version and declares tools with listChanged', () => {
  const server = createMcpServer(createDatabase({ now: () => NOW }), { actor: KIM, name: 'gendb-test', version: '0.0.1' });
  const early = server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.equal(early.error.code, -32600, 'no tools before initialize');
  assert.deepEqual(server.handle({ jsonrpc: '2.0', id: 2, method: 'ping' }), { jsonrpc: '2.0', id: 2, result: {} });

  const { result } = server.handle({ jsonrpc: '2.0', id: 3, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: CLIENT } });
  assert.equal(result.protocolVersion, '2025-11-25');
  assert.deepEqual(result.capabilities, { tools: { listChanged: true } });
  assert.deepEqual(result.serverInfo, { name: 'gendb-test', version: '0.0.1' });
  assert.equal(server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.equal(server.handle({ jsonrpc: '2.0', id: 4, method: 'initialize', params: { protocolVersion: '2025-11-25' } }).error.code, -32600);

  const other = createMcpServer(createDatabase({ now: () => NOW }), { actor: KIM });
  const old = other.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {} } });
  assert.equal(old.result.protocolVersion, '2025-11-25', 'an unsupported version gets our latest');
});

test('mcp: tool names are valid, stable and reversible', () => {
  const VALID = /^[A-Za-z0-9_.-]{1,128}$/;
  for (const [s, a] of [['mijn-runs', undefined], ['mijn-runs', 'Run.log'], ['mijn-runs', '$edit'], ['a_b', 'c__d'], ['knie €', 'x y']]) {
    const name = toolName(s, a);
    assert.match(name, VALID);
    assert.deepEqual(parseToolName(name), a === undefined ? { surface: s } : { surface: s, action: a });
  }
  assert.equal(toolName('mijn-runs', 'Run.log'), 'mijn-runs__Run.log');
  assert.equal(toolName('mijn-runs', '$edit'), 'mijn-runs___24edit');
  assert.notEqual(toolName('a', 'b_c'), toolName('a_b', 'c'), 'underscores cannot fake a separator');
  const long = toolName('s'.repeat(200), 'x');
  assert.match(long, VALID);
  assert.equal(long, toolName('s'.repeat(200), 'x'), 'shortened names are stable too');
});

test('mcp: tools follow the grants of the actor', () => {
  const kim = connect(KIM).tools().map((t) => t.name);
  const sam = connect(SAM).tools().map((t) => t.name);
  assert.deepEqual(kim, ['mijn-runs', 'mijn-runs__Run.log', 'mijn-runs__Run.remove', 'mijn-runs___24edit', 'alle-runs']);
  assert.deepEqual(sam, ['mijn-runs', 'mijn-runs__Run.log', 'mijn-runs__Run.remove', 'mijn-runs___24edit']);
});

test('mcp: an action tool\'s inputSchema is the contract', () => {
  const tools = connect().tools();
  const log = tools.find((t) => t.name === 'mijn-runs__Run.log');
  const params = log.inputSchema.properties.params;
  assert.deepEqual(log.inputSchema.required, ['params']);
  assert.equal(log.inputSchema.additionalProperties, false);
  assert.equal(log.inputSchema.properties.intent.type, 'string');
  assert.deepEqual(params.required, ['date', 'distance_km', 'minutes']);
  assert.deepEqual({ ...params.properties.distance_km, description: undefined },
    { type: 'number', minimum: 0.1, maximum: 100, examples: [8.4], description: undefined });
  assert.match(params.properties.distance_km.description, /Afstand.*Unit: km.*Example: 8\.4/);
  assert.deepEqual(params.properties.feeling.enum, ['zwaar', 'ok', 'sterk']);
  assert.equal(params.properties.note.maxLength, 140);
  assert.equal(params.properties.date.format, 'date');
  assert.deepEqual(log.annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });

  const remove = tools.find((t) => t.name === 'mijn-runs__Run.remove');
  assert.deepEqual(remove.inputSchema.required, ['id']);
  assert.equal(remove.annotations.destructiveHint, true);
  assert.match(remove.description, /Run\.race != true.*wedstrijdresultaten zijn definitief/);

  const edit = tools.find((t) => t.name === 'mijn-runs___24edit');
  assert.deepEqual(Object.keys(edit.inputSchema.properties.params.properties), ['feeling', 'note']);
  assert.deepEqual(edit.inputSchema.properties.params.properties.note.type, ['string', 'null']);

  const read = tools.find((t) => t.name === 'mijn-runs');
  assert.equal(read.annotations.readOnlyHint, true);
  assert.match(read.description, /distance_km "Afstand": number, in km, 0\.1 to 100, required/);
  assert.match(read.description, /Het tempo moet tussen 2 en 20 minuten/);
});

test('mcp: a create through tools/call is read back and carries provenance', () => {
  const { db, call } = connect();
  const created = call('mijn-runs__Run.log', { params: { date: today, distance_km: 9, minutes: 50 }, intent: 'mijn run van vanochtend loggen' });
  assert.equal(created.isError, undefined);
  assert.equal(created.structuredContent.ok, true);
  assert.deepEqual(JSON.parse(created.content[0].text), created.structuredContent);

  const read = call('mijn-runs', {}).structuredContent;
  assert.equal(read.total, 12);
  assert.equal(read.rows.find((r) => r.id === created.structuredContent.id).values.distance_km, 9);

  const [tx] = db.log();
  assert.deepEqual({ actor: tx.actor, intent: tx.intent, via: tx.via, action: tx.action, model: tx.model }, {
    actor: KIM, intent: 'mijn run van vanochtend loggen', via: 'mijn-runs', action: 'Run.log', model: 'mcp:test-client@1.0.0',
  });
});

test('mcp: a refusal is a tool result the model can repair, and writes nothing', () => {
  const { db, call } = connect();
  const before = db.store.seq;

  const tooFar = call('mijn-runs__Run.log', { params: { date: today, distance_km: 500, minutes: 3000 } });
  assert.equal(tooFar.isError, true);
  assert.equal(tooFar.structuredContent.error.code, 'VALIDATION_FAILED');
  assert.ok(tooFar.structuredContent.error.violations.every((v) => v.repair));
  assert.equal(JSON.parse(tooFar.content[0].text).error.code, 'VALIDATION_FAILED');

  const typo = call('mijn-runs__Run.log', { params: { date: today, distanse_km: 5, minutes: 30 } }).structuredContent.error;
  assert.deepEqual([typo.code, typo.didYouMean], ['UNKNOWN_PARAM', ['distance_km']]);
  assert.ok(typo.repair);

  const flat = call('mijn-runs__Run.log', { date: today, distance_km: 5, minutes: 30 });
  assert.equal(flat.isError, true);
  assert.equal(flat.structuredContent.error.code, 'UNKNOWN_ARGUMENT');
  assert.match(flat.structuredContent.error.repair, /inside "params"/);

  assert.equal(call('mijn-runs___24edit', { id: 'run_999', params: { note: 'x' } }).structuredContent.error.code, 'ROW_NOT_VISIBLE');
  assert.equal(call('mijn-runs', { budget_tokens: -1 }).structuredContent.error.code, 'INVALID_ARGUMENT');
  assert.equal(db.store.seq, before, 'nothing was written');
});

test('mcp: a row action that is unavailable is refused with the reason', () => {
  const { db, call } = connect();
  const race = call('mijn-runs', {}).structuredContent.rows.find((r) => r.values.race);
  assert.deepEqual(race.actions['Run.remove'], { enabled: false, reason: 'wedstrijdresultaten zijn definitief' });
  const before = db.store.seq;
  const refused = call('mijn-runs__Run.remove', { id: race.id, intent: 'opruimen' });
  assert.equal(refused.isError, true);
  assert.equal(refused.structuredContent.error.code, 'ACTION_UNAVAILABLE');
  assert.equal(refused.structuredContent.error.reason, 'wedstrijdresultaten zijn definitief');
  assert.equal(db.store.seq, before);
});

test('mcp: reads are for a model, so pii is redacted', () => {
  const { db, call } = connect();
  const result = call('alle-runs', {}).structuredContent;
  assert.ok(result.rows.length > 0 && result.rows.every((r) => r.values.owner === '‹pii›'));
  assert.equal(db.open('alle-runs', { actor: KIM }).read().rows[0].values.owner, SAM, 'the UI still sees real values');
  const small = call('mijn-runs', { budget_tokens: 400 }).structuredContent;
  assert.equal(small.truncated.shown + small.truncated.omitted, 11);
});

test('mcp: protocol problems are JSON-RPC errors', () => {
  const { request, server } = connect();
  const unknownTool = request('tools/call', { name: 'mijn-runs__Run.purge', arguments: {} });
  assert.equal(unknownTool.error.code, -32602);
  assert.match(unknownTool.error.message, /Unknown tool/);
  assert.ok(unknownTool.error.data.didYouMean.includes('mijn-runs__Run.log'));
  assert.equal(connect(SAM).request('tools/call', { name: 'alle-runs', arguments: {} }).error.code, -32602, 'an ungranted surface is simply not a tool');

  assert.equal(request('resources/list').error.code, -32601);
  assert.equal(request('tools/call', { arguments: {} }).error.code, -32602);
  assert.equal(request('tools/call', { name: 'mijn-runs', arguments: [1] }).error.code, -32602);
  assert.equal(request('tools/list', { cursor: 'x' }).error.code, -32602);
  assert.equal(server.handle({ id: 9, method: 'ping' }).error.code, -32600);
  assert.equal(server.handle([{ jsonrpc: '2.0', id: 9, method: 'ping' }]).error.code, -32600, 'no batches');
  assert.equal(server.handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } }), null);
});

test('mcp: tools/list_changed fires when a merge adds a surface, not on data writes', () => {
  const { db, server, tools, call } = connect();
  const seen = [];
  server.onMessage((n) => seen.push(n));

  call('mijn-runs__Run.log', { params: { date: today, distance_km: 5, minutes: 30 } });
  agentKneePain(db); // schema changes on a branch: not this server's tools
  assert.deepEqual(seen, []);

  db.merge(KNEE_BRANCH, { approvedBy: KIM });
  assert.deepEqual(seen, [{ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }]);
  const names = tools().map((t) => t.name);
  assert.ok(names.includes('knie-en-afstand') && names.includes('knie-en-afstand___24edit'));
  assert.ok(!connect(SAM, db).tools().some((t) => t.name.startsWith('knie')), 'granted to Kim only');

  server.close();
  db.evolve({ attrs: { 'Run.shoe': { type: 'string', description: 'Schoen' } }, surfaces: { extra: { description: 'x', from: 'Run', fields: ['Run.shoe'], grants: ['*'] } } }, { actor: KIM });
  assert.equal(seen.length, 1, 'closed servers stay quiet');
});

/** Spawns demo/mcp.js and speaks newline-delimited JSON-RPC to it. */
function spawnDemo(actor) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../demo/mcp.js', import.meta.url)), actor], { stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  const received = [];
  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf('\n')) !== -1) {
      const message = JSON.parse(buffer.slice(0, at));
      buffer = buffer.slice(at + 1);
      received.push(message);
      if ('id' in message && !('method' in message)) pending.get(message.id)?.(message);
    }
  });
  let id = 0;
  const write = (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  return {
    received,
    notify: (method, params) => write({ method, params }),
    send: (method, params) => write({ id: ++id, method, params }),
    request: (method, params) => new Promise((resolve) => {
      pending.set(++id, resolve);
      write({ id, method, params });
    }),
    async end() {
      child.stdin.end();
      return new Promise((resolve) => child.on('exit', resolve));
    },
  };
}

test('mcp: stdio end to end with demo/mcp.js (2025-11-25)', async () => {
  const demo = spawnDemo(SAM);
  try {
    const init = await demo.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: CLIENT });
    assert.equal(init.result.serverInfo.name, 'gendb-demo');
    demo.notify('notifications/initialized');
    const list = await demo.request('tools/list', {});
    assert.ok(!list.result.tools.some((t) => t.name === 'alle-runs'), 'served for Sam');
    const read = await demo.request('tools/call', { name: 'mijn-runs', arguments: {} });
    assert.equal(read.result.structuredContent.total, 3);
  } finally {
    assert.equal(await demo.end(), 0, 'exits when stdin closes');
  }
});

// -- the stateless era: 2026-07-28 ------------------------------------------------------------------

const META = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {}, 'io.modelcontextprotocol/clientInfo': CLIENT };

/** A server driven only by self-contained 2026-07-28 requests: no initialize. */
function stateless(actor = KIM, db = createDatabase({ now: () => NOW })) {
  const server = createMcpServer(db, { actor, name: 'gendb-test', version: '0.0.1' });
  const sent = [];
  server.onMessage((m) => sent.push(m));
  let id = 0;
  const request = (method, params = {}, meta = META) => server.handle({ jsonrpc: '2.0', id: ++id, method, params: { ...params, _meta: meta } });
  const call = (name, args, meta) => request('tools/call', { name, arguments: args }, meta).result;
  return { db, server, sent, request, call, tools: () => request('tools/list').result.tools };
}

test('mcp 2026-07-28: server/discover, with no handshake before it', () => {
  const { request } = stateless();
  const { result } = request('server/discover');
  assert.deepEqual(result.supportedVersions, ['2026-07-28', '2025-11-25', '2025-06-18']);
  assert.deepEqual(result.capabilities, { tools: { listChanged: true } });
  assert.equal(result.resultType, 'complete');
  assert.deepEqual(result._meta, { 'io.modelcontextprotocol/serverInfo': { name: 'gendb-test', version: '0.0.1' } });
  assert.ok(result.ttlMs >= 0 && ['public', 'private'].includes(result.cacheScope));
  assert.match(result.instructions, /user:kim/);
});

test('mcp 2026-07-28: tools/list is cacheable, per actor', () => {
  const { request } = stateless();
  const { result } = request('tools/list');
  assert.equal(result.resultType, 'complete');
  assert.deepEqual([result.ttlMs, result.cacheScope], [0, 'private']);
  assert.equal(result._meta['io.modelcontextprotocol/serverInfo'].name, 'gendb-test');
  assert.deepEqual(result.tools, connect(KIM).tools(), 'the same tools in both eras');
  assert.ok(!stateless(SAM).tools().some((t) => t.name === 'alle-runs'));
});

test('mcp 2026-07-28: a call with provenance from the request\'s own clientInfo', () => {
  const { db, call } = stateless();
  const created = call('mijn-runs__Run.log', { params: { date: today, distance_km: 9, minutes: 50 }, intent: 'run van vanochtend' },
    { ...META, 'io.modelcontextprotocol/clientInfo': { name: 'other-client', version: '2.0' } });
  assert.equal(created.resultType, 'complete');
  assert.equal(created.structuredContent.ok, true);
  assert.equal(call('mijn-runs', {}).structuredContent.total, 12);
  const [tx] = db.log();
  assert.deepEqual({ actor: tx.actor, intent: tx.intent, via: tx.via, model: tx.model },
    { actor: KIM, intent: 'run van vanochtend', via: 'mijn-runs', model: 'mcp:other-client@2.0' });

  const { 'io.modelcontextprotocol/clientInfo': _, ...anonymous } = META;
  call('mijn-runs__Run.log', { params: { date: today, distance_km: 4, minutes: 25 } }, anonymous);
  assert.equal(db.log()[0].model, 'mcp:unknown-client', 'clientInfo is optional');
});

test('mcp 2026-07-28: a refusal carries its repair, writes nothing, and pii stays redacted', () => {
  const { db, call } = stateless();
  const before = db.store.seq;
  const refused = call('mijn-runs__Run.log', { params: { date: today, distance_km: 500, minutes: 3000 } });
  assert.deepEqual([refused.resultType, refused.isError, refused.structuredContent.error.code], ['complete', true, 'VALIDATION_FAILED']);
  assert.ok(refused.structuredContent.error.violations.every((v) => v.repair));
  assert.equal(db.store.seq, before);
  assert.ok(call('alle-runs', {}).structuredContent.rows.every((r) => r.values.owner === '‹pii›'));
});

test('mcp 2026-07-28: version, metadata and method errors', () => {
  const { request, server } = stateless();
  const unsupported = request('tools/list', {}, { ...META, 'io.modelcontextprotocol/protocolVersion': '1900-01-01' });
  assert.deepEqual(unsupported.error, {
    code: -32022, message: 'Unsupported protocol version',
    data: { supported: ['2026-07-28', '2025-11-25', '2025-06-18'], requested: '1900-01-01' },
  });
  const { 'io.modelcontextprotocol/clientCapabilities': _, ...noCapabilities } = META;
  assert.equal(request('tools/list', {}, noCapabilities).error.code, -32602, 'clientCapabilities is required');
  assert.equal(request('initialize', { protocolVersion: '2026-07-28' }).error.code, -32601, 'no handshake in this era');
  assert.equal(request('ping').error.code, -32601, 'ping was removed');
  assert.equal(request('tools/call', { name: 'nope', arguments: {} }).error.code, -32602);
  assert.equal(server.handle({ jsonrpc: '2.0', id: 99, method: 'server/discover' }).error.code, -32602, 'discover without _meta is malformed');
  // A handshake version in _meta does not skip the handshake.
  assert.equal(request('tools/list', {}, { ...META, 'io.modelcontextprotocol/protocolVersion': '2025-11-25' }).error.code, -32600);
});

test('mcp 2026-07-28: tools/list_changed arrives on a subscriptions/listen stream', () => {
  const { db, server, sent, request } = stateless();
  assert.equal(request('subscriptions/listen', { notifications: { toolsListChanged: true, promptsListChanged: true } }), null, 'the stream stays open');
  const listenId = 1;
  assert.deepEqual(sent, [{
    jsonrpc: '2.0', method: 'notifications/subscriptions/acknowledged',
    params: { _meta: { 'io.modelcontextprotocol/subscriptionId': listenId }, notifications: { toolsListChanged: true } },
  }], 'acknowledged first, without what the server cannot honour');
  request('subscriptions/listen', { notifications: {} }); // a second stream that did not ask for tools

  agentKneePain(db);
  assert.equal(sent.length, 2, 'nothing for a branch');
  db.merge(KNEE_BRANCH, { approvedBy: KIM });
  assert.deepEqual(sent.slice(2), [{
    jsonrpc: '2.0', method: 'notifications/tools/list_changed', params: { _meta: { 'io.modelcontextprotocol/subscriptionId': listenId } },
  }], 'only the stream that asked for it, tagged with its id');

  server.handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: listenId } });
  db.evolve({ attrs: { 'Run.shoe': { type: 'string', description: 'Schoen' } }, surfaces: { extra: { description: 'x', from: 'Run', fields: ['Run.shoe'], grants: ['*'] } } }, { actor: KIM });
  assert.equal(sent.length, 3, 'a cancelled subscription stays quiet');

  server.close();
  assert.deepEqual(sent.at(-1), {
    jsonrpc: '2.0', id: 2,
    result: { resultType: 'complete', _meta: { 'io.modelcontextprotocol/subscriptionId': 2, 'io.modelcontextprotocol/serverInfo': { name: 'gendb-test', version: '0.0.1' } } },
  }, 'closing answers the open listen request');
});

test('mcp: both eras on one server', () => {
  const { server, request: handshakeRequest } = connect();
  const { result } = server.handle({ jsonrpc: '2.0', id: 'x', method: 'tools/list', params: { _meta: META } });
  assert.equal(result.resultType, 'complete');
  assert.equal(handshakeRequest('tools/list').result.resultType, undefined, 'handshake results stay as they were');
});

test('mcp: stdio end to end with demo/mcp.js (2026-07-28)', async () => {
  const demo = spawnDemo(KIM);
  try {
    const discover = await demo.request('server/discover', { _meta: META });
    assert.equal(discover.result.supportedVersions[0], '2026-07-28');
    demo.send('subscriptions/listen', { _meta: META, notifications: { toolsListChanged: true } });
    const listenId = 2;
    const list = await demo.request('tools/list', { _meta: META });
    assert.equal(list.result.cacheScope, 'private');
    const created = await demo.request('tools/call', { _meta: META, name: 'mijn-runs__Run.log', arguments: { params: { date: '2026-01-02', distance_km: 5, minutes: 30 } } });
    assert.equal(created.result.structuredContent.ok, true);
    const ack = demo.received.find((m) => m.method === 'notifications/subscriptions/acknowledged');
    assert.equal(ack.params._meta['io.modelcontextprotocol/subscriptionId'], listenId);
    assert.ok(demo.received.indexOf(ack) < demo.received.indexOf(list), 'acknowledged before later responses');
  } finally {
    assert.equal(await demo.end(), 0);
  }
});

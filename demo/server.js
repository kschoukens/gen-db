// The live demo: one GenDB, generated UIs bound to it over server-sent events, and a scripted agent
// you can set loose on it.
//
//   node demo/server.js                          then open http://localhost:4173
//   GENDB_FILE=./demo.gendb node demo/server.js  the same, but the fact log survives a restart
//
// What is real and what is not:
//
//   Real      the surface endpoints (contract, stream, act) take a token and nothing else. The
//             token is a signed capability (src/capability.js): it names the surface, actor and
//             branch, cannot be forged or widened, and is checked again on every request.
//   Not real  logging in. /api/state mints tokens for whichever actor the `?actor=` query parameter
//             names, so anyone who can reach this server can get a token for anyone. In a real
//             deployment that step sits behind authentication, and minting is db.grant() there.
//   Not real  the owner and agent console (merge, discard, undo, agent steps, hallucinate, reset)
//             still trusts `?actor=` as an explicit demo shortcut, and the agent steps act with
//             privileged calls on the server, not through tokens.
//
// Tokens travel in the query string because EventSource cannot set headers; that puts them in
// server logs and browser history, which a real deployment would avoid. The secret is random per
// database, so "Opnieuw beginnen" (reset) invalidates every token handed out before it.

import http from 'node:http';
import { readFile, readdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { GenDBError, fileJournal } from '../src/index.js';
import { HOST_CSP, SANDBOX_ATTRIBUTE, sandboxDocument } from './sandbox.js';
import {
  createDatabase, agentKneePain, agentMetres, hallucinatedUI,
  KIM, SAM, KNEE_BRANCH, KNEE_INTENT, METRES_BRANCH,
} from './scenario.js';

const PORT = Number(process.env.PORT ?? 4173);
const FILES = {
  '/': ['public/index.html', 'text/html; charset=utf-8'],
  '/genui.js': ['../src/genui.js', 'text/javascript; charset=utf-8'],
};

const JOURNAL = process.env.GENDB_FILE;
let journal = JOURNAL ? fileJournal(JOURNAL) : undefined;
let db = createDatabase({ journal });
const streams = new Set();

async function reset() {
  journal?.close();
  if (JOURNAL) await rm(JOURNAL, { force: true });
  journal = JOURNAL ? fileJournal(JOURNAL) : undefined;
  db = createDatabase({ journal });
  for (const s of streams) s.restart();
  return { ok: true };
}

// UIs written by a model from the contract alone: demo/generated/<surface>.<variant>.html.
const GENERATED = fileURLToPath(new URL('./generated/', import.meta.url));
const variants = async () => (await readdir(GENERATED)).filter((f) => f.endsWith('.html')).map((f) => f.slice(0, -5).split('.'));

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

const body = async (req) => {
  let text = '';
  for await (const chunk of req) text += chunk;
  return text ? JSON.parse(text) : {};
};

function sse(req, res, start) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  const stream = { stop: start(send), restart: () => { stream.stop(); stream.stop = start(send); } };
  streams.add(stream);
  req.on('close', () => { stream.stop(); streams.delete(stream); });
}

async function state(actor, branch) {
  const branches = db.branches();
  const generated = await variants();
  return {
    sandbox: SANDBOX_ATTRIBUTE,
    durable: Boolean(JOURNAL),
    actors: [KIM, SAM],
    owners: [...db.owners],
    branches,
    // The demo's stand-in for a login: whoever the page says it is gets a fresh token per surface.
    surfaces: db.surfaces({ actor, branch }).map((s) => ({
      ...s,
      token: db.grant(s.name, { actor, branch }),
      variants: generated.filter(([surface]) => surface === s.name).map(([, variant]) => variant),
    })),
    reviews: branches.filter((b) => b.parent && b.status === 'open').map((b) => db.review(b.name)),
    log: db.log({ branch, limit: 12 }),
    canUndoKnee: db.log({ branch: 'main', limit: 1000 }).some((tx) => tx.intent === KNEE_INTENT && tx.kind !== 'schema')
      && !db.log({ branch: 'main', limit: 1000 }).some((tx) => tx.kind === 'undo'),
  };
}

/** The surface a token opens. The name in the path is only for readable URLs; it must match the token. */
function redeem(name, token) {
  const surface = db.redeem(token);
  if (surface.name !== name) {
    throw new GenDBError('NOT_GRANTED', `This token does not open surface "${name}".`, { repair: `Use it at /api/surfaces/${surface.name}/….` });
  }
  return surface;
}

const routes = [
  ['GET', /^\/api\/state$/, ({ actor, branch }) => state(actor, branch)],
  ['GET', /^\/api\/surfaces\/([^/]+)\/contract$/, ({ token, m }) => redeem(m[1], token).describe()],
  // A model-written UI, wrapped for the sandbox. The model's file is served as written; what is added
  // is the policy and the runtime, with the contract this token is entitled to.
  ['GET', /^\/api\/surfaces\/([^/]+)\/generated\/([^/]+)$/, async ({ token, m }) => {
    const surface = redeem(m[1], token);
    if (!(await variants()).some(([s, v]) => s === m[1] && v === m[2])) {
      throw new GenDBError('NOT_FOUND', `No generated UI "${m[2]}" for surface "${m[1]}".`, { repair: 'Use a variant listed in /api/state.' });
    }
    return { srcdoc: sandboxDocument(await readFile(`${GENERATED}${m[1]}.${m[2]}.html`, 'utf8'), surface.describe()) };
  }],
  ['POST', /^\/api\/surfaces\/([^/]+)\/act$/, ({ token, m, input }) =>
    redeem(m[1], token).act(input.action, { id: input.id, params: input.params }, { intent: input.intent })],
  ['POST', /^\/api\/agent\/knee$/, () => agentKneePain(db)],
  ['POST', /^\/api\/agent\/metres$/, () => agentMetres(db)],
  ['POST', /^\/api\/hallucinate$/, () => hallucinatedUI(db)],
  ['POST', /^\/api\/branches\/([^/]+)\/merge$/, ({ actor, m }) => db.merge(m[1], { approvedBy: actor })],
  ['POST', /^\/api\/branches\/([^/]+)\/discard$/, ({ actor, m }) => db.discard(m[1], { actor })],
  ['POST', /^\/api\/undo$/, ({ actor, input }) => db.undo({ intent: input.intent }, { actor })],
  ['POST', /^\/api\/reset$/, reset],
];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const actor = url.searchParams.get('actor') ?? KIM;
  const branch = url.searchParams.get('branch') ?? 'main';
  const token = url.searchParams.get('token');

  try {
    if (FILES[url.pathname]) {
      const [file, type] = FILES[url.pathname];
      // The host policy is what keeps a sandboxed UI from navigating itself away (see sandbox.js).
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', 'content-security-policy': HOST_CSP });
      return res.end(await readFile(fileURLToPath(new URL(file, import.meta.url))));
    }

    if (url.pathname === '/api/events') {
      return sse(req, res, (send) => { send({ tx: db.store.seq }); return db.store.subscribe((tx) => send({ tx: tx.id })); });
    }

    const stream = url.pathname.match(/^\/api\/surfaces\/([^/]+)\/stream$/);
    if (stream) {
      const name = decodeURIComponent(stream[1]);
      redeem(name, token); // refuse before the stream starts
      return sse(req, res, (send) => {
        // Also runs again after a reset, when the token belongs to the old database: report, do not throw.
        try { return redeem(name, token).subscribe(send); } catch (err) {
          if (!(err instanceof GenDBError)) throw err;
          send(err.toJSON());
          return () => {};
        }
      });
    }

    for (const [method, pattern, handler] of routes) {
      const m = url.pathname.match(pattern);
      if (m && req.method === method) {
        const input = method === 'POST' ? await body(req) : {};
        return json(res, 200, await handler({ actor, branch, token, m: m.map(decodeURIComponent), input }));
      }
    }
    json(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: `No route ${req.method} ${url.pathname}.` } });
  } catch (err) {
    if (err instanceof GenDBError) return json(res, 422, err.toJSON());
    console.error(err);
    json(res, 500, { ok: false, error: { code: 'INTERNAL', message: String(err.message ?? err) } });
  }
});

server.listen(PORT, () => console.log(`GenDB demo: http://localhost:${PORT}${JOURNAL ? ` (fact log in ${JOURNAL}, ${db.store.seq} transactions)` : ' (in memory)'}`));

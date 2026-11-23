// The live demo: one in-memory GenDB, a generated UI bound to it over server-sent events, and a
// scripted agent you can set loose on it.
//
//   node demo/server.js        then open http://localhost:4173
//
// Demo only: the acting user comes from a query parameter. A real deployment would hand each
// generated UI an unforgeable capability for its surface instead.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { GenDBError } from '../src/index.js';
import {
  createDatabase, agentKneePain, agentMetres, hallucinatedUI,
  KIM, SAM, KNEE_BRANCH, KNEE_INTENT, METRES_BRANCH,
} from './scenario.js';

const PORT = Number(process.env.PORT ?? 4173);
const FILES = {
  '/': ['public/index.html', 'text/html; charset=utf-8'],
  '/genui.js': ['../src/genui.js', 'text/javascript; charset=utf-8'],
};

let db = createDatabase();
const streams = new Set();

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

function state(actor, branch) {
  const branches = db.branches();
  return {
    actors: [KIM, SAM],
    owners: [...db.owners],
    branches,
    surfaces: db.surfaces({ actor, branch }),
    reviews: branches.filter((b) => b.parent && b.status === 'open').map((b) => db.review(b.name)),
    log: db.log({ branch, limit: 12 }),
    canUndoKnee: db.log({ branch: 'main', limit: 1000 }).some((tx) => tx.intent === KNEE_INTENT && tx.kind !== 'schema')
      && !db.log({ branch: 'main', limit: 1000 }).some((tx) => tx.kind === 'undo'),
  };
}

const routes = [
  ['GET', /^\/api\/state$/, ({ actor, branch }) => state(actor, branch)],
  ['GET', /^\/api\/surfaces\/([^/]+)\/contract$/, ({ actor, branch, m }) => db.open(m[1], { actor, branch }).describe()],
  ['POST', /^\/api\/surfaces\/([^/]+)\/act$/, ({ actor, branch, m, input }) =>
    db.open(m[1], { actor, branch }).act(input.action, { id: input.id, params: input.params }, { intent: input.intent })],
  ['POST', /^\/api\/agent\/knee$/, () => agentKneePain(db)],
  ['POST', /^\/api\/agent\/metres$/, () => agentMetres(db)],
  ['POST', /^\/api\/hallucinate$/, () => hallucinatedUI(db)],
  ['POST', /^\/api\/branches\/([^/]+)\/merge$/, ({ actor, m }) => db.merge(m[1], { approvedBy: actor })],
  ['POST', /^\/api\/branches\/([^/]+)\/discard$/, ({ actor, m }) => db.discard(m[1], { actor })],
  ['POST', /^\/api\/undo$/, ({ actor, input }) => db.undo({ intent: input.intent }, { actor })],
  ['POST', /^\/api\/reset$/, () => { db = createDatabase(); for (const s of streams) s.restart(); return { ok: true }; }],
];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const actor = url.searchParams.get('actor') ?? KIM;
  const branch = url.searchParams.get('branch') ?? 'main';

  try {
    if (FILES[url.pathname]) {
      const [file, type] = FILES[url.pathname];
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
      return res.end(await readFile(fileURLToPath(new URL(file, import.meta.url))));
    }

    if (url.pathname === '/api/events') {
      return sse(req, res, (send) => { send({ tx: db.store.seq }); return db.store.subscribe((tx) => send({ tx: tx.id })); });
    }

    const stream = url.pathname.match(/^\/api\/surfaces\/([^/]+)\/stream$/);
    if (stream) {
      const name = decodeURIComponent(stream[1]);
      db.open(name, { actor, branch }); // refuse before the stream starts
      return sse(req, res, (send) => db.open(name, { actor, branch }).subscribe(send));
    }

    for (const [method, pattern, handler] of routes) {
      const m = url.pathname.match(pattern);
      if (m && req.method === method) {
        const input = method === 'POST' ? await body(req) : {};
        return json(res, 200, await handler({ actor, branch, m: m.map(decodeURIComponent), input }));
      }
    }
    json(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: `No route ${req.method} ${url.pathname}.` } });
  } catch (err) {
    if (err instanceof GenDBError) return json(res, 422, err.toJSON());
    console.error(err);
    json(res, 500, { ok: false, error: { code: 'INTERNAL', message: String(err.message ?? err) } });
  }
});

server.listen(PORT, () => console.log(`GenDB demo: http://localhost:${PORT}`));

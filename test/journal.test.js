import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Database } from '../src/db.js';
import { fileJournal } from '../src/journal.js';
import { createDatabase, agentKneePain, agentMetres, attempt, KIM, COACH, KNEE_BRANCH, KNEE_INTENT, METRES_BRANCH } from '../demo/scenario.js';

// A clock that moves, so every transaction has its own `at` and a mix-up would show.
let tick = 0;
const now = () => new Date(Date.UTC(2026, 10, 23, 10, 0, 0, tick++)).toISOString();
const today = '2026-11-23';

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gendb-journal-')), 'facts.jsonl');
const reopen = (file) => new Database({ owners: [KIM], journal: fileJournal(file), now });
const code = (fn) => attempt(fn).error?.code;
const lines = (file) => fs.readFileSync(file, 'utf8').split('\n').slice(0, -1);

/** Everything a restart must preserve, in insertion order. `schemaVersion` is only a cache key. */
function snapshot(db) {
  const { store } = db;
  return structuredClone({
    seq: store.seq,
    ids: store.ids,
    branches: [...store.branches.values()].map(({ state, schemaVersion, ...b }) => ({ ...b, state: [...state].map(([e, attrs]) => [e, [...attrs]]) })),
    logs: Object.fromEntries([...store.branches.keys()].map((name) => [name, db.log({ branch: name, limit: Infinity })])),
  });
}

/** Main with a merged fork and later edits and an undo, an open fork and a discarded fork. */
function build(file) {
  const db = createDatabase({ journal: fileJournal(file), now });
  agentKneePain(db);
  db.merge(KNEE_BRANCH, { approvedBy: KIM });
  const knee = db.open('knie-en-afstand', { actor: KIM });
  knee.act('$edit', { id: knee.read().rows[0].id, params: { knee_pain: 8 } }, { intent: 'pijn corrigeren' });
  db.undo({ intent: KNEE_INTENT }, { actor: KIM });
  agentMetres(db);
  db.fork('agent/notes', { actor: COACH, intent: 'notities' });
  db.transact([{ e: knee.read().rows[1].id, a: 'Run.note', v: 'van de agent' }], { actor: COACH, branch: 'agent/notes' });
  db.discard('agent/notes', { actor: KIM });
  return db;
}

test('a reopened database is in exactly the state it was in, on every branch', () => {
  const file = tmpFile();
  const db = build(file);
  const size = fs.statSync(file).size;
  const again = reopen(file);

  assert.deepEqual(snapshot(again), snapshot(db));
  assert.deepEqual(again.branches().map((b) => [b.name, b.status]),
    [['main', 'open'], [KNEE_BRANCH, 'merged'], [METRES_BRANCH, 'open'], ['agent/notes', 'discarded']]);
  assert.deepEqual(again.review(METRES_BRANCH), db.review(METRES_BRANCH));
  assert.equal(fs.statSync(file).size, size, 'replay appends nothing');
  assert.equal(code(() => again.transact([], { actor: COACH, branch: 'agent/notes' })), 'BRANCH_CLOSED');
});

test('provenance and time travel survive a restart', () => {
  const file = tmpFile();
  const db = build(file);
  const id = db.open('knie-en-afstand', { actor: KIM }).read().rows[0].id;
  const again = reopen(file);

  const why = again.why(id, 'Run.knee_pain');
  assert.deepEqual(why, db.why(id, 'Run.knee_pain'));
  assert.ok(why.some((w) => w.mergedFrom === KNEE_BRANCH && w.approvedBy === KIM && w.confidence === 0.4));

  const beforeMerge = db.log({ limit: Infinity }).findLast((t) => t.mergedFrom === KNEE_BRANCH).tx - 1; // the log is newest first
  const read = (d, asOf) => d.open('mijn-runs', { actor: KIM }).read({ asOf });
  assert.deepEqual(read(again, beforeMerge), read(db, beforeMerge));
  assert.deepEqual(again.query({ from: 'Run' }, { asOf: 3 }), db.query({ from: 'Run' }, { asOf: 3 }));
  assert.equal(again.schema('main', beforeMerge).attrs.has('Run.knee_pain'), false);
  assert.equal(again.schema().attrs.has('Run.knee_pain'), true);
});

test('writes after a restart get fresh ids and survive the next restart', () => {
  const file = tmpFile();
  const db = build(file);
  const existing = new Set(db.query({ from: 'Run' }).map((r) => r.id));

  const again = reopen(file);
  const { id } = again.open('mijn-runs', { actor: KIM }).act('Run.log', { params: { date: today, distance_km: 5, minutes: 30 } });
  assert.ok(!existing.has(id), `${id} is new`);
  assert.equal(id, `run_${db.store.ids + 1}`);
  again.fork('agent/later', { actor: COACH });
  again.transact([{ e: id, a: 'Run.note', v: 'later' }], { actor: COACH, branch: 'agent/later' });
  again.merge('agent/later', { approvedBy: KIM });

  const third = reopen(file);
  assert.deepEqual(snapshot(third), snapshot(again));
  assert.equal(third.query({ from: 'Run', where: ['=', ['get', 'Run.note'], 'later'] })[0].id, id);
});

test('a torn last line is dropped and cut off, so the next append starts clean', () => {
  const file = tmpFile();
  const db = build(file);
  const size = fs.statSync(file).size;
  fs.appendFileSync(file, '{"t":"tx","ids":99,"tx":{"id":');

  const again = reopen(file);
  assert.deepEqual(snapshot(again), snapshot(db));
  assert.equal(fs.statSync(file).size, size, 'truncated back to the last complete record');

  again.transact([{ e: db.query({ from: 'Run' })[0].id, a: 'Run.note', v: 'na de crash' }], { actor: KIM });
  assert.deepEqual(snapshot(reopen(file)), snapshot(again));
});

test('a torn header on a fresh file is repaired; a file that is not a journal is left alone', () => {
  const torn = tmpFile();
  fs.writeFileSync(torn, '{"t":"gendb-jou');
  reopen(torn);
  assert.deepEqual(lines(torn), ['{"t":"gendb-journal","v":1}']);

  const foreign = tmpFile();
  fs.writeFileSync(foreign, 'important notes');
  assert.equal(code(() => reopen(foreign)), 'JOURNAL_CORRUPT');
  assert.equal(fs.readFileSync(foreign, 'utf8'), 'important notes');
});

test('damage before the last line is reported, not repaired', () => {
  const file = tmpFile();
  build(file);
  const all = lines(file);
  const damaged = [...all];
  damaged[5] = damaged[5].slice(0, 20);
  fs.writeFileSync(file, damaged.join('\n') + '\n');

  const { error } = attempt(() => reopen(file));
  assert.equal(error.code, 'JOURNAL_CORRUPT');
  assert.equal(error.line, 6);
  assert.match(error.message, /Line 6 /);
  assert.match(error.repair, /first 5 line/);
  assert.equal(fs.readFileSync(file, 'utf8'), damaged.join('\n') + '\n', 'the file is not touched');

  // Valid JSON in an impossible order is corruption too.
  fs.writeFileSync(file, [...all.slice(0, 4), all[3], ...all.slice(4)].join('\n') + '\n');
  assert.equal(code(() => reopen(file)), 'JOURNAL_CORRUPT');

  fs.writeFileSync(file, '{"t":"gendb-journal","v":2}\n');
  assert.equal(code(() => reopen(file)), 'JOURNAL_VERSION');
});

test('a merge is one record: a crash leaves all of it or none of it', () => {
  const file = tmpFile();
  const db = createDatabase({ journal: fileJournal(file), now });
  agentKneePain(db);
  const before = snapshot(db);
  const size = fs.statSync(file).size;
  db.merge(KNEE_BRANCH, { approvedBy: KIM });

  const added = fs.readFileSync(file).subarray(size).toString('utf8').split('\n').slice(0, -1);
  assert.equal(added.length, 1);
  const batch = JSON.parse(added[0]);
  assert.equal(batch.t, 'batch');
  assert.deepEqual(batch.records.map((r) => r.t), ['tx', 'tx', 'status']);

  const full = fs.readFileSync(file);
  for (const cut of [size, size + 1, Math.floor((size + full.length) / 2), full.length - 1]) {
    fs.writeFileSync(file, full.subarray(0, cut));
    const again = reopen(file);
    assert.deepEqual(snapshot(again), before, `cut at byte ${cut}`);
    assert.equal(again.schema().attrs.has('Run.knee_pain'), false);
    assert.equal(again.branches().find((b) => b.name === KNEE_BRANCH).status, 'open');
  }
  fs.writeFileSync(file, full);
  assert.deepEqual(snapshot(reopen(file)), snapshot(db));
});

test('a merge whose append fails changes nothing, in memory or on disk', () => {
  const file = tmpFile();
  const disk = fileJournal(file);
  let full = false;
  const journal = { read: disk.read, append: (r) => { if (full) throw new Error('ENOSPC'); disk.append(r); } };
  const db = createDatabase({ journal, now });
  agentKneePain(db);
  const before = snapshot(db);
  const heard = [];
  db.store.subscribe((tx) => heard.push(tx.id));

  full = true;
  assert.throws(() => db.merge(KNEE_BRANCH, { approvedBy: KIM }), /ENOSPC/);
  assert.deepEqual(snapshot(db), before);
  assert.deepEqual(heard, [], 'listeners never saw the merge');
  assert.equal(db.schema().attrs.has('Run.knee_pain'), false, 'no stale cached schema');

  full = false;
  db.merge(KNEE_BRANCH, { approvedBy: KIM });
  assert.equal(heard.length, 2);
  assert.deepEqual(snapshot(reopen(file)), snapshot(db));
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Database, GenDBError, evaluate, estimateTokens } from '../src/index.js';
import {
  createDatabase, agentKneePain, agentMetres, hallucinatedUI, attempt,
  KIM, SAM, COACH, KNEE_BRANCH, KNEE_INTENT, METRES_BRANCH,
} from '../demo/scenario.js';

const NOW = '2026-11-23T10:00:00.000Z';
const fresh = () => createDatabase({ now: () => NOW });
const code = (fn) => attempt(fn).error?.code;
const today = NOW.slice(0, 10);

test('expressions: unknown values are neither true nor false', () => {
  const ctx = { get: (a) => ({ x: 5 })[a] ?? null };
  assert.equal(evaluate(['<', ['get', 'x'], 10], ctx), true);
  assert.equal(evaluate(['<', ['get', 'missing'], 10], ctx), null);
  assert.equal(evaluate(['and', true, ['<', ['get', 'missing'], 10]], ctx), null);
  assert.equal(evaluate(['or', true, ['<', ['get', 'missing'], 10]], ctx), true);
  assert.equal(evaluate(['implies', ['exists', 'missing'], false], ctx), true);
  assert.equal(code(() => evaluate(['drop table'])), 'BAD_EXPRESSION');
});

test('a database needs an owner, and every write an actor', () => {
  assert.equal(code(() => new Database()), 'OWNER_REQUIRED');
  assert.equal(code(() => fresh().transact([])), 'ACTOR_REQUIRED');
});

test('the contract describes meaning and affordances, and contains no data', () => {
  const contract = fresh().open('mijn-runs', { actor: KIM }).describe();
  const distance = contract.fields.find((f) => f.name === 'distance_km');
  assert.deepEqual(
    { label: distance.label, type: distance.type, unit: distance.unit, min: distance.min, max: distance.max },
    { label: 'Afstand', type: 'number', unit: 'km', min: 0.1, max: 100 });
  assert.deepEqual(contract.fields.filter((f) => f.editable).map((f) => f.name), ['feeling', 'note']);
  assert.deepEqual(contract.actions.map((a) => [a.name, a.scope]), [['Run.log', 'collection'], ['Run.remove', 'row'], ['$edit', 'row']]);
  assert.deepEqual([contract.actions[1].availableWhen, contract.actions[1].otherwise], ['Run.race != true', 'wedstrijdresultaten zijn definitief']);
  assert.equal(contract.rules.length, 2);
  const text = JSON.stringify(contract);
  assert.ok(!text.includes('Hasselt') && !text.includes('run_'), 'no row data leaks into the contract');
});

test('one surface, different rows per actor', () => {
  const db = fresh();
  assert.equal(db.open('mijn-runs', { actor: KIM }).read().total, 11);
  assert.equal(db.open('mijn-runs', { actor: SAM }).read().total, 3);
});

test('rows say which actions are possible right now, and why not', () => {
  const rows = fresh().open('mijn-runs', { actor: KIM }).read().rows;
  const race = rows.find((r) => r.values.race);
  const training = rows.find((r) => !r.values.race);
  assert.deepEqual(race.actions['Run.remove'], { enabled: false, reason: 'wedstrijdresultaten zijn definitief' });
  assert.deepEqual(training.actions['Run.remove'], { enabled: true });
  assert.ok(!('Run.log' in race.actions), 'collection actions are not row affordances');
});

test('summaries cover all rows and group by an expression', () => {
  const { summary } = fresh().open('mijn-runs', { actor: KIM }).read();
  assert.equal(summary.values.runs, 11);
  assert.equal(summary.values.total_km, 104);
  assert.deepEqual(summary.groups.map((g) => [g.key, g.values.runs]), [['2026-09', 4], ['2026-10', 4], ['2026-11', 3]]);
});

test('acting through a surface writes validated, attributed facts', () => {
  const db = fresh();
  const mine = db.open('mijn-runs', { actor: KIM });
  const { id } = mine.act('Run.log', { params: { date: today, distance_km: 9, minutes: 50 } });
  assert.equal(db.query({ from: 'Run', where: ['=', ['get', 'Run.date'], today] })[0]['Run.owner'], KIM);
  mine.act('$edit', { id, params: { note: 'Lekker' } }, { intent: 'notitie bijwerken' });
  const [last] = db.why(id, 'Run.note');
  assert.deepEqual({ actor: last.actor, intent: last.intent, via: last.via, action: last.action, value: last.value },
    { actor: KIM, intent: 'notitie bijwerken', via: 'mijn-runs', action: '$edit', value: 'Lekker' });
  mine.act('Run.remove', { id });
  assert.equal(mine.read().total, 11);
});

test('a hallucinated UI is refused every time, with a way to repair', () => {
  const db = fresh();
  const before = db.store.seq;
  const results = hallucinatedUI(db);
  assert.deepEqual(results.map((r) => r.result.error?.code), [
    'UNKNOWN_PARAM', 'VALIDATION_FAILED', 'VALIDATION_FAILED', 'VALIDATION_FAILED', 'VALIDATION_FAILED',
    'ACTION_UNAVAILABLE', 'NOT_IN_SURFACE', 'UNKNOWN_FIELD', 'FIELD_NOT_EDITABLE', 'ROW_NOT_VISIBLE',
    'NOT_GRANTED', 'BRANCH_PROTECTED', 'BRANCH_PROTECTED',
  ]);
  assert.equal(db.store.seq, before, 'nothing was written');
  assert.deepEqual(results[0].result.error.didYouMean, ['distance_km']);
  assert.equal(results[2].result.error.violations[0].code, 'RULE_VIOLATED');
  for (const { result } of results) {
    const e = result.error;
    assert.ok(e.repair || e.violations?.every((v) => v.repair), `${e.code} carries a repair hint`);
  }
});

test('all problems of a write are reported together', () => {
  const { error } = attempt(() => fresh().open('mijn-runs', { actor: KIM })
    .act('Run.log', { params: { date: 'gisteren', distance_km: -1, minutes: 30, feeling: 'ok!' } }));
  assert.deepEqual(error.violations.map((v) => [v.field, v.code]), [
    ['date', 'INVALID_VALUE'], ['distance_km', 'INVALID_VALUE'], ['feeling', 'INVALID_VALUE'],
  ]);
  assert.deepEqual(error.violations[2].didYouMean, ['ok']);
});

test('an agent cannot touch main, but can do anything on a branch', () => {
  const db = fresh();
  const review = agentKneePain(db);
  assert.equal(db.open('mijn-runs', { actor: KIM }).read().tx, db.store.head('main'));
  assert.equal(code(() => db.open('knie-en-afstand', { actor: KIM })), 'NOT_GRANTED', 'not on main yet');
  assert.equal(db.open('knie-en-afstand', { actor: KIM, branch: KNEE_BRANCH }).read().total, 11);

  assert.deepEqual(review.schema.map((c) => [c.entity, c.level]), [
    ['$attr/Run.knee_pain', 'additive'], ['$surface/knie-en-afstand', 'additive'],
  ]);
  assert.match(review.schema[1].reasons[0], /for user:kim: 4 fields, actions: \$edit/);
  assert.equal(review.data.length, 11);
  assert.ok(review.data.every((c) => c.confidence === 0.4 && c.actor === COACH && c.intent === KNEE_INTENT));
  assert.deepEqual(review.conflicts, []);
});

test('merging needs an owner and keeps provenance', () => {
  const db = fresh();
  agentKneePain(db);
  assert.equal(code(() => db.merge(KNEE_BRANCH, { approvedBy: COACH })), 'APPROVAL_REQUIRED');
  db.merge(KNEE_BRANCH, { approvedBy: KIM });

  const knee = db.open('knie-en-afstand', { actor: KIM }).read();
  assert.equal(knee.summary.groups.find((g) => g.key === '10 km en meer').values.avg_pain, 3.75);
  const [origin] = db.why(knee.rows[0].id, 'Run.knee_pain');
  assert.deepEqual({ actor: origin.actor, confidence: origin.confidence, mergedFrom: origin.mergedFrom, approvedBy: origin.approvedBy },
    { actor: COACH, confidence: 0.4, mergedFrom: KNEE_BRANCH, approvedBy: KIM });
  assert.equal(code(() => db.transact([], { actor: COACH, branch: KNEE_BRANCH })), 'BRANCH_CLOSED');
});

test('a discarded branch leaves no trace on main', () => {
  const db = fresh();
  const head = db.store.head('main');
  agentKneePain(db);
  db.discard(KNEE_BRANCH, { actor: KIM });
  assert.equal(db.store.head('main'), head);
  assert.equal(db.schema().attrs.has('Run.knee_pain'), false);
});

test('conflicting edits are detected at merge', () => {
  const db = fresh();
  const id = db.open('mijn-runs', { actor: KIM }).read().rows[0].id;
  db.fork('agent/notes', { actor: COACH });
  db.transact([{ e: id, a: 'Run.note', v: 'van de agent' }], { actor: COACH, branch: 'agent/notes' });
  db.open('mijn-runs', { actor: KIM }).act('$edit', { id, params: { note: 'van Kim' } });
  const { error } = attempt(() => db.merge('agent/notes', { approvedBy: KIM }));
  assert.equal(error.code, 'MERGE_CONFLICT');
  assert.deepEqual(error.conflicts[0], { entity: id, attribute: 'Run.note', base: 'Halve marathon! Knie hield het net', theirs: 'van de agent', ours: 'van Kim' });
});

test('a merge is checked against what main has become', () => {
  const db = fresh();
  db.fork('agent/strict', { actor: COACH });
  db.evolve({ rules: { 'Run.max_halve': { on: 'Run', description: 'Niet verder dan een halve marathon', rule: ['<=', ['get', 'Run.distance_km'], 21.1] } } },
    { actor: COACH, branch: 'agent/strict' });
  db.open('mijn-runs', { actor: KIM }).act('Run.log', { params: { date: today, distance_km: 30, minutes: 180 } });
  assert.equal(code(() => db.merge('agent/strict', { approvedBy: KIM })), 'MERGE_REJECTED');
});

test('schemas only grow: a unit change is refused, a lens is accepted', () => {
  const db = fresh();
  const { refused, review } = agentMetres(db);
  assert.equal(refused.error.code, 'SCHEMA_BREAKING');
  assert.match(refused.error.changes[0].reasons[0], /unit changes from km to m/);
  assert.match(refused.error.repair, /lens/);
  assert.equal(review.schema[0].level, 'additive');
  assert.equal(review.data.length, 0, 'a lens moves no facts');
});

test('old and new UIs read and write the same facts through a lens', () => {
  const db = fresh();
  agentMetres(db);
  db.merge(METRES_BRANCH, { approvedBy: KIM });
  const km = db.open('mijn-runs', { actor: KIM });
  const m = db.open('runs-in-meters', { actor: KIM });
  const id = m.read().rows[0].id;
  assert.equal(m.read().rows[0].values.distance_m, 21100);
  assert.equal(m.read().summary.values.total_m, 104000);

  m.act('$edit', { id, params: { distance_m: 21097.5 } });
  assert.equal(km.read().rows[0].values.distance_km, 21.0975);
  assert.equal(code(() => m.act('$edit', { id, params: { distance_m: 50 } })), 'VALIDATION_FAILED', "the view's own minimum");
  assert.equal(code(() => m.act('$edit', { id, params: { distance_m: 100000 } })), 'VALIDATION_FAILED', 'the pace rule on the stored value');
  assert.equal(db.why(id, 'Run.distance_m')[0].value, 21097.5);
});

test('tightening is only accepted when existing facts already comply', () => {
  const db = fresh();
  const meta = { actor: KIM };
  const { error } = attempt(() => db.evolve({ attrs: { 'Run.distance_km': { ...db.schema().attrs.get('Run.distance_km'), max: 20 } } }, meta));
  assert.equal(error.code, 'SCHEMA_REJECTED_BY_DATA');
  assert.equal(error.violations.length, 1);
  assert.ok(db.evolve({ attrs: { 'Run.distance_km': { ...db.schema().attrs.get('Run.distance_km'), max: 50 } } }, meta));
  assert.equal(code(() => db.evolve({ attrs: { 'Run.feeling': null } }, meta)), 'SCHEMA_BREAKING');
  assert.equal(code(() => db.evolve({ attributes: {} }, meta)), 'SCHEMA_INVALID');
  const invalid = attempt(() => db.evolve({ rules: { 'Run.r': { on: 'Run', description: 'x', rule: ['>', ['get', 'Run.distance'], 0] } } }, meta));
  assert.deepEqual(invalid.error.problems[0].didYouMean, ['Run.distance_km']);
});

test('undo by intent restores earlier values and respects later edits', () => {
  const db = fresh();
  agentKneePain(db);
  db.merge(KNEE_BRANCH, { approvedBy: KIM });
  const knee = db.open('knie-en-afstand', { actor: KIM });
  const corrected = knee.read().rows[0].id;
  knee.act('$edit', { id: corrected, params: { knee_pain: 8 } }, { intent: 'pijn corrigeren' });

  const result = db.undo({ intent: KNEE_INTENT }, { actor: KIM });
  assert.equal(result.restored, 10);
  assert.deepEqual(result.skipped.map((s) => s.entity), [corrected]);
  const rows = knee.read().rows;
  assert.equal(rows.find((r) => r.id === corrected).values.knee_pain, 8, "Kim's own correction survives");
  assert.ok(rows.filter((r) => r.id !== corrected).every((r) => r.values.knee_pain === null));
  assert.ok(db.schema().attrs.has('Run.knee_pain'), 'the schema stays');
  assert.equal(db.undo({ intent: KNEE_INTENT }, { actor: KIM }).restored, 0, 'undoing twice does nothing');
});

test('time travel: a surface as of an earlier transaction', () => {
  const db = fresh();
  const mine = db.open('mijn-runs', { actor: KIM });
  const then = db.store.head('main');
  mine.act('Run.log', { params: { date: today, distance_km: 3, minutes: 20 } });
  assert.equal(mine.read().total, 12);
  assert.equal(mine.read({ asOf: then }).total, 11);
});

test('budgeted reads fit a context window and say what they left out', () => {
  const mine = fresh().open('mijn-runs', { actor: KIM });
  const full = mine.read();
  const small = mine.read({ budget: { tokens: 400 } });
  assert.ok(estimateTokens(full) > 400 && estimateTokens(small) <= 400);
  assert.equal(small.truncated.shown + small.truncated.omitted, 11);
  assert.deepEqual(small.summary, full.summary);
});

test('pii is redacted for models, not for the UI', () => {
  const all = fresh().open('alle-runs', { actor: KIM });
  assert.equal(all.read().rows[0].values.owner, SAM);
  assert.equal(all.read({ audience: 'model' }).rows[0].values.owner, '‹pii›');
});

test('subscriptions fire only when the surface content changes', () => {
  const db = fresh();
  const seen = [];
  const stop = db.open('mijn-runs', { actor: SAM }).subscribe((r) => seen.push(r.total));
  db.open('mijn-runs', { actor: KIM }).act('Run.log', { params: { date: today, distance_km: 3, minutes: 20 } });
  db.open('mijn-runs', { actor: SAM }).act('Run.log', { params: { date: today, distance_km: 3, minutes: 20 } });
  stop();
  db.open('mijn-runs', { actor: SAM }).act('Run.log', { params: { date: today, distance_km: 4, minutes: 25 } });
  assert.deepEqual(seen, [3, 4]);
});

test('references are checked in both directions', () => {
  const db = new Database({ owners: [KIM], now: () => NOW });
  const meta = { actor: KIM };
  db.evolve({
    types: { Shoe: { description: 'Een paar loopschoenen', label: 'Shoe.name' }, Run: { description: 'Een run' } },
    attrs: {
      'Shoe.name': { type: 'string', description: 'Naam', required: true },
      'Run.shoe': { type: 'ref', ref: 'Shoe', description: 'Gedragen schoenen' },
    },
    surfaces: { runs: { description: 'Runs', from: 'Run', fields: ['Run.shoe'], grants: ['*'] } },
  }, meta);
  db.transact([{ e: 's1', a: '$type', v: 'Shoe' }, { e: 's1', a: 'Shoe.name', v: 'Pegasus' }, { e: 'r1', a: '$type', v: 'Run' }, { e: 'r1', a: 'Run.shoe', v: 's1' }], meta);
  assert.deepEqual(db.open('runs', { actor: SAM }).read().rows[0].values.shoe, { id: 's1', label: 'Pegasus' });
  assert.equal(attempt(() => db.transact([{ e: 'r1', a: 'Run.shoe', v: 'nope' }], meta)).error.violations[0].code, 'INVALID_VALUE');
  assert.equal(attempt(() => db.transact([{ e: 's1', a: '$type', v: null }, { e: 's1', a: 'Shoe.name', v: null }], meta)).error.violations[0].code, 'REFERENCE_DANGLING');
});

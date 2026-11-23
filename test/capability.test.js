import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attenuate, inspect } from '../src/capability.js';
import { createDatabase, attempt, agentKneePain, KIM, SAM, COACH, KNEE_BRANCH } from '../demo/scenario.js';

const NOW = '2026-11-23T10:00:00.000Z';
const fresh = (options) => createDatabase({ now: () => NOW, ...options });
const code = (fn) => attempt(fn).error?.code;
const today = NOW.slice(0, 10);
const narrowed = (db, ...caveats) => db.redeem(caveats.reduce(attenuate, db.grant('mijn-runs', { actor: KIM })));
const fieldNames = (contract) => contract.fields.map((f) => f.name);
const actionNames = (contract) => contract.actions.map((a) => a.name);

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const unb64 = (s) => JSON.parse(Buffer.from(s, 'base64url').toString());

test('a granted token redeems to a working surface', () => {
  const db = fresh();
  const surface = db.redeem(db.grant('mijn-runs', { actor: SAM }));
  assert.equal(surface.read().total, 3);
  assert.deepEqual(surface.describe(), db.open('mijn-runs', { actor: SAM }).describe());
  const { id } = surface.act('Run.log', { params: { date: today, distance_km: 5, minutes: 30 } });
  assert.equal(db.why(id, 'Run.owner')[0].actor, SAM, 'the token acts as the actor it was issued to');
  assert.equal(inspect(db.grant('mijn-runs', { actor: SAM })).actor, SAM);
});

test('grant refuses an actor the surface does not grant, and needs an actor', () => {
  const db = fresh();
  assert.equal(code(() => db.grant('alle-runs', { actor: SAM })), 'NOT_GRANTED');
  assert.equal(code(() => db.grant('bestaat-niet', { actor: KIM })), 'NOT_GRANTED');
  assert.equal(code(() => db.grant('mijn-runs', {})), 'ACTOR_REQUIRED');
});

test('forged, tampered, stripped and garbage tokens are all TOKEN_INVALID, for the same reason', () => {
  const secret = 'x'.repeat(32);
  const db = fresh({ secret });
  const other = fresh({ secret: 'y'.repeat(32) });
  const token = db.grant('mijn-runs', { actor: SAM });
  const [payload, sig] = token.split('.');

  const forged = other.grant('alle-runs', { actor: KIM });
  const tampered = `${b64({ ...unb64(payload), actor: KIM })}.${sig}`;
  const narrow = attenuate(token, { readOnly: true });
  const [np, nsig] = narrow.split('.');
  const stripped = `${b64({ ...unb64(np), caveats: [] })}.${nsig}`;
  const swapped = `${b64({ ...unb64(np), caveats: [{ fields: ['date'] }] })}.${nsig}`;
  const extraKey = `${b64({ ...unb64(payload), admin: true })}.${sig}`;
  const unknownKind = attenuate(token, { id: 'x' }).replace(/^[^.]+/, (p) => b64({ ...unb64(p), caveats: [{ sudo: true }] }));

  const results = [forged, tampered, stripped, swapped, extraKey, unknownKind, 'garbage', '', 'a.b.c', `${payload}.`, null, 42, `${payload}.${sig}x`]
    .map((t) => attempt(() => db.redeem(t)).error);
  for (const error of results) {
    assert.equal(error.code, 'TOKEN_INVALID');
    assert.equal(error.message, results[0].message, 'nothing about why');
    assert.ok(error.repair);
  }
  assert.equal(db.redeem(fresh({ secret }).grant('mijn-runs', { actor: SAM })).read().total, 3, 'same secret, same verdict');
  assert.equal(code(() => attenuate('garbage', { readOnly: true })), 'TOKEN_INVALID');
});

test('a caveat of an unknown kind or shape cannot be added', () => {
  const token = fresh().grant('mijn-runs', { actor: KIM });
  for (const caveat of [{ sudo: true }, {}, null, [], { readOnly: false }, { audience: 'ui' }, { fields: 'date' },
    { where: ['drop', 'table'] }, { where: ['in', ['get', 'Run.feeling'], 'ok'] }, { expires: 'morgen' }, { id: '' }]) {
    assert.equal(code(() => attenuate(token, caveat)), 'CAVEAT_INVALID', JSON.stringify(caveat));
  }
});

test('fields: hides fields from the contract, the rows, edits, order and summaries', () => {
  const db = fresh();
  const s = narrowed(db, { fields: ['date', 'note', 'owner'] });
  const contract = s.describe();
  assert.deepEqual(fieldNames(contract), ['date', 'note'], 'owner is not in the surface, so it stays out');
  assert.deepEqual(contract.fields.filter((f) => f.editable).map((f) => f.name), ['note']);
  assert.deepEqual(actionNames(contract), ['Run.log', '$edit'], 'Run.remove is guarded on the hidden race field, so it would leak it');
  assert.deepEqual(contract.actions.at(-1).params.map((p) => p.name), ['note']);
  assert.deepEqual(contract.summary.measures.map((m) => m.name), ['runs'], 'no totals over a hidden distance');
  assert.ok(contract.summary.by, 'grouping by month of a visible date stays');

  const { rows, summary } = s.read();
  assert.deepEqual(Object.keys(rows[0].values), ['date', 'note']);
  assert.deepEqual(Object.keys(summary.values), ['runs']);
  assert.ok(!JSON.stringify(s.read()).includes('21.1'));

  const id = rows[0].id;
  assert.equal(code(() => s.act('$edit', { id, params: { feeling: 'ok' } })), 'UNKNOWN_FIELD', 'a hidden field does not exist');
  assert.equal(code(() => s.act('$edit', { id, params: { date: today } })), 'FIELD_NOT_EDITABLE');
  s.act('$edit', { id, params: { note: 'via een smal token' } });
  // Choice: fields narrows what is seen and edited; a create action keeps the parameters it needs.
  s.act('Run.log', { params: { date: today, distance_km: 5, minutes: 30 } });
  assert.equal(s.read().total, 12);

  const knee = fresh();
  agentKneePain(knee);
  const byPain = knee.redeem(attenuate(knee.grant('knie-en-afstand', { actor: KIM, branch: KNEE_BRANCH }), { fields: ['date', 'knee_pain'] }));
  assert.equal(byPain.describe().order, undefined, 'no ordering by a hidden distance');
  assert.equal(byPain.describe().summary.by, undefined, 'no grouping by a hidden distance');
});

test('editable: narrows edits only', () => {
  const s = narrowed(fresh(), { editable: ['note', 'distance_km'] });
  const contract = s.describe();
  assert.equal(contract.fields.length, 6);
  assert.deepEqual(contract.fields.filter((f) => f.editable).map((f) => f.name), ['note'], 'distance_km was never editable');
  const id = s.read().rows[0].id;
  assert.equal(code(() => s.act('$edit', { id, params: { feeling: 'ok' } })), 'FIELD_NOT_EDITABLE');
  assert.equal(code(() => s.act('$edit', { id, params: { distance_km: 20 } })), 'FIELD_NOT_EDITABLE');
  assert.ok(s.act('$edit', { id, params: { note: 'ok' } }).ok);

  const none = narrowed(fresh(), { editable: [] });
  assert.ok(!actionNames(none.describe()).includes('$edit'), 'nothing editable, no $edit');
  assert.ok(!('$edit' in none.read().rows[0].actions));
});

test('actions and readOnly: narrow what can be done', () => {
  const db = fresh();
  const s = narrowed(db, { actions: ['Run.remove', 'Run.purge'] });
  const contract = s.describe();
  assert.deepEqual(actionNames(contract), ['Run.remove']);
  assert.ok(contract.fields.every((f) => !f.editable), 'without $edit nothing is editable');
  const row = s.read().rows.find((r) => !r.values.race);
  assert.deepEqual(Object.keys(row.actions), ['Run.remove']);
  assert.equal(code(() => s.act('Run.log', { params: { date: today, distance_km: 5, minutes: 30 } })), 'NOT_IN_SURFACE');
  assert.equal(code(() => s.act('$edit', { id: row.id, params: { note: 'x' } })), 'NOT_IN_SURFACE');
  assert.equal(code(() => s.act('Run.purge', {})), 'NOT_IN_SURFACE', 'naming an action the surface lacks adds nothing');
  s.act('Run.remove', { id: row.id });

  const ro = narrowed(db, { readOnly: true });
  assert.deepEqual(actionNames(ro.describe()), []);
  assert.ok(ro.read().rows.every((r) => Object.keys(r.actions).length === 0));
  const err = attempt(() => ro.act('Run.log', { params: {} })).error;
  assert.equal(err.code, 'NOT_IN_SURFACE');
  assert.match(err.repair, /read-only/);
});

test('caveats intersect along a chain and can never widen', () => {
  const db = fresh();
  const s = narrowed(db,
    { fields: ['date', 'distance_km', 'note'], editable: ['note'] },
    { fields: ['date', 'note', 'feeling'] },
    { fields: ['date', 'distance_km', 'note', 'feeling', 'owner'], editable: ['note', 'feeling'] },
    { actions: ['$edit'] },
    { actions: ['$edit', 'Run.log', 'Run.remove'] });
  const contract = s.describe();
  assert.deepEqual(fieldNames(contract), ['date', 'note']);
  assert.deepEqual(contract.fields.filter((f) => f.editable).map((f) => f.name), ['note']);
  assert.deepEqual(actionNames(contract), ['$edit']);
  assert.equal(code(() => s.act('Run.log', { params: { date: today, distance_km: 5, minutes: 30 } })), 'NOT_IN_SURFACE');

  const ro = narrowed(db, { readOnly: true }, { actions: ['Run.log', '$edit'], editable: ['note'] });
  assert.deepEqual(actionNames(ro.describe()), [], 'readOnly cannot be undone');
});

test('where: an extra filter, AND-ed with the surface, for reads, acts and creates', () => {
  const db = fresh();
  const long = narrowed(db, { where: ['>=', ['get', 'Run.distance_km'], 10] });
  assert.equal(long.read().total, 4);
  assert.ok(long.read().rows.every((r) => r.values.distance_km >= 10));
  assert.equal(db.redeem(attenuate(db.grant('mijn-runs', { actor: SAM }), { where: ['>=', ['get', 'Run.distance_km'], 0] })).read().total, 3,
    "AND-ed: a filter that matches everything still shows only Sam's own runs");

  const short = db.open('mijn-runs', { actor: KIM }).read().rows.find((r) => r.values.distance_km < 10).id;
  assert.equal(code(() => long.act('$edit', { id: short, params: { note: 'x' } })), 'ROW_NOT_VISIBLE');
  assert.equal(code(() => long.act('Run.remove', { id: short })), 'ROW_NOT_VISIBLE');
  assert.equal(code(() => long.act('Run.log', { params: { date: today, distance_km: 5, minutes: 30 } })), 'OUTSIDE_SURFACE');
  long.act('Run.log', { params: { date: today, distance_km: 12, minutes: 70 } });

  const both = narrowed(db, { where: ['>=', ['get', 'Run.distance_km'], 10] }, { where: ['=', ['get', 'Run.feeling'], 'zwaar'] });
  assert.equal(both.read().total, 3);
});

test('where: a holder cannot filter on what it cannot see', () => {
  const db = fresh();
  const hidden = narrowed(db, { fields: ['date'] }, { where: ['=', ['get', 'Run.race'], true] });
  assert.equal(hidden.read().total, 0, 'a filter on a hidden field narrows to nothing, it is not an oracle');
  assert.equal(narrowed(db, { where: ['=', ['get', 'Run.owner'], KIM] }).read().total, 0, 'owner is not a field of the surface');
  const earlier = narrowed(db, { where: ['=', ['get', 'Run.race'], true] }, { fields: ['date'] });
  assert.equal(earlier.read().total, 2, 'a filter set while the field was visible stays');
});

test('expires: the earliest expiry wins, measured by the database clock', () => {
  let now = NOW;
  const db = createDatabase({ now: () => now });
  const token = attenuate(attenuate(db.grant('mijn-runs', { actor: KIM }), { expires: '2026-11-23T12:00:00Z' }), { expires: '2027-01-01T00:00:00Z' });
  const s = db.redeem(token);
  assert.equal(s.read().total, 11);
  now = '2026-11-23T12:00:00.000Z';
  assert.equal(code(() => s.read()), 'TOKEN_EXPIRED', 'checked on every use');
  assert.equal(code(() => db.redeem(token)), 'TOKEN_EXPIRED');
  assert.ok(attempt(() => db.redeem(token)).error.repair);
});

test('revoking a root kills what was derived from it; revoking a sub-id leaves the parent working', () => {
  const db = fresh();
  const root = db.grant('mijn-runs', { actor: SAM });
  const child = attenuate(root, { id: 'deel-ui', fields: ['date'] });
  const grandchild = attenuate(child, { readOnly: true });
  const open = db.redeem(grandchild);

  assert.equal(code(() => db.revoke('deel-ui', { actor: KIM, issuedTo: KIM })), undefined, "Kim's own sub-ids are not Sam's");
  assert.equal(open.read().total, 3);
  assert.equal(code(() => db.revoke('deel-ui', { actor: COACH, issuedTo: SAM })), 'NOT_GRANTED', 'only Sam or an owner');
  db.revoke('deel-ui', { actor: SAM });
  assert.equal(code(() => db.redeem(child)), 'TOKEN_REVOKED');
  assert.equal(code(() => open.read()), 'TOKEN_REVOKED', 'an open handle stops too');
  assert.equal(db.redeem(root).read().total, 3, 'the parent still works');

  const sibling = attenuate(root, { readOnly: true });
  db.revoke(inspect(root).id, { actor: KIM }); // an owner
  for (const t of [root, sibling]) assert.equal(code(() => db.redeem(t)), 'TOKEN_REVOKED');
  assert.equal(db.redeem(db.grant('mijn-runs', { actor: SAM })).read().total, 3, 'a new grant is a new root');
});

test("audience 'model' redacts pii whatever the caller asks", () => {
  const db = fresh();
  const token = attenuate(db.grant('alle-runs', { actor: KIM }), { audience: 'model' });
  const s = db.redeem(token);
  assert.equal(s.read().rows[0].values.owner, '‹pii›');
  assert.equal(s.read({ audience: 'ui' }).rows[0].values.owner, '‹pii›');
  const seen = [];
  s.subscribe((r) => seen.push(r.rows[0].values.owner))();
  assert.deepEqual(seen, ['‹pii›']);
  assert.equal(db.redeem(db.grant('alle-runs', { actor: KIM })).read().rows[0].values.owner, SAM);
});

test('a token tracks the live schema: grants removed later refuse it, also for the past', () => {
  const db = fresh();
  const token = db.grant('alle-runs', { actor: KIM });
  const s = db.redeem(token);
  const then = db.store.head('main');
  db.evolve({ surfaces: { 'alle-runs': { ...db.schema().surfaces.get('alle-runs'), grants: [KIM, 'user:trainer'] } } }, { actor: KIM });
  assert.equal(s.read().total, 14);
  db.evolve({ surfaces: { 'alle-runs': { ...db.schema().surfaces.get('alle-runs'), grants: ['user:trainer'] } } }, { actor: KIM });
  const err = attempt(() => s.read()).error;
  assert.equal(err.code, 'NOT_GRANTED');
  assert.equal(err.granted, undefined, "a token's holder learns nothing about the issuer's other surfaces");
  assert.equal(code(() => s.read({ asOf: then })), 'NOT_GRANTED');
  assert.equal(code(() => db.redeem(token)), 'NOT_GRANTED');
});

test('a narrowed handle cannot be widened in process', () => {
  const s = narrowed(fresh(), { readOnly: true });
  assert.throws(() => { s.actor = SAM; }, TypeError);
  assert.throws(() => { s.caveats = []; }, TypeError);
  assert.deepEqual(actionNames(s.describe()), []);
});

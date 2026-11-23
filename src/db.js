// The database: one fact log, guarded by its own schema.
//
// Who may do what:
//   owners   humans who answer for the data. They may write to protected branches and approve merges.
//   agents   may fork a branch and do anything there: extend the schema, write speculative facts.
//            Nothing they do reaches a protected branch until an owner has seen the diff.
//   UIs      hold surfaces (see surface.js) and nothing else.

import { GenDBError, didYouMean } from './errors.js';
import { Store, diffStates, equal } from './store.js';
import { Schema, PREFIX, checkDefinitions, classifyChanges, changesFromDiff, shortName } from './schema.js';
import { validateEntities, checkValue } from './validate.js';
import { runQuery } from './query.js';
import { Surface, grantsActor } from './surface.js';

const META = ['actor', 'intent', 'model', 'confidence', 'via', 'action', 'kind', 'changes', 'origin', 'mergedFrom', 'approvedBy', 'undoes'];
const pickMeta = (m) => Object.fromEntries(META.filter((k) => m[k] !== undefined && m[k] !== null).map((k) => [k, m[k]]));
const key = (c) => `${c.e}\u0000${c.a}`;
const isSchema = (e) => e.startsWith('$');

/** A candidate state: `state` with `facts` applied, without touching `state`. */
function overlay(state, facts) {
  const touched = new Map();
  for (const { e, a, v } of facts) {
    if (!touched.has(e)) touched.set(e, new Map(state.get(e) ?? []));
    if (v === null || v === undefined) touched.get(e).delete(a);
    else touched.get(e).set(a, v);
  }
  return {
    touched,
    lookup: (e) => (touched.has(e) ? touched.get(e) : state.get(e)),
    *all() {
      for (const entry of state) if (!touched.has(entry[0])) yield entry;
      for (const entry of touched) if (entry[1].size) yield entry;
    },
  };
}

export class Database {
  /** Pass a `journal` (see journal.js) to keep the fact log across restarts. */
  constructor({ owners, protect = ['main'], now, journal } = {}) {
    if (!owners?.length) throw new GenDBError('OWNER_REQUIRED', 'A database needs at least one owner who answers for its data.', { repair: 'Pass { owners: ["user:…"] }.' });
    this.store = new Store({ now, journal });
    this.owners = new Set(owners);
    this.protected = new Set(protect);
    this._schemas = new Map();
  }

  // -- reading -----------------------------------------------------------------------------------

  schema(branch = 'main', asOf) {
    if (asOf !== undefined && asOf !== null) return new Schema(this.store.stateAt(branch, asOf));
    const b = this.store.branch(branch);
    const cached = this._schemas.get(branch);
    if (cached?.version === b.schemaVersion) return cached.schema;
    const schema = new Schema(b.state);
    this._schemas.set(branch, { version: b.schemaVersion, schema });
    return schema;
  }

  /** Privileged read for owners and tooling. Generated UIs never get this; they get surfaces. */
  query(q, { branch = 'main', asOf, actor } = {}) {
    const schema = this.schema(branch, asOf);
    if (!schema.types.has(q.from)) {
      throw new GenDBError('UNKNOWN_TYPE', `Type "${q.from}" does not exist.`, { didYouMean: didYouMean(q.from, schema.types.keys()), repair: `Query one of: ${[...schema.types.keys()].join(', ')}.` });
    }
    const attrs = schema.attrsOf(q.from);
    return runQuery(this.store.stateAt(branch, asOf), schema, q, this._ctx(actor)).map((row) => ({
      id: row.id,
      ...Object.fromEntries(attrs.map((a) => [a, row.get(a)]).filter(([, v]) => v !== null)),
    }));
  }

  open(name, { actor, branch = 'main' } = {}) {
    this._requireActor({ actor });
    return new Surface(this, name, { actor, branch });
  }

  /** The surfaces an actor has been granted on a branch. */
  surfaces({ actor, branch = 'main' } = {}) {
    return [...this.schema(branch).surfaces]
      .filter(([, def]) => grantsActor(def.grants, actor))
      .map(([name, def]) => ({ name, label: def.label ?? name, description: def.description }));
  }

  /** Where a value came from: every transaction that set it, newest first. */
  why(entity, attribute, { branch = 'main' } = {}) {
    const s = this.schema(branch).storage(attribute);
    const out = [];
    for (const tx of this.store.visible(branch)) {
      const f = tx.facts.find((x) => x.e === entity && x.a === s.attr);
      if (f) out.push({ tx: tx.id, at: tx.at, ...pickMeta({ ...tx, changes: undefined }), value: s.fromStored(f.v), previous: s.fromStored(f.prev) });
    }
    return out.reverse();
  }

  log({ branch = 'main', limit = 20 } = {}) {
    return this.store.visible(branch).slice(-limit).reverse().map((tx) => ({
      tx: tx.id, at: tx.at, branch: tx.branch, ...pickMeta({ ...tx, changes: undefined }), facts: tx.facts.length,
    }));
  }

  branches() {
    return [...this.store.branches.values()].map((b) => ({
      name: b.name, parent: b.parent, status: b.status, actor: b.actor, intent: b.intent, transactions: b.own.length,
    }));
  }

  // -- writing -----------------------------------------------------------------------------------

  fork(name, { from = 'main', actor, intent } = {}) {
    this._requireActor({ actor });
    const b = this.store.fork(name, { from, actor, intent });
    return { branch: b.name, from, forkedAt: b.forkTx };
  }

  /** Grows the schema. See schema.js for what is accepted. */
  evolve(changes, meta = {}) {
    this._requireActor(meta);
    const branch = meta.branch ?? 'main';
    this._guardDirect(branch, meta.actor, 'change the schema');
    const b = this.store.openBranch(branch);

    const facts = [];
    for (const [kind, defs] of Object.entries(changes)) {
      if (!PREFIX[kind]) {
        throw new GenDBError('SCHEMA_INVALID', `"${kind}" is not a kind of schema definition.`, { didYouMean: didYouMean(kind, Object.keys(PREFIX)), repair: `Use: ${Object.keys(PREFIX).join(', ')}.` });
      }
      for (const [name, def] of Object.entries(defs)) facts.push({ e: PREFIX[kind] + name, a: '$def', v: def ?? null });
    }

    const before = this.schema(branch);
    const o = overlay(b.state, facts);
    const after = new Schema(o.all());

    const problems = checkDefinitions(after, changes);
    if (problems.length) {
      throw new GenDBError('SCHEMA_INVALID', `The proposed schema has ${problems.length} problem(s). ${problems[0].message}`, { problems });
    }

    const classified = classifyChanges(before, changes);
    const breaking = classified.filter((c) => c.level === 'breaking');
    if (breaking.length) {
      throw new GenDBError('SCHEMA_BREAKING', `Refused: ${breaking[0].entity.split('/')[1]} — ${breaking[0].reasons[0]}.`, {
        changes: breaking,
        repair: 'Schemas only grow. Leave the existing definition as it is and add a new attribute that reads from it through a lens, ' +
          'for example { type: "number", unit: "m", lens: { kind: "scale", from: "Run.distance_km", factor: 1000 } }. ' +
          'Old and new UIs then share the same facts.',
      });
    }

    const tightening = classified.filter((c) => c.level === 'tightening');
    if (tightening.length) {
      const ids = [...o.all()].map(([e]) => e).filter((e) => !isSchema(e));
      const violations = validateEntities(ids, o.lookup, after, this._ctx(meta.actor), () => o.all());
      if (violations.length) {
        throw new GenDBError('SCHEMA_REJECTED_BY_DATA', `${violations.length} existing fact(s) do not satisfy the tightened schema. ${violations[0].message}`, {
          changes: tightening,
          violations: violations.slice(0, 20),
          repair: 'Fix or backfill the listed entities first, or relax the proposed constraint.',
        });
      }
    }

    const changesMeta = classified.map(({ entity, level, reasons }) => ({ entity, level, reasons }));
    return this.store.commit(branch, facts, pickMeta({ ...meta, kind: 'schema', changes: changesMeta }));
  }

  /** Direct write. Validated like every write; on protected branches only owners may use it. */
  transact(facts, meta = {}) {
    this._requireActor(meta);
    const branch = meta.branch ?? 'main';
    this._guardDirect(branch, meta.actor, 'write');
    return this._write(branch, facts, meta);
  }

  /** The single door every data write goes through, whichever API it came from. */
  _write(branch, facts, meta) {
    const b = this.store.openBranch(branch);
    const schema = this.schema(branch);
    const problems = [];
    const stored = [];

    for (const f of facts) {
      if (isSchema(f.e)) {
        throw new GenDBError('SCHEMA_VIA_EVOLVE', 'Schema definitions are changed with evolve(), not with a data write.', { repair: 'Call db.evolve({ attrs: { … } }).' });
      }
      const def = schema.attrs.get(f.a);
      const v = f.v ?? null;
      if (!def?.lens) { stored.push({ e: f.e, a: f.a, v }); continue; }
      // A write through a lens is checked against the view's own constraints, then translated.
      const problem = v === null ? null : checkValue(def, v, (id) => b.state.get(id));
      if (problem) { problems.push({ code: 'INVALID_VALUE', entity: f.e, attribute: f.a, field: shortName(f.a), ...problem, message: `${f.a} ${problem.message}` }); continue; }
      const s = schema.storage(f.a);
      stored.push({ e: f.e, a: s.attr, v: s.toStored(v) });
    }

    const o = overlay(b.state, stored);
    problems.push(...validateEntities([...o.touched.keys()], o.lookup, schema, this._ctx(meta.actor), () => o.all()));
    if (problems.length) {
      throw new GenDBError('VALIDATION_FAILED', `Write rejected, ${problems.length} problem(s): ${problems.map((p) => p.message).join(' · ')}`, { violations: problems });
    }
    return this.store.commit(branch, stored, pickMeta(meta));
  }

  // -- speculation -------------------------------------------------------------------------------

  _branchDiff(b) {
    const base = this.store.stateAt(b.parent, b.forkTx);
    return { base, theirs: diffStates(base, b.state), ours: diffStates(base, this.store.branch(b.parent).state) };
  }

  /** What a branch would change if merged: the thing a human approves instead of code. */
  review(branchName) {
    const b = this.store.branch(branchName);
    if (!b.parent) throw new GenDBError('NOT_A_FORK', `"${branchName}" has no parent to be reviewed against.`, { repair: 'Review a branch created with fork().' });
    const { base, theirs, ours } = this._branchDiff(b);
    const oursByKey = new Map(ours.map((c) => [key(c), c]));

    const lastWriter = new Map();
    for (const tx of b.own) for (const f of tx.facts) lastWriter.set(key(f), tx);

    return {
      branch: branchName,
      into: b.parent,
      status: b.status,
      intent: b.intent,
      transactions: b.own.length,
      schema: classifyChanges(new Schema(base), changesFromDiff(theirs.filter((c) => isSchema(c.e))))
        .map(({ entity, level, reasons }) => ({ entity, level, reasons })),
      data: theirs.filter((c) => !isSchema(c.e)).map((c) => {
        const tx = lastWriter.get(key(c)) ?? {};
        return { entity: c.e, attribute: c.a, before: c.before, after: c.after, ...pickMeta({ actor: tx.actor, intent: tx.intent, model: tx.model, confidence: tx.confidence }) };
      }),
      conflicts: theirs
        .filter((c) => oursByKey.has(key(c)) && !equal(oursByKey.get(key(c)).after, c.after))
        .map((c) => ({ entity: c.e, attribute: c.a, base: c.before, theirs: c.after, ours: oursByKey.get(key(c)).after })),
    };
  }

  merge(branchName, { approvedBy } = {}) {
    const b = this.store.openBranch(branchName);
    if (!b.parent) throw new GenDBError('NOT_A_FORK', `"${branchName}" has no parent to merge into.`, { repair: 'Merge a branch created with fork().' });
    if (this.protected.has(b.parent) && !this.owners.has(approvedBy)) {
      throw new GenDBError('APPROVAL_REQUIRED', `Merging into "${b.parent}" needs the approval of an owner.`, {
        owners: [...this.owners],
        repair: 'Show the result of review() to an owner and pass { approvedBy } once they agree.',
      });
    }
    const review = this.review(branchName);
    if (review.conflicts.length) {
      throw new GenDBError('MERGE_CONFLICT', `${review.conflicts.length} value(s) changed on both "${branchName}" and "${b.parent}".`, {
        conflicts: review.conflicts,
        repair: `Fork a fresh branch from "${b.parent}" and re-apply the change on top of the current values.`,
      });
    }

    // The branch was valid against its own past. Check it against the parent's present.
    const parent = this.store.openBranch(b.parent);
    const o = overlay(parent.state, this._branchDiff(b).theirs.map((c) => ({ e: c.e, a: c.a, v: c.after })));
    const schema = new Schema(o.all());
    const ids = (review.schema.length ? [...o.all()].map(([e]) => e) : [...o.touched.keys()]).filter((e) => !isSchema(e));
    const violations = validateEntities(ids, o.lookup, schema, this._ctx(approvedBy), () => o.all());
    if (violations.length) {
      throw new GenDBError('MERGE_REJECTED', `The merged result would break ${violations.length} rule(s). ${violations[0].message}`, {
        violations,
        repair: `"${b.parent}" changed since the fork. Fix the listed entities on the branch, or fork again.`,
      });
    }

    // Replay transaction by transaction, so provenance survives the merge. All or nothing, also on disk.
    this.store.atomic(() => {
      for (const tx of b.own) this.store.commit(b.parent, tx.facts, pickMeta({ ...tx, origin: tx.id, mergedFrom: branchName, approvedBy }));
      this.store.setStatus(branchName, 'merged');
    });
    return { ok: true, merged: b.own.length, review };
  }

  discard(branchName, { actor } = {}) {
    this._requireActor({ actor });
    const b = this.store.openBranch(branchName);
    if (!b.parent) throw new GenDBError('NOT_A_FORK', `"${branchName}" cannot be discarded.`, { repair: 'Only forks can be discarded.' });
    this.store.setStatus(branchName, 'discarded');
    return { ok: true, discarded: b.own.length };
  }

  /**
   * Undo by provenance: "take back everything that was written for this intent / by this agent".
   * History is never rewritten; the undo is a new transaction that restores the earlier values.
   * A value someone has changed since is left alone and reported.
   */
  undo(selector, meta = {}) {
    this._requireActor(meta);
    const branch = meta.branch ?? 'main';
    this._guardDirect(branch, meta.actor, 'undo');
    const keys = ['intent', 'actor', 'model', 'via', 'tx'].filter((k) => selector?.[k] !== undefined);
    if (!keys.length) throw new GenDBError('BAD_SELECTOR', 'Say what to undo.', { repair: 'Pass { intent }, { actor }, { model }, { via } or { tx }.' });

    const visible = this.store.visible(branch);
    const undone = new Set(visible.flatMap((tx) => tx.undoes ?? []));
    const targets = visible.filter((tx) =>
      tx.kind !== 'schema' && tx.kind !== 'undo' && !undone.has(tx.id) && keys.every((k) => (k === 'tx' ? tx.id : tx[k]) === selector[k]));

    const state = this.store.branch(branch).state;
    const pending = new Map();
    const skipped = [];
    for (const tx of [...targets].reverse()) {
      for (const f of [...tx.facts].reverse()) {
        const k = key(f);
        const current = pending.has(k) ? pending.get(k).v : state.get(f.e)?.get(f.a) ?? null;
        if (equal(current, f.v)) pending.set(k, { e: f.e, a: f.a, v: f.prev });
        else skipped.push({ tx: tx.id, entity: f.e, attribute: f.a, reason: 'changed again since; left as it is now' });
      }
    }

    const tx = pending.size
      ? this._write(branch, [...pending.values()], { ...meta, intent: meta.intent ?? `undo ${keys.map((k) => `${k}=${selector[k]}`).join(', ')}`, kind: 'undo', undoes: targets.map((t) => t.id) })
      : null;
    return { ok: true, undone: targets.map((t) => t.id), restored: tx?.facts.length ?? 0, skipped, tx: tx?.id ?? null };
  }

  // -- internals ---------------------------------------------------------------------------------

  _ctx(actor) {
    return { actor: actor ?? null, now: this.store.now() };
  }

  _requireActor(meta) {
    if (!meta?.actor) {
      throw new GenDBError('ACTOR_REQUIRED', 'Every action must say who is acting; there are no anonymous writes.', { repair: 'Pass { actor: "user:…" } or { actor: "agent:…" }.' });
    }
  }

  _guardDirect(branch, actor, what) {
    if (this.protected.has(branch) && !this.owners.has(actor)) {
      throw new GenDBError('BRANCH_PROTECTED', `${actor} may not ${what} directly on "${branch}".`, {
        repair: `Fork a branch with fork(), make the change there and ask an owner to merge it. To change data on "${branch}" without a merge, act through a surface you have been granted.`,
      });
    }
  }
}

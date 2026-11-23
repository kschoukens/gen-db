// The fact log.
//
// Nothing is ever updated in place. The database is an append-only list of transactions; each
// transaction is a set of facts (entity, attribute, value) plus the answer to "who wrote this,
// for which intent, with which model, how sure were they". Current state is a fold over the log.
//
// Three things the rest of GenDB needs fall out of that for free:
//   - time travel   state as of any transaction
//   - branches      a fork is a pointer into the log, so speculation is cheap
//   - provenance    every value can be traced to a transaction, and transactions can be undone

import { GenDBError } from './errors.js';

export function equal(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => Object.hasOwn(b, k) && equal(a[k], b[k]));
}

/** State is Map<entity, Map<attribute, value>>. Values are treated as immutable. */
export const cloneState = (state) => new Map([...state].map(([e, attrs]) => [e, new Map(attrs)]));

export function applyFact(state, { e, a, v }) {
  const attrs = state.get(e);
  if (v === null || v === undefined) {
    if (!attrs) return;
    attrs.delete(a);
    if (attrs.size === 0) state.delete(e);
  } else if (attrs) attrs.set(a, v);
  else state.set(e, new Map([[a, v]]));
}

const EMPTY = new Map();

export function diffStates(before, after) {
  const out = [];
  for (const e of new Set([...before.keys(), ...after.keys()])) {
    const x = before.get(e) ?? EMPTY;
    const y = after.get(e) ?? EMPTY;
    for (const a of new Set([...x.keys(), ...y.keys()])) {
      const from = x.get(a) ?? null;
      const to = y.get(a) ?? null;
      if (!equal(from, to)) out.push({ e, a, before: from, after: to });
    }
  }
  return out;
}

export class Store {
  /**
   * With a `journal` (see journal.js) the store first replays it, then records every state change
   * in it before applying the change in memory.
   */
  constructor({ now = () => new Date().toISOString(), journal } = {}) {
    this.now = now;
    this.seq = 0;
    this.ids = 0;
    this.listeners = new Set();
    this.branches = new Map();
    this.branches.set('main', { name: 'main', parent: null, forkTx: 0, status: 'open', own: [], state: new Map(), schemaVersion: 0 });
    this.journal = null;
    this._batch = null;
    if (journal) {
      journal.read().forEach((record, i) => this._replay(record, i + 1));
      this.journal = journal;
    }
  }

  branch(name) {
    const b = this.branches.get(name);
    if (!b) {
      throw new GenDBError('UNKNOWN_BRANCH', `There is no branch "${name}".`, {
        branches: [...this.branches.keys()],
        repair: 'Fork it first, or use an existing branch.',
      });
    }
    return b;
  }

  openBranch(name) {
    const b = this.branch(name);
    if (b.status !== 'open') {
      throw new GenDBError('BRANCH_CLOSED', `Branch "${name}" was ${b.status} and no longer accepts writes.`, {
        repair: `Fork a new branch from "${b.parent ?? 'main'}".`,
      });
    }
    return b;
  }

  fork(name, { from = 'main', actor, intent } = {}) {
    if (this.branches.has(name)) {
      throw new GenDBError('BRANCH_EXISTS', `Branch "${name}" already exists.`, { repair: 'Pick another name.' });
    }
    this.openBranch(from);
    const { branch } = this._record({ t: 'fork', ids: this.ids, branch: { name, parent: from, forkTx: this.seq, actor, intent, at: this.now() } });
    return this._applyFork(branch);
  }

  /** Closes a fork for good: 'merged' or 'discarded'. */
  setStatus(name, status) {
    const b = this.openBranch(name);
    this._record({ t: 'status', branch: name, status });
    this._touch(b);
    b.status = status;
    return b;
  }

  /** Ids are global, so entities created on different branches never collide at merge time. */
  newId(type) {
    return `${type.toLowerCase()}_${++this.ids}`;
  }

  /** Appends a transaction. Facts that change nothing are dropped; an empty transaction is not recorded. */
  commit(branchName, facts, meta = {}) {
    const b = this.openBranch(branchName);
    // Nothing is applied until the journal has the transaction, so a failed append changes nothing.
    const pending = new Map();
    const recorded = [];
    for (const { e, a, v } of facts) {
      const k = `${e}\u0000${a}`;
      const prev = pending.has(k) ? pending.get(k) : b.state.get(e)?.get(a) ?? null;
      const next = v === undefined || v === null ? null : structuredClone(v);
      if (equal(prev, next)) continue;
      pending.set(k, next);
      recorded.push({ e, a, v: next, prev });
    }
    if (recorded.length === 0) return null;
    const { tx } = this._record({ t: 'tx', ids: this.ids, tx: { id: this.seq + 1, branch: branchName, at: this.now(), ...meta, facts: recorded } });
    this._applyTx(b, tx);
    if (this._batch) this._batch.emitted.push(tx);
    else for (const listener of [...this.listeners]) listener(tx);
    return tx;
  }

  /**
   * Runs `fn` as one unit: the records it produces reach the journal as a single line, and if `fn`
   * or that append throws, the store is put back as it was. Listeners hear about the transactions
   * only once the whole unit is in, so nobody observes something that is then taken back.
   */
  atomic(fn) {
    if (this._batch) return fn();
    const batch = this._batch = { records: [], seq: this.seq, touched: new Map(), forked: [], emitted: [] };
    let result;
    try {
      result = fn();
      if (this.journal && batch.records.length) this.journal.append({ t: 'batch', records: batch.records });
    } catch (err) {
      this._rollback(batch);
      throw err;
    } finally {
      this._batch = null;
    }
    for (const tx of batch.emitted) for (const listener of [...this.listeners]) listener(tx);
    return result;
  }

  /** Transactions a branch can see: its own, plus its ancestors' up to the point where it forked. */
  visible(branchName, asOf = Infinity) {
    const b = this.branch(branchName);
    const inherited = b.parent ? this.visible(b.parent, Math.min(b.forkTx, asOf)) : [];
    return [...inherited, ...b.own.filter((tx) => tx.id <= asOf)];
  }

  head(branchName) {
    return this.visible(branchName).at(-1)?.id ?? 0;
  }

  stateAt(branchName, asOf) {
    const b = this.branch(branchName);
    if (asOf === undefined || asOf === null) return b.state;
    const state = new Map();
    for (const tx of this.visible(branchName, asOf)) for (const f of tx.facts) applyFact(state, f);
    return state;
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // -- internals ---------------------------------------------------------------------------------

  /**
   * Hands a record to the journal (or to the open batch) and returns it as replay will see it.
   * Applying that round-tripped copy, rather than the original, keeps memory and disk identical even
   * for values JSON cannot represent exactly (undefined properties, -0, NaN).
   */
  _record(record) {
    if (!this.journal) return record;
    const canonical = JSON.parse(JSON.stringify(record));
    if (this._batch) this._batch.records.push(canonical);
    else this.journal.append(canonical);
    return canonical;
  }

  _applyFork({ name, parent, forkTx, actor, intent, at }) {
    const b = {
      name, parent, forkTx, status: 'open', own: [],
      state: cloneState(this.branch(parent).state), schemaVersion: 0, actor, intent, at,
    };
    this.branches.set(name, b);
    this._batch?.forked.push(name);
    return b;
  }

  _applyTx(b, tx) {
    this._touch(b);
    for (const f of tx.facts) applyFact(b.state, f);
    b.own.push(tx);
    this.seq = tx.id;
    if (tx.facts.some((f) => f.e.startsWith('$'))) b.schemaVersion++;
  }

  /** Inside atomic(): remembers a branch as it was before the unit first changed it. */
  _touch(b) {
    const batch = this._batch;
    if (!batch || batch.touched.has(b)) return;
    batch.touched.set(b, { state: cloneState(b.state), own: b.own.length, status: b.status });
  }

  _rollback(batch) {
    for (const name of batch.forked) this.branches.delete(name);
    for (const [b, before] of batch.touched) {
      b.state = before.state;
      b.own.length = before.own;
      b.status = before.status;
      // A version number is a cache key (see Database.schema): move forward, never back to a reused one.
      b.schemaVersion++;
    }
    // `ids` is not rolled back: an id that was handed out and then not used is harmless.
    this.seq = batch.seq;
  }

  /** Re-applies one journal record. Trusted: no validation, no listeners, nothing appended. */
  _replay(record, n) {
    const bad = (why) => new GenDBError('JOURNAL_CORRUPT', `Journal record ${n} ${why}.`, {
      record: n,
      repair: 'The journal does not describe a history this store can have produced. Restore it from a backup, or cut it off before this record.',
    });
    switch (record?.t) {
      case 'tx': {
        const { tx } = record;
        const b = this.branches.get(tx?.branch);
        if (!b || b.status !== 'open') throw bad(`writes to ${b ? 'closed' : 'unknown'} branch "${tx?.branch}"`);
        if (tx.id !== this.seq + 1) throw bad(`has transaction ${tx.id} where ${this.seq + 1} was expected`);
        if (!Array.isArray(tx.facts) || !Number.isInteger(record.ids)) throw bad('is an incomplete transaction');
        this._applyTx(b, tx);
        this.ids = record.ids;
        return;
      }
      case 'fork': {
        const { branch } = record;
        if (this.branches.has(branch?.name)) throw bad(`forks "${branch?.name}", which already exists`);
        if (this.branches.get(branch?.parent)?.status !== 'open') throw bad(`forks from "${branch?.parent}", which is not an open branch`);
        if (branch.forkTx !== this.seq) throw bad(`forks at transaction ${branch.forkTx} where ${this.seq} was expected`);
        if (!Number.isInteger(record.ids)) throw bad('is an incomplete fork');
        this._applyFork(branch);
        this.ids = record.ids;
        return;
      }
      case 'status': {
        const b = this.branches.get(record.branch);
        if (b?.status !== 'open' || !b.parent || !['merged', 'discarded'].includes(record.status)) throw bad(`cannot mark "${record.branch}" as ${record.status}`);
        b.status = record.status;
        return;
      }
      case 'batch':
        if (!Array.isArray(record.records)) throw bad('is a batch without records');
        for (const r of record.records) this._replay(r, n);
        return;
      default:
        throw bad(`has unknown type ${JSON.stringify(record?.t)}`);
    }
  }
}

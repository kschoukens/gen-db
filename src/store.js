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
  constructor({ now = () => new Date().toISOString() } = {}) {
    this.now = now;
    this.seq = 0;
    this.ids = 0;
    this.listeners = new Set();
    this.branches = new Map();
    this.branches.set('main', { name: 'main', parent: null, forkTx: 0, status: 'open', own: [], state: new Map(), schemaVersion: 0 });
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
    const parent = this.openBranch(from);
    const b = {
      name, parent: from, forkTx: this.seq, status: 'open', own: [],
      state: cloneState(parent.state), schemaVersion: 0, actor, intent, at: this.now(),
    };
    this.branches.set(name, b);
    return b;
  }

  /** Ids are global, so entities created on different branches never collide at merge time. */
  newId(type) {
    return `${type.toLowerCase()}_${++this.ids}`;
  }

  /** Appends a transaction. Facts that change nothing are dropped; an empty transaction is not recorded. */
  commit(branchName, facts, meta = {}) {
    const b = this.openBranch(branchName);
    const recorded = [];
    for (const { e, a, v } of facts) {
      const prev = b.state.get(e)?.get(a) ?? null;
      const next = v === undefined || v === null ? null : structuredClone(v);
      if (equal(prev, next)) continue;
      applyFact(b.state, { e, a, v: next });
      recorded.push({ e, a, v: next, prev });
    }
    if (recorded.length === 0) return null;
    const tx = { id: ++this.seq, branch: branchName, at: this.now(), ...meta, facts: recorded };
    b.own.push(tx);
    if (recorded.some((f) => f.e.startsWith('$'))) b.schemaVersion++;
    for (const listener of [...this.listeners]) listener(tx);
    return tx;
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
}

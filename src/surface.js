// Surfaces: the one new primitive.
//
// A surface is a named, granted, live slice of the database, defined by the intent it serves:
// which rows, which fields, which of them may be edited, which actions may be taken. Reading one
// returns more than rows. It returns a contract:
//
//   describe()  what the data means and what can be done with it. No data at all. This is what a
//               model needs to generate a UI, so the model never has to see the data itself.
//   read()      the rows, and for every row which actions are possible right now, and if not, why.
//   act()       the only way a UI can change anything. Checked against the surface, then against
//               the schema. A generated UI can be arbitrarily wrong; it cannot be arbitrarily harmful.
//
// This is hypermedia (HATEOAS) pushed down into the database. It never caught on for hand-written
// clients, because they hard-coded their knowledge anyway. A model is the first client that can
// actually read a self-describing response and build the right thing from it.

import { GenDBError, didYouMean } from './errors.js';
import { evaluate, explain } from './expr.js';
import { runQuery, summarize } from './query.js';
import { shortName, view } from './schema.js';
import { checkValue } from './validate.js';

export const grantsActor = (grants = [], actor) =>
  grants.some((g) => g === '*' || g === actor || (g.endsWith(':*') && String(actor).startsWith(g.slice(0, -1))));

const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null));
const REDACTED = '‹pii›';
/** Why an action is not possible: the author's own words if given, otherwise the guard itself. */
const unavailable = (action) => action.otherwise ?? `requires ${explain(action.when)}`;

/** A rough token estimate (about four characters per token) for budgeted reads. */
export const estimateTokens = (value) => Math.ceil(JSON.stringify(value).length / 4);

export class Surface {
  constructor(db, name, { actor, branch = 'main' }) {
    this.db = db;
    this.name = name;
    this.actor = actor;
    this.branch = branch;
    this._load(); // fail on open, not on first use
  }

  /** Resolved on every call: schema and grants can change underneath a long-lived UI. */
  _load(asOf) {
    const schema = this.db.schema(this.branch, asOf);
    const def = schema.surfaces.get(this.name);
    const granted = this.db.surfaces({ actor: this.actor, branch: this.branch }).map((s) => s.name);
    if (!def || !grantsActor(def.grants, this.actor)) {
      // Deliberately the same answer for "does not exist" and "not for you".
      throw new GenDBError('NOT_GRANTED', `${this.actor} has no surface "${this.name}" on "${this.branch}".`, {
        granted,
        didYouMean: didYouMean(this.name, granted),
        repair: granted.length ? `Open one of: ${granted.join(', ')}. For anything else, ask an owner for a new surface.` : 'Ask an owner to grant a surface.',
      });
    }
    return { def, schema, state: this.db.store.stateAt(this.branch, asOf), ctx: this.db._ctx(this.actor) };
  }

  _field(schema, attr, extra = {}) {
    const d = schema.attrs.get(attr);
    return clean({
      name: shortName(attr), attr, label: d.label ?? shortName(attr), type: d.type, description: d.description,
      unit: d.unit, values: d.values, ref: d.ref, required: d.required || undefined,
      min: d.min, max: d.max, maxLength: d.maxLength, pii: d.pii || undefined, example: d.example, ...extra,
    });
  }

  _actionNames(def) {
    return [...(def.actions ?? []), ...((def.editable ?? []).length ? ['$edit'] : [])];
  }

  /** The contract. Contains meaning and affordances, never data. */
  describe() {
    const { def, schema } = this._load();
    const actions = (def.actions ?? []).map((name) => {
      const a = schema.actions.get(name);
      return clean({
        name, kind: a.kind, scope: a.kind === 'create' ? 'collection' : 'row',
        label: a.label ?? name, description: a.description, destructive: a.kind === 'delete' || undefined,
        params: Object.entries(a.params ?? {}).map(([p, spec]) =>
          spec.attr
            ? this._field(schema, spec.attr, { name: p, required: !spec.optional || undefined })
            : clean({ name: p, label: spec.label ?? p, ...spec, optional: undefined, required: !spec.optional || undefined })),
        availableWhen: a.when ? explain(a.when) : undefined,
        otherwise: a.when ? a.otherwise : undefined,
      });
    });
    if ((def.editable ?? []).length) {
      actions.push({
        name: '$edit', kind: 'update', scope: 'row', label: 'Edit', description: 'Change editable fields of a row in place.',
        params: def.editable.map((attr) => this._field(schema, attr, { required: undefined })),
      });
    }
    return clean({
      gendb: 'surface/0',
      name: this.name,
      label: def.label ?? this.name,
      intent: def.description,
      entity: { type: def.from, description: schema.types.get(def.from).description },
      fields: def.fields.map((attr) => this._field(schema, attr, { editable: def.editable?.includes(attr) || undefined })),
      actions,
      summary: def.summary && {
        measures: Object.entries(def.summary.measures).map(([name, m]) =>
          clean({ name, label: m.label ?? name, fn: m.fn, of: m.of, unit: m.fn === 'count' ? undefined : schema.attrs.get(m.of).unit })),
        by: def.summary.by && { label: def.summary.by.label ?? 'group' },
      },
      order: def.orderBy,
      rules: schema.rulesOf(def.from).map(([id, r]) => ({ id, description: r.description })),
    });
  }

  _rows({ def, schema, state, ctx }) {
    return runQuery(state, schema, { from: def.from, where: def.where, orderBy: def.orderBy }, ctx);
  }

  /**
   * Rows plus per-row affordances.
   *   audience  'ui' (default) gets real values; 'model' gets fields marked pii redacted.
   *   budget    { tokens } trims rows to fit a context window. The summary still covers all rows,
   *             and the result says honestly how much was left out.
   *   asOf      a transaction id: the surface as it was then.
   */
  read({ asOf, audience = 'ui', budget } = {}) {
    const loaded = this._load(asOf);
    const { def, schema, state, ctx } = loaded;
    const all = this._rows(loaded);

    const value = (row, attr) => {
      const d = schema.attrs.get(attr);
      const v = row.get(attr);
      if (v === null) return null;
      if (d.pii && audience === 'model') return REDACTED;
      if (d.type !== 'ref') return v;
      const target = state.get(v);
      const labelAttr = schema.types.get(d.ref)?.label;
      return { id: v, label: (target && labelAttr && view(v, target, schema).get(labelAttr)) ?? v };
    };

    const rows = all.slice(0, def.limit ?? Infinity).map((row) => ({
      id: row.id,
      values: Object.fromEntries(def.fields.map((attr) => [shortName(attr), value(row, attr)])),
      actions: Object.fromEntries(this._actionNames(def)
        .filter((name) => name === '$edit' || schema.actions.get(name).kind !== 'create')
        .map((name) => {
          const a = schema.actions.get(name);
          if (!a?.when || evaluate(a.when, { ...ctx, get: (x) => row.get(x) }) === true) return [name, { enabled: true }];
          return [name, { enabled: false, reason: unavailable(a) }];
        })),
    }));

    const result = clean({
      surface: this.name,
      branch: this.branch,
      tx: asOf ?? this.db.store.head(this.branch),
      total: all.length,
      rows,
      summary: def.summary && summarize(all, def.summary, ctx),
    });

    if (budget?.tokens && estimateTokens(result) > budget.tokens) {
      const trimmed = (n) => ({ ...result, rows: rows.slice(0, n), truncated: { shown: n, omitted: all.length - n, note: 'summary covers all rows' } });
      let lo = 0;
      let hi = rows.length;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (estimateTokens(trimmed(mid)) <= budget.tokens) lo = mid;
        else hi = mid - 1;
      }
      return trimmed(lo);
    }
    return result;
  }

  _visibleRow(loaded, id) {
    const { def, schema, state, ctx } = loaded;
    const attrs = typeof id === 'string' ? state.get(id) : null;
    const row = attrs && attrs.get('$type') === def.from ? view(id, attrs, schema) : null;
    if (!row || (def.where && evaluate(def.where, { ...ctx, get: (a) => row.get(a) }) !== true)) {
      // Same answer whether the row does not exist or merely lies outside this surface.
      throw new GenDBError('ROW_NOT_VISIBLE', `There is no row "${id}" in surface "${this.name}".`, { repair: 'Use an id returned by read().' });
    }
    return row;
  }

  /** The only way a UI changes data. */
  act(actionName, { id, params = {} } = {}, meta = {}) {
    const loaded = this._load();
    const { def, schema, ctx } = loaded;
    const available = this._actionNames(def);
    if (!available.includes(actionName)) {
      throw new GenDBError('NOT_IN_SURFACE', `Surface "${this.name}" has no action "${actionName}".`, {
        available,
        didYouMean: didYouMean(actionName, available),
        repair: available.length ? `Use one of: ${available.join(', ')}.` : 'This surface is read-only.',
      });
    }

    const facts = [];
    let label;

    if (actionName === '$edit') {
      this._visibleRow(loaded, id);
      label = 'edit';
      const editable = def.editable.map(shortName);
      for (const [name, v] of Object.entries(params)) {
        const attr = def.fields.find((a) => shortName(a) === name);
        if (!attr) {
          throw new GenDBError('UNKNOWN_FIELD', `Surface "${this.name}" has no field "${name}".`, { didYouMean: didYouMean(name, def.fields.map(shortName)), repair: `Editable fields are: ${editable.join(', ')}.` });
        }
        if (!def.editable.includes(attr)) {
          throw new GenDBError('FIELD_NOT_EDITABLE', `Field "${name}" is read-only in surface "${this.name}".`, { editable, repair: `Only these can be edited here: ${editable.join(', ')}.` });
        }
        facts.push({ e: id, a: attr, v: v === '' ? null : v });
      }
    } else {
      const a = schema.actions.get(actionName);
      label = a.label ?? actionName;
      const spec = a.params ?? {};
      for (const name of Object.keys(params)) {
        if (!spec[name]) {
          throw new GenDBError('UNKNOWN_PARAM', `Action "${actionName}" has no parameter "${name}".`, { didYouMean: didYouMean(name, Object.keys(spec)), repair: `Parameters are: ${Object.keys(spec).join(', ') || 'none'}.` });
        }
      }
      const given = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== null && v !== undefined && v !== ''));
      const missing = Object.keys(spec).filter((name) => !spec[name].optional && !(name in given));
      if (missing.length) {
        throw new GenDBError('MISSING_PARAM', `Action "${actionName}" needs: ${missing.join(', ')}.`, { missing, repair: `Provide ${missing.join(', ')}.` });
      }
      for (const [name, v] of Object.entries(given)) {
        const problem = spec[name].attr ? null : checkValue(spec[name], v);
        if (problem) throw new GenDBError('INVALID_PARAM', `Parameter "${name}" ${problem.message}.`, { param: name, repair: problem.repair });
      }

      const row = a.kind === 'create' ? null : this._visibleRow(loaded, id);
      const ectx = { ...ctx, params: given, get: (x) => row?.get(x) ?? null };
      if (row && a.when && evaluate(a.when, ectx) !== true) {
        throw new GenDBError('ACTION_UNAVAILABLE', `"${label}" is not possible for ${id} right now: ${unavailable(a)}.`, {
          reason: unavailable(a),
          repair: 'read() reports for every row which actions are enabled; only offer those.',
        });
      }

      if (a.kind === 'delete') {
        for (const attr of row.attrs.keys()) facts.push({ e: id, a: attr, v: null });
      } else {
        if (a.kind === 'create') {
          id = this.db.store.newId(a.on);
          facts.push({ e: id, a: '$type', v: a.on });
        }
        for (const [name, v] of Object.entries(given)) if (spec[name].attr) facts.push({ e: id, a: spec[name].attr, v });
        for (const [attr, expr] of Object.entries(a.set ?? {})) facts.push({ e: id, a: attr, v: evaluate(expr, ectx) });
      }

      // A surface cannot be used to create rows that fall outside itself.
      if (a.kind === 'create' && def.where) {
        const draft = new Map();
        for (const f of facts) if (f.v !== null) draft.set(schema.storage(f.a).attr, schema.attrs.get(f.a)?.lens ? schema.storage(f.a).toStored(f.v) : f.v);
        const created = view(id, draft, schema);
        if (evaluate(def.where, { ...ctx, get: (x) => created.get(x) }) !== true) {
          throw new GenDBError('OUTSIDE_SURFACE', `The new ${a.on} would not be part of surface "${this.name}".`, { where: explain(def.where), repair: `Rows in this surface satisfy: ${explain(def.where)}.` });
        }
      }
    }

    const tx = this.db._write(this.branch, facts, {
      actor: this.actor, intent: meta.intent ?? label, model: meta.model, confidence: meta.confidence, via: this.name, action: actionName,
    });
    return { ok: true, id, tx: tx?.id ?? null };
  }

  /**
   * Live binding. Calls back whenever what this surface shows has changed.
   * (Here by re-reading after each commit; a real engine would maintain the view incrementally.)
   */
  subscribe(callback, options = {}) {
    let last = null;
    const push = () => {
      let result;
      try { result = this.read(options); } catch (err) { result = err instanceof GenDBError ? err.toJSON() : { ok: false, error: { code: 'INTERNAL', message: String(err) } }; }
      const { tx: _tx, ...content } = result;
      const snapshot = JSON.stringify(content);
      if (snapshot !== last) { last = snapshot; callback(result); }
    };
    push();
    return this.db.store.subscribe((tx) => { if (tx.branch === this.branch) push(); });
  }
}

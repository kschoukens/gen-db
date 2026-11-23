// Reading: filter, order and summarise entities of one type. Deliberately small. The interesting
// part of GenDB is not the query language but what a result is wrapped in (see surface.js).

import { evaluate } from './expr.js';
import { view } from './schema.js';

const compare = (a, b) => (a === b ? 0 : a === null ? 1 : b === null ? -1 : a < b ? -1 : 1);

export function runQuery(state, schema, { from, where, orderBy = [] }, ctx = {}) {
  const rows = [];
  for (const [id, attrs] of state) {
    if (attrs.get('$type') !== from) continue;
    const entity = view(id, attrs, schema);
    if (where && evaluate(where, { ...ctx, get: (a) => entity.get(a) }) !== true) continue;
    rows.push(entity);
  }
  rows.sort((x, y) => {
    for (const [attr, dir] of orderBy) {
      const c = compare(x.get(attr), y.get(attr));
      if (c !== 0) return dir === 'desc' ? -c : c;
    }
    return compare(x.id, y.id);
  });
  return rows;
}

const round = (n) => Number(n.toPrecision(12));

function measure(rows, { fn, of }) {
  if (fn === 'count') return rows.length;
  const values = rows.map((r) => r.get(of)).filter((v) => typeof v === 'number');
  if (!values.length) return null;
  if (fn === 'sum') return round(values.reduce((a, b) => a + b, 0));
  if (fn === 'avg') return round(values.reduce((a, b) => a + b, 0) / values.length);
  return fn === 'min' ? Math.min(...values) : Math.max(...values);
}

/** Totals over ALL matching rows, optionally broken down by an expression. */
export function summarize(rows, spec, ctx = {}) {
  const compute = (subset) => Object.fromEntries(Object.entries(spec.measures).map(([name, m]) => [name, measure(subset, m)]));
  const out = { values: compute(rows) };
  if (spec.by) {
    const groups = new Map();
    for (const row of rows) {
      const key = evaluate(spec.by.expr, { ...ctx, get: (a) => row.get(a) });
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }
    out.groups = [...groups].sort(([a], [b]) => compare(a, b)).map(([key, subset]) => ({ key, values: compute(subset) }));
  }
  return out;
}

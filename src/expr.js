// One small expression language for everything that used to be application code: invariants,
// action guards, row policies, filters and derived values.
//
// Expressions are plain JSON arrays (`['<=', ['get', 'Run.distance_km'], 100]`), not functions.
// That is the point: a model can write them, the database stores them as facts, a reviewer can
// read them in a diff, and nothing an untrusted agent proposes is ever eval()'d.
//
// Unknown values behave as in SQL: a comparison with a missing value is `null` (unknown). A rule
// only fails when it is definitely false; a guard or filter only passes when it is definitely true.

import { GenDBError } from './errors.js';

const nz = (v) => (v === undefined ? null : v);

const NUMERIC = {
  '+': (a, b) => a + b,
  '-': (a, b) => a - b,
  '*': (a, b) => a * b,
  '/': (a, b) => (b === 0 ? null : a / b),
};
const COMPARE = {
  '<': (a, b) => a < b,
  '<=': (a, b) => a <= b,
  '>': (a, b) => a > b,
  '>=': (a, b) => a >= b,
};

export function evaluate(x, ctx = {}) {
  if (!Array.isArray(x)) return nz(x);
  const [op, ...args] = x;
  const ev = (a) => evaluate(a, ctx);

  if (op in NUMERIC) {
    const [a, b] = args.map(ev);
    return typeof a === 'number' && typeof b === 'number' ? NUMERIC[op](a, b) : null;
  }
  if (op in COMPARE) {
    const [a, b] = args.map(ev);
    return a === null || b === null ? null : COMPARE[op](a, b);
  }
  switch (op) {
    case 'get': return nz(ctx.get?.(args[0]));
    case 'param': return nz(ctx.params?.[args[0]]);
    case 'actor': return nz(ctx.actor);
    case 'now': return nz(ctx.now);
    case 'today': return ctx.now ? ctx.now.slice(0, 10) : null;
    case 'exists': return nz(ctx.get?.(args[0])) !== null;
    case '=': return ev(args[0]) === ev(args[1]);
    case '!=': return ev(args[0]) !== ev(args[1]);
    case 'in': { const v = ev(args[0]); return v === null ? null : args[1].includes(v); }
    case 'not': { const v = ev(args[0]); return v === null ? null : !v; }
    case 'and': {
      let unknown = false;
      for (const a of args) { const v = ev(a); if (v === false) return false; if (v === null) unknown = true; }
      return unknown ? null : true;
    }
    case 'or': {
      let unknown = false;
      for (const a of args) { const v = ev(a); if (v === true) return true; if (v === null) unknown = true; }
      return unknown ? null : false;
    }
    case 'implies': return ev(['or', ['not', args[0]], args[1]]);
    case 'if': return ev(args[0]) === true ? ev(args[1]) : ev(args[2]);
    case 'month': { const v = ev(args[0]); return typeof v === 'string' ? v.slice(0, 7) : null; }
    case 'year': { const v = ev(args[0]); return typeof v === 'string' ? v.slice(0, 4) : null; }
    default:
      throw new GenDBError('BAD_EXPRESSION', `Unknown operator "${op}".`, {
        repair: `Use one of: get, param, actor, now, today, exists, =, !=, <, <=, >, >=, in, not, and, or, implies, if, +, -, *, /, month, year.`,
      });
  }
}

/** Every attribute an expression reads, so a schema change can be checked before it is accepted. */
export function attributesIn(x, out = new Set()) {
  if (!Array.isArray(x)) return out;
  const [op, ...args] = x;
  if (op === 'get' || op === 'exists') out.add(args[0]);
  else if (op === 'in') attributesIn(args[0], out);
  else args.forEach((a) => attributesIn(a, out));
  return out;
}

/** Human-readable rendering, used when a guard has no description of its own. */
export function explain(x) {
  if (!Array.isArray(x)) return JSON.stringify(x);
  const [op, ...args] = x;
  const e = args.map(explain);
  switch (op) {
    case 'get': return args[0];
    case 'param': return `<${args[0]}>`;
    case 'actor': return 'the current actor';
    case 'now': return 'now';
    case 'today': return 'today';
    case 'exists': return `${args[0]} is set`;
    case 'in': return `${e[0]} is one of ${args[1].join(', ')}`;
    case 'not': return `not (${e[0]})`;
    case 'and': return e.map((s) => `(${s})`).join(' and ');
    case 'or': return e.map((s) => `(${s})`).join(' or ');
    case 'implies': return `if (${e[0]}) then (${e[1]})`;
    case 'if': return `(${e[0]}) ? ${e[1]} : ${e[2]}`;
    case 'month': return `month of ${e[0]}, as YYYY-MM`;
    case 'year': return `year of ${e[0]}, as YYYY`;
    default: return `${e[0]} ${op} ${e[1]}`;
  }
}

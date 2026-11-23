// Capabilities: a surface you can hold, narrow and hand on.
//
// A surface decides everything a UI can see and do. For that to mean anything across a network,
// holding the surface has to be the permission: no "who are you" on every request, no actor in a
// query string. A token is a macaroon-style HMAC chain over the surface it opens:
//
//   sig0 = HMAC(secret, root)           root = { id, surface, actor, branch }, minted by the database
//   sigN = HMAC(sigN-1, caveatN)        every caveat narrows what the token allows
//
// The token carries the root, the caveats and only the last signature. So anyone holding it can
// append a caveat on their own, without the secret or a round trip (the last signature is the key
// for the next), and hand the narrower token to a sub-UI or a model. Nobody can remove a caveat or
// forge a root. Caveats are readable by every holder: they restrict, they do not hide.
//
// What a caveat narrows is resolved against the surface's definition at every use (see narrow()),
// so a token follows the live schema and can never reach beyond it.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { GenDBError } from './errors.js';
import { attributesIn, evaluate } from './expr.js';
import { shortName } from './schema.js';

const MAX_TOKEN = 16 * 1024;
const MAX_DEPTH = 32;
const ROOT = ['actor', 'branch', 'id', 'surface'];
const B64URL = /^[A-Za-z0-9_-]+$/;

/** JSON with sorted keys, so that signer and verifier hash the same bytes for the same value. */
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

const hmac = (key, text) => createHmac('sha256', key).update(text).digest();
const rootOf = (p) => Object.fromEntries(ROOT.map((k) => [k, p[k]]));
const encode = (payload, sig) => `${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${sig.toString('base64url')}`;

const literal = (x) => x === null || ['string', 'number', 'boolean'].includes(typeof x);

function isExpression(x, depth = 0) {
  if (!Array.isArray(x)) return literal(x);
  const [op, ...args] = x;
  if (typeof op !== 'string' || depth > MAX_DEPTH) return false;
  // evaluate() holds the one list of operators; probing it with no arguments keeps this check from
  // drifting away from it. Anything that throws is rejected.
  try { evaluate([op]); } catch { return false; }
  if (op === 'get' || op === 'exists' || op === 'param') return args.length === 1 && typeof args[0] === 'string';
  if (op === 'in') return args.length === 2 && isExpression(args[0], depth + 1) && Array.isArray(args[1]) && args[1].every(literal);
  return args.every((a) => isExpression(a, depth + 1));
}

const names = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');

// Every kind can only narrow. Values that would be no-ops (readOnly: false, audience: 'ui') are
// refused rather than ignored, so a caveat never looks like it grants something.
const KINDS = {
  fields: names,
  editable: names,
  actions: names,
  readOnly: (v) => v === true,
  where: (v) => isExpression(v),
  expires: (v) => typeof v === 'string' && Number.isFinite(Date.parse(v)),
  audience: (v) => v === 'model',
  id: (v) => typeof v === 'string' && v.length > 0 && v.length <= 200,
};

function caveatProblem(c) {
  if (c === null || typeof c !== 'object' || Array.isArray(c)) return 'a caveat is an object, for example { fields: ["date"] }';
  const keys = Object.keys(c);
  if (!keys.length) return 'a caveat must say what it narrows';
  for (const k of keys) {
    if (!Object.hasOwn(KINDS, k)) return `"${k}" is not a kind of caveat`;
    if (!KINDS[k](c[k])) return `"${k}" has an invalid value`;
  }
  return null;
}

// Deliberately one answer for every way a token can be wrong: why a signature fails is a hint to a forger.
const invalid = () => new GenDBError('TOKEN_INVALID', 'This token is not valid.', {
  repair: 'Use a token exactly as it was issued or narrowed with attenuate(). Ask for a new one if it was damaged.',
});

/** Splits a token without checking its signature. Returns null for anything that is not well formed. */
function parse(token) {
  if (typeof token !== 'string' || token.length > MAX_TOKEN) return null;
  const parts = token.split('.');
  if (parts.length !== 2 || !parts.every((p) => B64URL.test(p))) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); } catch { return null; }
  const sig = Buffer.from(parts[1], 'base64url');
  if (sig.length !== 32 || sig.toString('base64url') !== parts[1]) return null;
  const wellFormed = payload !== null && typeof payload === 'object' && !Array.isArray(payload)
    // Only signed keys may be present: nothing unsigned may ride along in a token.
    && Object.keys(payload).sort().join() === [...ROOT, 'caveats'].sort().join()
    && ROOT.every((k) => typeof payload[k] === 'string' && payload[k].length > 0)
    && Array.isArray(payload.caveats) && payload.caveats.every((c) => caveatProblem(c) === null);
  return wellFormed ? { payload, sig } : null;
}

/** Mints a root token. Only the database calls this; it holds the secret. */
export function mint(secret, root) {
  return encode({ ...rootOf(root), caveats: [] }, hmac(secret, canonical(rootOf(root))));
}

/** The payload of a token whose signature chain checks out under `secret`; TOKEN_INVALID otherwise. */
export function verify(secret, token) {
  const parsed = parse(token);
  if (!parsed) throw invalid();
  let sig = hmac(secret, canonical(rootOf(parsed.payload)));
  for (const c of parsed.payload.caveats) sig = hmac(sig, canonical(c));
  if (!timingSafeEqual(sig, parsed.sig)) throw invalid();
  return parsed.payload;
}

/**
 * Narrows a token. Pure: no database, no secret, no network. Whoever holds a token can do this
 * and hand the result on; the result can never do more than the token it came from.
 */
export function attenuate(token, caveat) {
  const parsed = parse(token);
  if (!parsed) throw invalid();
  // Sign exactly what a verifier will read back from JSON (no undefined, no class instances).
  let c;
  try { c = JSON.parse(JSON.stringify(caveat ?? null)); } catch { c = undefined; }
  const problem = caveatProblem(c);
  if (problem) {
    throw new GenDBError('CAVEAT_INVALID', `Cannot narrow the token: ${problem}.`, {
      kinds: Object.keys(KINDS),
      repair: 'Use { fields: [names] }, { editable: [names] }, { actions: [names] }, { readOnly: true }, { where: expression }, ' +
        '{ expires: ISO timestamp }, { audience: "model" } or { id: string }, with names as describe() shows them.',
    });
  }
  return encode({ ...parsed.payload, caveats: [...parsed.payload.caveats, c] }, hmac(parsed.sig, canonical(c)));
}

/** What a token says, unverified. For a holder who wants to know its ids or expiry; never for deciding access. */
export function inspect(token) {
  const parsed = parse(token);
  if (!parsed) throw invalid();
  return structuredClone(parsed.payload);
}

/** Every id a token answers to: its root and each sub-token it passed through. Revoking any of them kills it. */
export const idsOf = (payload) => [payload.id, ...payload.caveats.filter((c) => c.id !== undefined).map((c) => c.id)];

/** The earliest expiry in the chain as epoch milliseconds, or Infinity. */
export const expiryOf = (payload) => Math.min(...payload.caveats.filter((c) => c.expires !== undefined).map((c) => Date.parse(c.expires)));

const intersect = (current, next) => (current === null ? [...next] : current.filter((x) => next.includes(x)));

/**
 * The surface definition as a token's caveats leave it. Everything is an intersection with what the
 * definition allows now, so a name that is not (or no longer) in the surface narrows to nothing.
 *
 * `fields` narrows what can be seen and edited. It does not touch the parameters of actions: a
 * create action still takes the values it needs, because that is what the action is, and it
 * reveals nothing stored. To take an action away, narrow `actions`. The one exception: an action
 * whose guard reads a hidden field goes too, because its availability would reveal that field.
 *
 * Returns { def, audience }. `actionDef(name)` looks up an action, to see what its guard reads.
 */
export function narrow(def, caveats = [], actionDef = () => undefined) {
  if (!caveats.length) return { def };
  let fields = null;
  let editable = null;
  let actions = null;
  let audience;
  const wheres = [];
  let visible = new Set(def.fields);

  for (const c of caveats) {
    if (c.fields) {
      fields = intersect(fields, c.fields);
      visible = new Set(def.fields.filter((a) => fields.includes(shortName(a))));
    }
    if (c.editable) editable = intersect(editable, c.editable);
    if (c.actions) actions = intersect(actions, c.actions);
    if (c.readOnly) { actions = []; editable = []; }
    // A filter is an oracle on what it reads. A holder may only filter on fields it can see at that
    // point in the chain; anything else narrows to no rows at all.
    if (c.where !== undefined) wheres.push([...attributesIn(c.where)].every((a) => visible.has(a)) ? c.where : false);
    if (c.audience) audience = c.audience;
  }

  const shown = def.fields.filter((a) => visible.has(a));
  const hidden = new Set(def.fields.filter((a) => !visible.has(a)));
  const readsHidden = (expr) => [...attributesIn(expr)].some((a) => hidden.has(a));
  const canEdit = actions === null || actions.includes('$edit');

  // Order and summaries over a hidden field would leak it (row order, totals, group keys).
  const orderBy = def.orderBy?.filter(([a]) => !hidden.has(a));
  let summary;
  if (def.summary) {
    const measures = Object.fromEntries(Object.entries(def.summary.measures).filter(([, m]) => !(m.of && hidden.has(m.of))));
    const by = def.summary.by && !readsHidden(def.summary.by.expr) ? def.summary.by : undefined;
    summary = Object.keys(measures).length ? { ...def.summary, measures, by } : undefined;
  }

  return {
    audience,
    def: {
      ...def,
      fields: shown,
      editable: (def.editable ?? []).filter((a) => visible.has(a) && canEdit && (editable === null || editable.includes(shortName(a)))),
      // An action whose guard reads a hidden field would leak it through "enabled" and its reason.
      actions: (def.actions ?? []).filter((name) => (actions === null || actions.includes(name)) && !readsHidden(actionDef(name)?.when)),
      where: wheres.length ? ['and', ...(def.where ? [def.where] : []), ...wheres] : def.where,
      orderBy: orderBy?.length ? orderBy : undefined,
      summary,
    },
  };
}

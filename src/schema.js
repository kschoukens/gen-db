// The schema carries the meaning.
//
// In a generated-UI world there is no hand-written application to hold the knowledge of what a
// column means, which values are sane or what a user may do with a row. So the schema holds it:
// descriptions, units, constraints, rules, actions and surfaces, all written for a model to read.
//
// The schema is itself stored as facts (entity `$attr/Run.distance_km`, attribute `$def`). It
// therefore branches, diffs, merges and time-travels exactly like data. An agent can propose a
// schema change on a branch together with the data that needs it, and a human reviews both in one diff.
//
// Schemas only grow. A change is classified as
//   additive    always safe: new things, relaxed constraints, documentation
//   tightening  safe only if every existing fact already satisfies it; the database checks
//   breaking    refused. Meaning changes go through a lens (see below), never through a migration.

import { GenDBError, didYouMean } from './errors.js';
import { attributesIn } from './expr.js';
import { equal } from './store.js';

export const PREFIX = {
  types: '$type/',
  attrs: '$attr/',
  rules: '$rule/',
  actions: '$action/',
  surfaces: '$surface/',
};
export const VALUE_TYPES = ['string', 'number', 'boolean', 'date', 'datetime', 'enum', 'ref'];
const LENS_KINDS = ['rename', 'scale', 'map'];
const SUMMARY_FNS = ['count', 'sum', 'avg', 'min', 'max'];

export const typeOf = (attr) => attr.slice(0, attr.indexOf('.'));
export const shortName = (attr) => attr.slice(attr.indexOf('.') + 1);

// Lenses let two versions of the schema read and write the same facts. They are restricted to
// transformations that are invertible by construction, so a write through the new name is always
// a well-defined write to the old one. A UI generated last year keeps working; nobody migrates.
const round = (n) => Number(n.toPrecision(12));

export function lensForward(lens, v) {
  if (v === null || v === undefined) return null;
  if (lens.kind === 'scale') return round(v * lens.factor);
  if (lens.kind === 'map') return lens.mapping[v] ?? null;
  return v;
}

export function lensBackward(lens, v) {
  if (v === null || v === undefined) return null;
  if (lens.kind === 'scale') return round(v / lens.factor);
  if (lens.kind === 'map') return Object.keys(lens.mapping).find((k) => lens.mapping[k] === v) ?? null;
  return v;
}

export class Schema {
  constructor(state) {
    for (const kind of Object.keys(PREFIX)) this[kind] = new Map();
    for (const [e, attrs] of state) {
      if (!e.startsWith('$')) continue;
      const kind = Object.keys(PREFIX).find((k) => e.startsWith(PREFIX[k]));
      const def = attrs.get('$def');
      if (kind && def) this[kind].set(e.slice(PREFIX[kind].length), def);
    }
  }

  attrsOf(type) {
    return [...this.attrs.keys()].filter((a) => typeOf(a) === type);
  }

  rulesOf(type) {
    return [...this.rules].filter(([, def]) => def.on === type);
  }

  /** Follows a lens chain down to the attribute that is physically stored. */
  storage(attr) {
    const chain = [];
    let name = attr;
    while (this.attrs.get(name)?.lens && chain.length < 16) {
      chain.push(this.attrs.get(name).lens);
      name = chain.at(-1).from;
    }
    return {
      attr: name,
      toStored: (v) => chain.reduce((x, lens) => lensBackward(lens, x), v),
      fromStored: (v) => chain.reduceRight((x, lens) => lensForward(lens, x), v),
    };
  }
}

/** A read-only entity that resolves lens attributes on the fly. */
export function view(id, attrs, schema) {
  return {
    id,
    type: attrs.get('$type'),
    attrs,
    get(a) {
      const lens = schema.attrs.get(a)?.lens;
      return lens ? lensForward(lens, this.get(lens.from)) : attrs.get(a) ?? null;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Well-formedness: does a proposed definition make sense against the schema it would join?

export function checkDefinitions(schema, changes) {
  const problems = [];
  const bad = (entity, message, extra = {}) => problems.push({ code: 'SCHEMA_INVALID', entity, message, ...extra });

  const needType = (entity, type) => {
    if (schema.types.has(type)) return true;
    bad(entity, `Type "${type}" does not exist.`, {
      didYouMean: didYouMean(type, schema.types.keys()),
      repair: `Define the type first, in this same change: types: { ${type}: { description: "…" } }.`,
    });
    return false;
  };
  const needAttr = (entity, attr, onType) => {
    if (schema.attrs.has(attr) && (!onType || typeOf(attr) === onType)) return true;
    const candidates = onType ? schema.attrsOf(onType) : [...schema.attrs.keys()];
    bad(entity, `Attribute "${attr}" does not exist${onType ? ` on ${onType}` : ''}.`, {
      didYouMean: didYouMean(attr, candidates),
      repair: `Use an existing attribute (${candidates.join(', ') || 'none yet'}) or define "${attr}" in this same change.`,
    });
    return false;
  };
  const needExpr = (entity, expr, onType) => {
    for (const attr of attributesIn(expr)) needAttr(entity, attr, onType);
  };

  for (const [name, def] of Object.entries(changes.types ?? {})) {
    if (!def) continue;
    if (!def.description) bad(PREFIX.types + name, 'A type needs a description: it is what a model reads to understand the data.', { repair: 'Add description: "…".' });
  }

  for (const [name, def] of Object.entries(changes.attrs ?? {})) {
    if (!def) continue;
    const entity = PREFIX.attrs + name;
    if (!name.includes('.')) { bad(entity, 'Attribute names look like "Type.name".', { repair: `Rename to "<Type>.${name}".` }); continue; }
    needType(entity, typeOf(name));
    if (!VALUE_TYPES.includes(def.type)) bad(entity, `Unknown value type "${def.type}".`, { repair: `Use one of: ${VALUE_TYPES.join(', ')}.` });
    if (!def.description) bad(entity, 'An attribute needs a description.', { repair: 'Add description: "…".' });
    if (def.type === 'enum' && !(Array.isArray(def.values) && def.values.length)) bad(entity, 'An enum needs a non-empty list of values.', { repair: 'Add values: ["…", "…"].' });
    if (def.type === 'ref') needType(entity, def.ref);
    if (def.lens) {
      if (!LENS_KINDS.includes(def.lens.kind)) bad(entity, `Unknown lens kind "${def.lens.kind}".`, { repair: `Use one of: ${LENS_KINDS.join(', ')}.` });
      if (needAttr(entity, def.lens.from, typeOf(name)) && def.lens.from === name) bad(entity, 'A lens cannot point at itself.');
      if (def.lens.kind === 'scale' && !(typeof def.lens.factor === 'number' && def.lens.factor !== 0)) bad(entity, 'A scale lens needs a non-zero numeric factor.');
      if (def.lens.kind === 'map') {
        const targets = Object.values(def.lens.mapping ?? {});
        if (!targets.length || new Set(targets).size !== targets.length) bad(entity, 'A map lens must be one-to-one, otherwise writes through it are ambiguous.', { repair: 'Give every source value a distinct target value.' });
      }
      if (def.required) bad(entity, 'A lens attribute is a view and cannot be required; require the attribute it reads from.');
    }
  }

  for (const [name, def] of Object.entries(changes.rules ?? {})) {
    if (!def) continue;
    const entity = PREFIX.rules + name;
    if (!def.description) bad(entity, 'A rule needs a description: it is the message a caller gets when the rule rejects a write.', { repair: 'Add description: "…".' });
    if (needType(entity, def.on)) needExpr(entity, def.rule, def.on);
  }

  for (const [name, def] of Object.entries(changes.actions ?? {})) {
    if (!def) continue;
    const entity = PREFIX.actions + name;
    if (!['create', 'update', 'delete'].includes(def.kind)) bad(entity, `Unknown action kind "${def.kind}".`, { repair: 'Use create, update or delete.' });
    if (!needType(entity, def.on)) continue;
    for (const spec of Object.values(def.params ?? {})) {
      if (spec.attr) needAttr(entity, spec.attr, def.on);
      else if (!VALUE_TYPES.includes(spec.type)) bad(entity, 'A parameter needs either attr: "Type.name" or a value type.');
    }
    for (const [attr, expr] of Object.entries(def.set ?? {})) { needAttr(entity, attr, def.on); needExpr(entity, expr, def.on); }
    if (def.when) needExpr(entity, def.when, def.on);
  }

  for (const [name, def] of Object.entries(changes.surfaces ?? {})) {
    if (!def) continue;
    const entity = PREFIX.surfaces + name;
    if (!def.description) bad(entity, 'A surface needs a description of the intent it serves.', { repair: 'Add description: "…".' });
    if (!(Array.isArray(def.grants) && def.grants.length)) bad(entity, 'A surface must say who may open it.', { repair: 'Add grants: ["user:…"].' });
    if (!needType(entity, def.from)) continue;
    for (const attr of def.fields ?? []) needAttr(entity, attr, def.from);
    for (const attr of def.editable ?? []) {
      if (!(def.fields ?? []).includes(attr)) bad(entity, `Editable field "${attr}" is not among the surface's fields.`, { repair: `Add "${attr}" to fields.` });
    }
    for (const action of def.actions ?? []) {
      const a = schema.actions.get(action);
      if (!a) bad(entity, `Action "${action}" does not exist.`, { didYouMean: didYouMean(action, schema.actions.keys()), repair: 'Define the action in this same change.' });
      else if (a.on !== def.from) bad(entity, `Action "${action}" works on ${a.on}, not on ${def.from}.`);
    }
    if (def.where) needExpr(entity, def.where, def.from);
    for (const [measure, m] of Object.entries(def.summary?.measures ?? {})) {
      if (!SUMMARY_FNS.includes(m.fn)) bad(entity, `Measure "${measure}" uses unknown function "${m.fn}".`, { repair: `Use one of: ${SUMMARY_FNS.join(', ')}.` });
      if (m.fn !== 'count') needAttr(entity, m.of, def.from);
    }
    if (def.summary?.by) needExpr(entity, def.summary.by.expr, def.from);
  }

  return problems;
}

// ---------------------------------------------------------------------------------------------
// Classification: how dangerous is this change to the facts and UIs that already exist?

const RANK = { additive: 0, tightening: 1, breaking: 2 };

function classifyOne(kind, before, after) {
  const reasons = [];
  let level = 'additive';
  const note = (l, reason) => { reasons.push(reason); if (RANK[l] > RANK[level]) level = l; };

  if (!after) {
    if (kind === 'rules') note('additive', 'rule dropped; nothing that was valid becomes invalid');
    else note('breaking', 'removal would orphan stored facts or break generated UIs that are bound to it');
    return { level, reasons };
  }

  if (kind === 'attrs') {
    if (!before) {
      if (after.lens) note('additive', `new view of ${after.lens.from} through a ${after.lens.kind} lens; no facts change`);
      else if (after.required) note('tightening', 'new required attribute; every existing entity must already have it');
      else note('additive', 'new optional attribute');
      return { level, reasons };
    }
    if (before.type !== after.type) note('breaking', `type changes from ${before.type} to ${after.type}`);
    if ((before.unit ?? null) !== (after.unit ?? null)) note('breaking', `unit changes from ${before.unit ?? 'none'} to ${after.unit ?? 'none'}, which silently changes the meaning of every stored value`);
    if (!equal(before.lens ?? null, after.lens ?? null)) note('breaking', 'the lens changes, which changes what stored values mean');
    if ((before.ref ?? null) !== (after.ref ?? null)) note('breaking', 'the referenced type changes');
    if (before.type === 'enum' && after.type === 'enum') {
      const removed = before.values.filter((v) => !after.values.includes(v));
      const added = after.values.filter((v) => !before.values.includes(v));
      if (removed.length) note('tightening', `enum values removed: ${removed.join(', ')}`);
      if (added.length) note('additive', `enum values added: ${added.join(', ')}`);
    }
    if (!before.required && after.required) note('tightening', 'becomes required');
    if (before.required && !after.required) note('additive', 'no longer required');
    const bound = (key, tighter) => {
      const x = before[key] ?? null;
      const y = after[key] ?? null;
      if (x === y) return;
      if (y !== null && (x === null || tighter(y, x))) note('tightening', `${key} tightened from ${x ?? 'none'} to ${y}`);
      else note('additive', `${key} relaxed from ${x} to ${y ?? 'none'}`);
    };
    bound('min', (y, x) => y > x);
    bound('max', (y, x) => y < x);
    bound('maxLength', (y, x) => y < x);
    if (!reasons.length) note('additive', 'documentation only');
    return { level, reasons };
  }

  if (kind === 'rules') {
    if (!before) note('tightening', 'new rule; every existing entity must already satisfy it');
    else if (!equal(before.rule, after.rule) || before.on !== after.on) note('tightening', 'rule changed; existing entities are re-checked');
    else note('additive', 'documentation only');
    return { level, reasons };
  }

  if (kind === 'surfaces') {
    const actions = [...(after.actions ?? []), ...((after.editable ?? []).length ? ['$edit'] : [])];
    note('additive', `${before ? 'changes' : 'opens'} a surface on ${after.from} for ${after.grants.join(', ')}: ` +
      `${after.fields.length} fields, actions: ${actions.join(', ') || 'none (read-only)'}`);
    return { level, reasons };
  }

  note('additive', before ? `${kind.slice(0, -1)} redefined` : `new ${kind.slice(0, -1)}`);
  return { level, reasons };
}

export function classifyChanges(before, changes) {
  const out = [];
  for (const kind of Object.keys(PREFIX)) {
    for (const [name, def] of Object.entries(changes[kind] ?? {})) {
      const prev = before[kind].get(name) ?? null;
      if (equal(prev, def ?? null)) continue;
      out.push({ entity: PREFIX[kind] + name, kind, name, ...classifyOne(kind, prev, def ?? null) });
    }
  }
  return out;
}

/** Turns a state diff on `$…` entities back into the { types, attrs, … } shape used above. */
export function changesFromDiff(diff) {
  const changes = {};
  for (const { e, after } of diff) {
    const kind = Object.keys(PREFIX).find((k) => e.startsWith(PREFIX[k]));
    if (kind) (changes[kind] ??= {})[e.slice(PREFIX[kind].length)] = after;
  }
  return changes;
}

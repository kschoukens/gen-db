// Validation is the last line of defence, and the only one that matters.
//
// A generated UI can be wrong in any way a model can be wrong. So every write, whichever path it
// took, is checked here against the schema: types, constraints, references and rules. All problems
// are collected and returned together, each with a repair hint, so the caller can fix them in one go.

import { didYouMean } from './errors.js';
import { attributesIn, evaluate } from './expr.js';
import { shortName, typeOf, view } from './schema.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Checks one value against an attribute or parameter definition. Returns a problem or null. */
export function checkValue(def, v, lookup) {
  const fail = (message, repair, extra = {}) => ({ message, repair, got: v, ...extra });
  switch (def.type) {
    case 'string':
      if (typeof v !== 'string') return fail('must be text', 'Send a string.');
      if (def.maxLength != null && v.length > def.maxLength) return fail(`is ${v.length} characters; at most ${def.maxLength} allowed`, `Shorten it to ${def.maxLength} characters.`);
      return null;
    case 'number':
      if (typeof v !== 'number' || !Number.isFinite(v)) return fail('must be a number', 'Send a JSON number, not text.');
      if (def.min != null && v < def.min) return fail(`is below the minimum of ${def.min}${def.unit ? ' ' + def.unit : ''}`, `Use a value of at least ${def.min}.`);
      if (def.max != null && v > def.max) return fail(`is above the maximum of ${def.max}${def.unit ? ' ' + def.unit : ''}`, `Use a value of at most ${def.max}.`);
      return null;
    case 'boolean':
      return typeof v === 'boolean' ? null : fail('must be true or false', 'Send a JSON boolean.');
    case 'date':
      return typeof v === 'string' && DATE.test(v) && !Number.isNaN(Date.parse(v)) ? null : fail('must be a calendar date', 'Use the form YYYY-MM-DD.');
    case 'datetime':
      return typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? null : fail('must be a timestamp', 'Use ISO 8601, for example 2026-11-23T09:30:00Z.');
    case 'enum':
      return def.values.includes(v) ? null : fail(`is not one of ${def.values.join(', ')}`, `Use one of: ${def.values.join(', ')}.`, { didYouMean: didYouMean(v, def.values) });
    case 'ref': {
      const target = typeof v === 'string' ? lookup?.(v) : null;
      return target?.get('$type') === def.ref ? null : fail(`must refer to an existing ${def.ref}`, `Use the id of an existing ${def.ref}.`);
    }
    default:
      return fail(`has unknown type ${def.type}`, 'Fix the schema definition.');
  }
}

/**
 * Validates entities against a schema.
 * `lookup(id)` returns the entity's attribute map in the candidate state (or undefined when gone).
 */
export function validateEntities(ids, lookup, schema, ctx, allEntities) {
  const problems = [];

  for (const id of ids) {
    const attrs = lookup(id);
    const add = (code, attribute, p) => problems.push({
      code, entity: id, ...(attribute ? { attribute, field: shortName(attribute) } : {}), ...p,
      message: attribute ? `${attribute} ${p.message}` : p.message,
    });

    if (!attrs || attrs.size === 0) {
      // Deleted. Nothing may still point at it.
      for (const [other, otherAttrs] of allEntities()) {
        for (const [a, v] of otherAttrs) {
          if (v === id && schema.attrs.get(a)?.type === 'ref') {
            add('REFERENCE_DANGLING', null, { message: `${id} cannot be removed: ${other} still refers to it through ${a}.`, repair: `Remove or re-point ${other}.${shortName(a)} first.` });
          }
        }
      }
      continue;
    }

    const type = attrs.get('$type');
    if (!schema.types.has(type)) {
      add('UNKNOWN_TYPE', null, {
        message: type ? `Type "${type}" does not exist.` : `Entity ${id} has no type.`,
        didYouMean: type ? didYouMean(type, schema.types.keys()) : [],
        repair: `Use an existing type (${[...schema.types.keys()].join(', ')}) or propose a new one with evolve().`,
      });
      continue;
    }

    const before = problems.length;
    for (const [a, v] of attrs) {
      if (a === '$type') continue;
      const def = schema.attrs.get(a);
      if (!def || typeOf(a) !== type) {
        const known = schema.attrsOf(type);
        add('UNKNOWN_ATTRIBUTE', a, {
          message: `is not an attribute of ${type}.`,
          didYouMean: didYouMean(a, known),
          repair: `Use one of: ${known.join(', ')}. If the data genuinely needs a new attribute, propose it with evolve() on a branch.`,
        });
        continue;
      }
      const problem = checkValue(def, v, lookup);
      if (problem) add('INVALID_VALUE', a, problem);
    }

    for (const a of schema.attrsOf(type)) {
      const def = schema.attrs.get(a);
      if (def.required && !attrs.has(a)) add('REQUIRED_MISSING', a, { message: 'is required.', repair: `Provide ${a}${def.example !== undefined ? `, for example ${JSON.stringify(def.example)}` : ''}.` });
    }

    // Rules are only meaningful over well-formed values; judging garbage would produce misleading hints.
    if (problems.length > before) continue;
    const entity = view(id, attrs, schema);
    for (const [rule, def] of schema.rulesOf(type)) {
      if (evaluate(def.rule, { ...ctx, get: (a) => entity.get(a) }) === false) {
        const involved = [...attributesIn(def.rule)];
        add('RULE_VIOLATED', null, { rule, attributes: involved, message: def.description, repair: def.repair ?? `Adjust ${involved.join(' or ')} so that the rule holds.` });
      }
    }
  }

  return problems;
}

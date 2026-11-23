# What you are given: a GenDB surface

You are writing a user interface for one *surface* of a database called GenDB. A surface is a
granted slice of the database. You never see the data. You get a **contract** (a JSON file) that
says what the data means and what can be done with it, and a tiny runtime object, `window.surface`,
through which your page reads live rows and performs actions at run time in the user's browser.

## The runtime: `window.surface`

It already exists, synchronously, before any of your scripts run.

```js
surface.contract            // the contract object (same content as the JSON file you were given)

surface.subscribe(callback) // callback(result) is called once soon after subscribing and again
                            // every time the data changes (also by other people). Returns nothing.

surface.act(action, { id, params })
                            // Promise. Never rejects for a refused action; it resolves to
                            //   { ok: true, id, tx }            on success, or
                            //   { ok: false, error }            when the database refuses.
                            // `action` is an action name from contract.actions.
                            // `id` is a row id (only for actions with scope "row").
                            // `params` is an object keyed by the action's parameter names.
```

### `result` (what `subscribe` hands you)

```js
{
  total: 11,                       // rows in the surface
  rows: [
    {
      id: "…",                     // opaque row id
      values: { <field name>: <value or null>, … },   // keyed by contract.fields[].name
      actions: {                   // every row-scoped action, and whether it is possible right now
        "<action name>": { enabled: true } | { enabled: false, reason: "…" }
      }
    }
  ],
  summary: {                       // only when contract.summary exists
    values: { <measure name>: <number or null> },      // totals over ALL rows
    groups: [ { key: "…", values: { <measure name>: <number or null> } } ]   // when contract.summary.by exists
  }
}
```

Value types follow `contract.fields[].type`: `number` is a JSON number, `boolean` a JSON boolean,
`date` a string `YYYY-MM-DD`, `enum` one of `values`, `string` text. A missing value is `null`.

### Sending values

- Send typed JSON: numbers as numbers, booleans as booleans, dates as `YYYY-MM-DD`.
- Leave optional parameters out (or send `null`) when the user gave nothing.
- The action named `$edit` changes editable fields of one row: `surface.act('$edit', { id, params: { <field name>: <new value> } })`.
  Sending `null` clears a value.

### `error` (when the database refuses)

```js
{
  code: "VALIDATION_FAILED",       // stable machine code
  message: "…",                    // plain language
  repair: "…",                     // how to fix the request (may be absent when violations are present)
  violations: [                    // present for VALIDATION_FAILED: every problem at once
    { code: "INVALID_VALUE" | "REQUIRED_MISSING" | "RULE_VIOLATED" | …,
      field: "<field name>",       // absent for rule violations that span fields
      attributes: ["Type.attr"],   // for RULE_VIOLATED: the attributes the rule looks at
      message: "…", repair: "…" }
  ],
  didYouMean: ["…"]                // sometimes, for misspelled names
}
```

The database enforces everything in the contract regardless of what your page does. Your job is to
make that pleasant: do not offer what is not possible, show the reason the database gives for a
disabled action, and when a request is refused show the message next to the field it concerns.

## Where your page runs

Inside a sandboxed iframe with a strict content security policy:

- **No network.** No fetch, no external scripts, styles, fonts or images. Everything inline in one file.
- **No storage.** `localStorage`, `sessionStorage`, cookies and IndexedDB are unavailable and may throw.
- Forms work, but you must handle `submit` yourself and call `preventDefault()`.
- `alert`, `confirm` and `prompt` are unavailable. Build confirmation into the page.

## What to deliver

One self-contained HTML document (doctype, inline `<style>`, inline `<script>`), written to the path
you were given. Requirements:

- Interface text in **Dutch**. The contract's labels and descriptions are already Dutch; use them.
- Works at phone width (360px) and on a desktop; no horizontal page scroll.
- Light and dark mode via `prefers-color-scheme`.
- Accessible: every input has a visible label whose text is the field's `label` from the contract;
  every button has a text name; a button that performs a contract action uses that action's `label`
  as its accessible name (for `$edit`, saving on change needs no button).
- Keeps working when new data arrives while the user is typing: do not wipe a form or an input the
  user is in the middle of filling in.
- Numbers and dates formatted for `nl-BE`; show units from the contract.

Do not invent fields, actions or parameters that are not in the contract. If the intent seems to
need something the contract does not offer, leave it out and say so in your final report.

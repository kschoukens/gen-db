// A stand-in for the model.
//
// In a real deployment a language model writes the UI. Here a plain function does, on purpose: it
// receives exactly what a model would receive, the contract from surface.describe(), and nothing
// else. Whatever it can render, it can render because the database told it so: labels, units,
// widgets, limits, which buttons exist and why one is greyed out.
//
// Two steps, mirroring how a generated UI should work:
//   generateUI(contract)        layout and controls, decided from the contract alone. No data seen.
//   bindData(contract, result)  the rows from surface.read(), bound at runtime in the user's browser.
//
// Runs unchanged in Node and in the browser.

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const number = (v, locale) => new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(v);

function display(field, v, locale) {
  if (v === null || v === undefined) return '<span class="g-empty">–</span>';
  if (typeof v === 'object') return esc(v.label);
  if (field.type === 'number') return `${esc(number(v, locale))}${field.unit ? `<span class="g-unit"> ${esc(field.unit)}</span>` : ''}`;
  if (field.type === 'boolean') return v ? 'ja' : '<span class="g-empty">–</span>';
  if (field.type === 'date') return esc(new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(v)));
  return esc(v);
}

/** The widget follows from the meaning of the field, not from a design decision. */
function control(field, { value = null, attrs = '', required = field.required } = {}) {
  const common = `name="${esc(field.name)}" aria-label="${esc(field.label)}" title="${esc(field.description ?? field.label)}" ${attrs}`;
  const req = required ? 'required' : '';
  if (field.type === 'enum') {
    const options = field.values.map((o) => `<option${o === value ? ' selected' : ''}>${esc(o)}</option>`).join('');
    return `<select ${common} ${req}>${required ? '' : `<option value=""${value === null ? ' selected' : ''}>–</option>`}${options}</select>`;
  }
  if (field.type === 'boolean') return `<input type="checkbox" ${common}${value ? ' checked' : ''}>`;
  if (field.type === 'number') {
    const limits = `${field.min != null ? `min="${field.min}"` : ''} ${field.max != null ? `max="${field.max}"` : ''}`;
    return `<span class="g-num"><input type="number" step="any" ${limits} ${common} ${req} value="${esc(value ?? '')}" placeholder="${esc(field.example ?? '')}">${field.unit ? `<span class="g-unit">${esc(field.unit)}</span>` : ''}</span>`;
  }
  const type = field.type === 'date' ? 'date' : field.type === 'datetime' ? 'datetime-local' : 'text';
  return `<input type="${type}" ${field.maxLength ? `maxlength="${field.maxLength}"` : ''} ${common} ${req} value="${esc(value ?? '')}">`;
}

/** Turns what a form control holds into the typed value the contract asks for. Empty means "not given". */
export function coerce(field, raw) {
  if (field.type === 'boolean') return Boolean(raw);
  if (raw === '' || raw === null || raw === undefined) return null;
  if (field.type === 'number') return Number(raw);
  return raw;
}

export function generateUI(contract) {
  const creates = contract.actions.filter((a) => a.scope === 'collection');
  const forms = creates.map((a) => `
    <form class="g-form" data-action="${esc(a.name)}">
      <h3>${esc(a.label)}</h3>
      <div class="g-fields">
        ${a.params.map((p) => `<label><span>${esc(p.label)}${p.required ? '' : ' <em>optioneel</em>'}</span>${control(p)}</label>`).join('')}
      </div>
      <button type="submit" class="g-primary">${esc(a.label)}</button>
    </form>`).join('');

  const rules = contract.rules.length ? `
    <footer class="g-rules">
      <h3>Wat de database afdwingt, wat deze UI ook doet</h3>
      <ul>${contract.rules.map((r) => `<li>${esc(r.description)}</li>`).join('')}</ul>
    </footer>` : '';

  return `
    <section class="g" data-surface="${esc(contract.name)}">
      <header class="g-head"><h2>${esc(contract.label)}</h2><p>${esc(contract.intent)}</p></header>
      <div data-slot="summary"></div>
      ${forms}
      <p class="g-error" data-slot="error" role="alert" hidden></p>
      <div data-slot="rows"></div>
      ${rules}
    </section>`;
}

function summaryHTML(contract, summary, locale) {
  if (!contract.summary || !summary) return '';
  const { measures, by } = contract.summary;
  const fmt = (m, v) => (v === null ? '–' : `${number(v, locale)}${m.unit ? ` ${m.unit}` : ''}`);

  const tiles = measures.map((m) => `
    <div class="g-tile"><div class="g-tile-label">${esc(m.label)}</div><div class="g-tile-value">${esc(fmt(m, summary.values[m.name]))}</div></div>`).join('');

  let chart = '';
  if (by && summary.groups?.length) {
    const lead = measures[0];
    const max = Math.max(0, ...summary.groups.map((g) => g.values[lead.name] ?? 0));
    const bars = summary.groups.map((g) => {
      const v = g.values[lead.name];
      const tip = measures.map((m) => `${m.label}: ${fmt(m, g.values[m.name])}`).join(' · ');
      return `
        <div class="g-bar-row" title="${esc(`${g.key} — ${tip}`)}">
          <span class="g-bar-key">${esc(g.key)}</span>
          <span class="g-bar-track"><span class="g-bar" style="width:${max && v ? Math.max(1, (v / max) * 100) : 0}%"></span></span>
          <span class="g-bar-value">${esc(fmt(lead, v))}</span>
        </div>`;
    }).join('');
    chart = `<figure class="g-chart"><figcaption>${esc(lead.label)} · ${esc(by.label.toLowerCase())}</figcaption>${bars}</figure>`;
  }
  return `<div class="g-summary"><div class="g-tiles">${tiles}</div>${chart}</div>`;
}

function rowsHTML(contract, result, locale) {
  const rowActions = contract.actions.filter((a) => a.scope === 'row' && a.name !== '$edit');
  const head = contract.fields.map((f) => `<th class="g-${f.type}" title="${esc(f.description ?? '')}">${esc(f.label)}</th>`).join('');

  const body = result.rows.map((row) => {
    const cells = contract.fields.map((f) => {
      const v = row.values[f.name];
      const editable = f.editable && row.actions.$edit?.enabled;
      return `<td class="g-${f.type}">${editable ? control(f, { value: v, attrs: `data-edit data-id="${esc(row.id)}"`, required: false }) : display(f, v, locale)}</td>`;
    }).join('');
    const buttons = rowActions.map((a) => {
      const state = row.actions[a.name] ?? { enabled: false, reason: 'niet beschikbaar' };
      return state.enabled
        ? `<button type="button" data-action="${esc(a.name)}" data-id="${esc(row.id)}"${a.destructive ? ' class="g-danger"' : ''} title="${esc(a.description ?? '')}">${esc(a.label)}</button>`
        : `<button type="button" disabled title="${esc(state.reason)}">${esc(a.label)}</button><small class="g-reason">${esc(state.reason)}</small>`;
    }).join('');
    return `<tr>${cells}${rowActions.length ? `<td class="g-actions">${buttons}</td>` : ''}</tr>`;
  }).join('');

  const note = result.truncated ? `<p class="g-note">${result.truncated.shown} van ${result.total} rijen getoond; de totalen tellen alles mee.</p>` : '';
  const empty = result.rows.length ? '' : '<p class="g-note">Nog geen rijen.</p>';
  return `<div class="g-table"><table><thead><tr>${head}${rowActions.length ? '<th></th>' : ''}</tr></thead><tbody>${body}</tbody></table></div>${empty}${note}`;
}

export function bindData(contract, result, { locale = 'nl-BE' } = {}) {
  return { summary: summaryHTML(contract, result.summary, locale), rows: rowsHTML(contract, result, locale) };
}

/** A complete, static page: the frame with data already bound. Used by the command-line story. */
export function renderStatic(contract, result, options) {
  const slots = bindData(contract, result, options);
  const html = generateUI(contract)
    .replace('<div data-slot="summary"></div>', `<div data-slot="summary">${slots.summary}</div>`)
    .replace('<div data-slot="rows"></div>', `<div data-slot="rows">${slots.rows}</div>`);
  return `<!doctype html><html lang="nl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(contract.label)}</title><style>${GENUI_CSS} body{margin:0;padding:24px 16px;background:var(--g-surface)} .g{max-width:860px;margin:0 auto}</style>${html}</html>`;
}

const DARK = `--g-surface:#1a1a19;--g-panel:#222221;--g-text:#f0efec;--g-text-2:#c3c2b7;--g-line:#2c2c2a;--g-accent:#3987e5;--g-accent-ink:#8ebcf5;`;

export const GENUI_CSS = `
:root{color-scheme:light;--g-surface:#fcfcfb;--g-panel:#ffffff;--g-text:#0b0b0b;--g-text-2:#52514e;--g-muted:#898781;--g-line:#e1e0d9;--g-accent:#2a78d6;--g-accent-ink:#1f5fb0;--g-critical:#d03b3b;}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){color-scheme:dark;${DARK}}}
:root[data-theme="dark"]{color-scheme:dark;${DARK}}
.g{font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--g-text)}
.g h2{font-size:20px;margin:0 0 2px}.g h3{font-size:13px;margin:0 0 10px;font-weight:600}
.g-head p{margin:0 0 16px;color:var(--g-text-2)}
.g-summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px;margin-bottom:16px;align-items:start}
.g-tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:8px}
.g-tile{background:var(--g-panel);border:1px solid var(--g-line);border-radius:8px;padding:10px 12px}
.g-tile-label{font-size:12px;color:var(--g-text-2)}.g-tile-value{font-size:20px;font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap}
.g-chart{margin:0;background:var(--g-panel);border:1px solid var(--g-line);border-radius:8px;padding:10px 12px}
.g-chart figcaption{font-size:12px;color:var(--g-text-2);margin-bottom:8px}
.g-bar-row{display:grid;grid-template-columns:minmax(64px,max-content) 1fr max-content;gap:8px;align-items:center;padding:3px 0;font-size:12px}
.g-bar-key{color:var(--g-text-2)}.g-bar-track{display:block}
.g-bar{display:block;height:12px;background:var(--g-accent);border-radius:0 4px 4px 0}
.g-bar-row:hover .g-bar{filter:brightness(1.12)}
.g-bar-value{font-variant-numeric:tabular-nums}
.g-form{background:var(--g-panel);border:1px solid var(--g-line);border-radius:8px;padding:12px;margin-bottom:16px}
.g-fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin-bottom:12px}
.g-fields label{display:grid;gap:4px;font-size:12px;color:var(--g-text-2);align-content:start}.g-fields em{color:var(--g-muted);font-style:normal}
.g input,.g select,.g button{font:inherit;color:inherit}
.g input:not([type=checkbox]),.g select{width:100%;box-sizing:border-box;padding:5px 7px;border:1px solid var(--g-line);border-radius:6px;background:var(--g-surface);min-width:0}
.g input[type=checkbox]{width:16px;height:16px;justify-self:start;accent-color:var(--g-accent)}
.g-num{display:flex;align-items:center;gap:5px}.g-unit{color:var(--g-muted);font-size:12px}
.g button{padding:5px 10px;border:1px solid var(--g-line);border-radius:6px;background:var(--g-panel);cursor:pointer}
.g button:hover:not(:disabled){border-color:var(--g-muted)}
.g button:disabled{color:var(--g-muted);cursor:not-allowed}
.g button.g-primary{background:var(--g-accent);border-color:var(--g-accent);color:#fff;font-weight:600}
.g button.g-danger{color:var(--g-critical)}
.g-error{border:1px solid var(--g-critical);border-left-width:4px;border-radius:6px;padding:8px 12px;margin:0 0 16px;background:var(--g-panel)}
.g-error strong{display:block}.g-error span{color:var(--g-text-2)}
.g-table{overflow-x:auto;border:1px solid var(--g-line);border-radius:8px;background:var(--g-panel)}
.g table{border-collapse:collapse;width:100%}
.g th,.g td{padding:7px 10px;text-align:left;border-bottom:1px solid var(--g-line);white-space:nowrap;vertical-align:middle}
.g tr:last-child td{border-bottom:0}
.g th{font-size:12px;font-weight:600;color:var(--g-text-2)}
.g th.g-number,.g td.g-number{text-align:right;font-variant-numeric:tabular-nums}
.g td.g-number .g-num{justify-content:flex-end}.g td.g-number input{width:84px;text-align:right}
.g td.g-string{white-space:normal;min-width:180px}
.g-empty{color:var(--g-muted)}
.g-actions{text-align:right}.g-reason{display:block;color:var(--g-muted);font-size:11px;white-space:normal;max-width:150px;margin-left:auto}
.g-note{color:var(--g-text-2);font-size:12px}
.g-rules{margin-top:16px;color:var(--g-text-2);font-size:12px}.g-rules h3{font-size:12px;margin-bottom:4px}.g-rules ul{margin:0;padding-left:18px}
`;

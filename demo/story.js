// The whole idea as one run of the terminal:  node demo/story.js
//
// Also writes demo/out/*.html: the UIs generated from each contract, as static pages.

import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { estimateTokens } from '../src/index.js';
import { renderStatic } from '../src/genui.js';
import {
  createDatabase, agentKneePain, agentMetres, hallucinatedUI, attempt,
  KIM, SAM, COACH, KNEE_BRANCH, KNEE_INTENT, METRES_BRANCH,
} from './scenario.js';

const out = fileURLToPath(new URL('./out/', import.meta.url));
await mkdir(out, { recursive: true });

const step = (n, title) => console.log(`\n\x1b[1m${n}. ${title}\x1b[0m`);
const say = (...lines) => lines.forEach((l) => console.log(`   ${l}`));
const save = async (surface, file) => {
  await writeFile(out + file, renderStatic(surface.describe(), surface.read()));
  say(`→ gegenereerde UI: demo/out/${file}`);
};

const db = createDatabase();
const mine = db.open('mijn-runs', { actor: KIM });

step(1, 'Het contract: wat een model krijgt om een UI te bouwen');
const contract = mine.describe();
say(`surface "${contract.name}": ${contract.intent}`,
  `velden:  ${contract.fields.map((f) => `${f.label}${f.unit ? ` (${f.unit})` : ''}${f.editable ? ' ✎' : ''}`).join(', ')}`,
  `acties:  ${contract.actions.map((a) => `${a.name}${a.availableWhen ? ` [alleen als ${a.availableWhen}]` : ''}`).join(', ')}`,
  `regels:  ${contract.rules.map((r) => r.description).join(' · ')}`,
  `omvang:  ${estimateTokens(contract)} tokens, en geen enkele rij gegevens`);
await save(mine, 'mijn-runs.html');

step(2, 'Lezen: rijen, totalen en per rij wat er nu mee kan');
const read = mine.read();
say(`${read.total} runs van Kim, ${read.summary.values.total_km} km. Sam ziet via dezelfde surface ${db.open('mijn-runs', { actor: SAM }).read().total} runs.`);
for (const row of read.rows.slice(0, 2)) {
  const remove = row.actions['Run.remove'];
  say(`${row.values.date}  ${String(row.values.distance_km).padStart(5)} km  verwijderen: ${remove.enabled ? 'kan' : `kan niet (${remove.reason})`}`);
}
const small = mine.read({ budget: { tokens: 400 } });
say(`Met een budget van 400 tokens: ${small.truncated.shown} rijen getoond, ${small.truncated.omitted} weggelaten, totalen nog steeds over alles.`);

step(3, 'Een gehallucineerde UI: alles fout, niets beschadigd');
const before = db.store.seq;
for (const { label, result } of hallucinatedUI(db)) {
  const e = result.error;
  say(`✗ ${label.padEnd(42)} ${e.code}`, `    herstel: ${e.violations?.[0]?.repair ?? e.repair}`);
}
say(`Transacties geschreven: ${db.store.seq - before}`);

step(4, `Schema op intentie: "${KNEE_INTENT}"`);
const review = agentKneePain(db);
say(`De agent werkte in de wereld "${KNEE_BRANCH}". In main is niets veranderd: ${db.schema().attrs.has('Run.knee_pain') ? 'FOUT' : 'Run.knee_pain bestaat daar niet'}.`);
for (const c of review.schema) say(`schema  [${c.level}] ${c.entity}: ${c.reasons.join('; ')}`);
say(`data    ${review.data.length} waarden, elk met herkomst: ${review.data[0].actor}, zekerheid ${review.data[0].confidence}`);
say(`De agent mag zijn eigen werk niet goedkeuren: ${attempt(() => db.merge(KNEE_BRANCH, { approvedBy: COACH })).error.code}`);
db.merge(KNEE_BRANCH, { approvedBy: KIM });
const knee = db.open('knie-en-afstand', { actor: KIM });
say('Kim keurt goed. De nieuwe surface bestaat nu in main:',
  ...knee.read().summary.groups.map((g) => `  ${g.key.padEnd(18)} gemiddelde pijn ${g.values.avg_pain.toFixed(2)}`));
await save(knee, 'knie-en-afstand.html');

step(5, "Schema's groeien alleen: meters naast kilometers");
const metres = agentMetres(db);
say(`Poging 1, eenheid wijzigen: ${metres.refused.error.code}`, `  ${metres.refused.error.message}`, `  herstel: ${metres.refused.error.repair}`);
say(`Poging 2, een lens: ${metres.review.schema.map((c) => `[${c.level}] ${c.entity}`).join(', ')}; ${metres.review.data.length} feiten gewijzigd`);
db.merge(METRES_BRANCH, { approvedBy: KIM });
const inMetres = db.open('runs-in-meters', { actor: KIM });
const half = inMetres.read().rows[0];
inMetres.act('$edit', { id: half.id, params: { distance_m: 21097.5 } }, { intent: 'officiële afstand invullen' });
say(`Geschreven via de nieuwe UI: 21097,5 m. De oude UI leest: ${mine.read().rows[0].values.distance_km} km. Eén feit, twee schema's.`);
await save(inMetres, 'runs-in-meters.html');

step(6, 'Herkomst en ongedaan maken op intentie');
const id = knee.read().rows[0].id;
knee.act('$edit', { id, params: { knee_pain: 8 } }, { intent: 'pijn corrigeren' });
for (const w of db.why(id, 'Run.knee_pain')) {
  say(`tx ${w.tx}: ${w.previous ?? '–'} → ${w.value}  door ${w.actor}, voor "${w.intent}"${w.confidence ? `, zekerheid ${w.confidence}` : ''}${w.mergedFrom ? `, goedgekeurd door ${w.approvedBy}` : ''}`);
}
const undone = db.undo({ intent: KNEE_INTENT }, { actor: KIM });
say(`Undo van alles voor "${KNEE_INTENT}": ${undone.restored} waarden teruggezet, ${undone.skipped.length} overgeslagen (Kims eigen correctie blijft staan).`);

step(7, 'Tijdreizen');
say(`Runs van Kim nu: ${mine.read().total}. Bij transactie 5: ${mine.read({ asOf: 5 }).total}.`);
console.log();

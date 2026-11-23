// One scenario, shared by the tests, the command-line story and the live demo.
//
// Kim keeps a running log. There is no running-log app: there is a database that knows what a run
// is, and whatever UI a model generates for the question Kim has today.
//
// The schema descriptions are in Dutch on purpose. They are not comments; they are the text a
// generator turns into labels, hints and error messages.

import { Database, GenDBError } from '../src/index.js';

export const KIM = 'user:kim';
export const SAM = 'user:sam';
export const COACH = 'agent:coach';
export const MODEL = 'demo-agent (gescript)';

const MINE = ['=', ['get', 'Run.owner'], ['actor']];
const PACE = ['/', ['get', 'Run.minutes'], ['get', 'Run.distance_km']];

export const SCHEMA = {
  types: {
    Run: { description: 'Eén hardloopsessie van één persoon', label: 'Run.date' },
  },
  attrs: {
    'Run.owner': { type: 'string', label: 'Loper', description: 'Wie de run liep (actor-id)', required: true, pii: true },
    'Run.date': { type: 'date', label: 'Datum', description: 'Dag waarop gelopen is', required: true, example: '2026-11-20' },
    'Run.distance_km': { type: 'number', label: 'Afstand', unit: 'km', description: 'Gelopen afstand', required: true, min: 0.1, max: 100, example: 8.4 },
    'Run.minutes': { type: 'number', label: 'Duur', unit: 'min', description: 'Totale duur van de run', required: true, min: 1, max: 1440, example: 46 },
    'Run.feeling': { type: 'enum', label: 'Gevoel', values: ['zwaar', 'ok', 'sterk'], description: 'Hoe de run aanvoelde' },
    'Run.race': { type: 'boolean', label: 'Wedstrijd', description: 'Of dit een officiële wedstrijd was' },
    'Run.note': { type: 'string', label: 'Notitie', description: 'Vrije notitie bij de run', maxLength: 140 },
  },
  rules: {
    'Run.plausibel_tempo': {
      on: 'Run',
      description: 'Het tempo moet tussen 2 en 20 minuten per kilometer liggen',
      rule: ['and', ['>=', PACE, 2], ['<=', PACE, 20]],
    },
    'Run.niet_in_de_toekomst': {
      on: 'Run',
      description: 'Een run kan niet in de toekomst liggen',
      rule: ['<=', ['get', 'Run.date'], ['today']],
    },
  },
  actions: {
    'Run.log': {
      on: 'Run', kind: 'create', label: 'Run loggen', description: 'Leg een nieuwe run vast',
      params: {
        date: { attr: 'Run.date' },
        distance_km: { attr: 'Run.distance_km' },
        minutes: { attr: 'Run.minutes' },
        feeling: { attr: 'Run.feeling', optional: true },
        race: { attr: 'Run.race', optional: true },
        note: { attr: 'Run.note', optional: true },
      },
      // The owner is never a parameter. A UI cannot log a run for someone else, however it is written.
      set: { 'Run.owner': ['actor'] },
    },
    'Run.remove': {
      on: 'Run', kind: 'delete', label: 'Verwijderen', description: 'Verwijder deze run uit het logboek',
      when: ['!=', ['get', 'Run.race'], true],
      otherwise: 'wedstrijdresultaten zijn definitief',
    },
  },
  surfaces: {
    'mijn-runs': {
      label: 'Mijn runs',
      description: 'Mijn hardlooplogboek: runs bekijken, loggen en bijwerken',
      from: 'Run',
      where: MINE,
      fields: ['Run.date', 'Run.distance_km', 'Run.minutes', 'Run.feeling', 'Run.race', 'Run.note'],
      editable: ['Run.feeling', 'Run.note'],
      actions: ['Run.log', 'Run.remove'],
      orderBy: [['Run.date', 'desc']],
      summary: {
        measures: {
          total_km: { fn: 'sum', of: 'Run.distance_km', label: 'Totale afstand' },
          runs: { fn: 'count', label: 'Runs' },
          longest_km: { fn: 'max', of: 'Run.distance_km', label: 'Langste run' },
        },
        by: { expr: ['month', ['get', 'Run.date']], label: 'Per maand' },
      },
      grants: ['user:*'],
    },
    'alle-runs': {
      label: 'Alle runs (trainer)',
      description: 'Overzicht van de runs van alle lopers, alleen-lezen',
      from: 'Run',
      fields: ['Run.owner', 'Run.date', 'Run.distance_km', 'Run.minutes'],
      orderBy: [['Run.date', 'desc']],
      grants: [KIM],
    },
  },
};

const RUNS = [
  [KIM, '2026-09-06', 5.2, 31, 'ok', false, 'Eerste run na de zomer'],
  [KIM, '2026-09-13', 6.0, 35, 'ok', false, null],
  [KIM, '2026-09-20', 8.1, 47, 'sterk', false, null],
  [KIM, '2026-09-27', 10.0, 52, 'sterk', true, 'Dwars door Hasselt'],
  [KIM, '2026-10-04', 7.4, 44, 'ok', false, 'Knie voelde wat stijf na afloop'],
  [KIM, '2026-10-11', 12.3, 75, 'zwaar', false, 'Knie deed pijn vanaf km 9'],
  [KIM, '2026-10-18', 6.5, 39, 'ok', false, null],
  [KIM, '2026-10-25', 14.0, 86, 'zwaar', false, 'Lange duurloop, knie opnieuw gevoelig'],
  [KIM, '2026-11-01', 5.0, 30, 'ok', false, 'Rustig herstel'],
  [KIM, '2026-11-08', 8.4, 46, 'sterk', false, null],
  [KIM, '2026-11-15', 21.1, 118, 'zwaar', true, 'Halve marathon! Knie hield het net'],
  [SAM, '2026-11-02', 4.0, 27, 'ok', false, null],
  [SAM, '2026-11-09', 4.5, 29, 'sterk', false, null],
  [SAM, '2026-11-16', 5.0, 33, 'ok', false, 'Nieuwe schoenen'],
];

export function createDatabase(options = {}) {
  const db = new Database({ owners: [KIM], ...options });
  db.evolve(SCHEMA, { actor: KIM, intent: 'hardlooplogboek opzetten' });
  for (const [owner, date, distance_km, minutes, feeling, race, note] of RUNS) {
    db.open('mijn-runs', { actor: owner }).act('Run.log', { params: { date, distance_km, minutes, feeling, race, note } }, { intent: 'run loggen' });
  }
  return db;
}

/** Runs `fn`; returns either its result or the structured rejection the database gave. */
export function attempt(fn) {
  try {
    return fn();
  } catch (err) {
    if (err instanceof GenDBError) return err.toJSON();
    throw err;
  }
}

// ---------------------------------------------------------------------------------------------
// Agent step 1. Kim: "Houd ook mijn kniepijn bij, ik wil zien of die samenhangt met afstand."
// Nobody planned for knee pain. The agent grows the schema, opens a surface for the new question
// and makes an educated guess for past runs, all on a branch that Kim reviews as one diff.

export const KNEE_INTENT = 'kniepijn bijhouden';
export const KNEE_BRANCH = 'agent/kniepijn';

export function agentKneePain(db) {
  const meta = { branch: KNEE_BRANCH, actor: COACH, intent: KNEE_INTENT, model: MODEL };
  db.fork(KNEE_BRANCH, { actor: COACH, intent: KNEE_INTENT });

  db.evolve({
    attrs: {
      'Run.knee_pain': { type: 'number', label: 'Kniepijn', description: 'Kniepijn na de run, van 0 (geen) tot 10 (ernstig)', min: 0, max: 10, example: 3 },
    },
    surfaces: {
      'knie-en-afstand': {
        label: 'Knie en afstand',
        description: 'Zien of kniepijn samenhangt met de afstand, en de pijn per run bijwerken',
        from: 'Run',
        where: MINE,
        fields: ['Run.date', 'Run.distance_km', 'Run.knee_pain', 'Run.note'],
        editable: ['Run.knee_pain'],
        orderBy: [['Run.distance_km', 'desc']],
        summary: {
          measures: {
            avg_pain: { fn: 'avg', of: 'Run.knee_pain', label: 'Gemiddelde pijn' },
            worst: { fn: 'max', of: 'Run.knee_pain', label: 'Ergste pijn' },
            scored: { fn: 'count', label: 'Runs' },
          },
          by: { expr: ['if', ['>=', ['get', 'Run.distance_km'], 10], '10 km en meer', 'korter dan 10 km'], label: 'Naar afstand' },
        },
        grants: [KIM],
      },
    },
  }, meta);

  // A guess from the notes, written as a guess: low confidence, attributable, and undoable as a whole.
  const guesses = db.query({ from: 'Run', where: ['=', ['get', 'Run.owner'], KIM] }, { branch: KNEE_BRANCH })
    .map((run) => {
      const note = (run['Run.note'] ?? '').toLowerCase();
      const pain = !note.includes('knie') ? 0 : note.includes('pijn') ? 7 : note.includes('gevoelig') ? 5 : 3;
      return { e: run.id, a: 'Run.knee_pain', v: pain };
    });
  db.transact(guesses, { ...meta, confidence: 0.4 });

  return db.review(KNEE_BRANCH);
}

// ---------------------------------------------------------------------------------------------
// Agent step 2. A second generated UI wants distances in metres. The naive change is refused;
// the agent reads the repair hint and does it properly, with a lens.

export const METRES_INTENT = 'afstanden in meters';
export const METRES_BRANCH = 'agent/meters';

export function agentMetres(db) {
  const meta = { branch: METRES_BRANCH, actor: COACH, intent: METRES_INTENT, model: MODEL };
  db.fork(METRES_BRANCH, { actor: COACH, intent: METRES_INTENT });

  const refused = attempt(() => db.evolve({
    attrs: { 'Run.distance_km': { ...SCHEMA.attrs['Run.distance_km'], unit: 'm', max: 100000 } },
  }, meta));

  db.evolve({
    attrs: {
      'Run.distance_m': { type: 'number', label: 'Afstand', unit: 'm', description: 'Gelopen afstand in meters', min: 100, max: 100000, lens: { kind: 'scale', from: 'Run.distance_km', factor: 1000 } },
    },
    surfaces: {
      'runs-in-meters': {
        label: 'Runs in meters',
        description: 'Dezelfde runs, voor een baantraining-weergave die in meters rekent',
        from: 'Run',
        where: MINE,
        fields: ['Run.date', 'Run.distance_m', 'Run.minutes'],
        editable: ['Run.distance_m'],
        orderBy: [['Run.date', 'desc']],
        summary: { measures: { total_m: { fn: 'sum', of: 'Run.distance_m', label: 'Totale afstand' } } },
        grants: ['user:*'],
      },
    },
  }, meta);

  return { refused, review: db.review(METRES_BRANCH) };
}

// ---------------------------------------------------------------------------------------------
// A generated UI that gets everything wrong. Each attempt is something a model plausibly produces:
// a misspelled field, an impossible value, a button that should not exist, a guessed id.

export function hallucinatedUI(db) {
  const mine = db.open('mijn-runs', { actor: KIM });
  const sams = db.open('mijn-runs', { actor: SAM }).read().rows[0].id;
  const race = mine.read().rows.find((r) => r.values.race).id;
  const first = mine.read().rows[0].id;
  const today = db.store.now().slice(0, 10);

  const attempts = [
    ['Verkeerd gespelde parameter', () => mine.act('Run.log', { params: { date: today, distanse_km: 5, minutes: 30 } })],
    ['Onmogelijke afstand (500 km)', () => mine.act('Run.log', { params: { date: today, distance_km: 500, minutes: 3000 } })],
    ['Onmogelijk tempo (10 km in 5 min)', () => mine.act('Run.log', { params: { date: today, distance_km: 10, minutes: 5 } })],
    ['Run in de toekomst', () => mine.act('Run.log', { params: { date: '2031-01-01', distance_km: 5, minutes: 30 } })],
    ['Tekst waar een getal hoort', () => mine.act('Run.log', { params: { date: today, distance_km: 'vijf', minutes: 30 } })],
    ['Een wedstrijd verwijderen', () => mine.act('Run.remove', { id: race })],
    ['Een verzonnen actie aanroepen', () => mine.act('Run.purge_all', {})],
    ['De eigenaar van een run wijzigen', () => mine.act('$edit', { id: first, params: { owner: SAM } })],
    ['Een alleen-lezen veld bewerken', () => mine.act('$edit', { id: first, params: { distance_km: 99 } })],
    ['De run van iemand anders bewerken', () => mine.act('$edit', { id: sams, params: { note: 'gehackt' } })],
    ['Sam opent het traineroverzicht', () => db.open('alle-runs', { actor: SAM }).read()],
    ['Om de surface heen rechtstreeks schrijven', () => db.transact([{ e: first, a: 'Run.distance_km', v: 42 }], { actor: 'ui:generated' })],
    ['Als agent het schema op main wijzigen', () => db.evolve({ attrs: { 'Run.secret': { type: 'string', description: 'x' } } }, { actor: COACH })],
  ];
  return attempts.map(([label, fn]) => ({ label, result: attempt(fn) }));
}

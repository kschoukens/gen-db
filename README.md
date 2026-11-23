# GenDB

**Een proof of concept van de database die nog niet bestaat: een database die geen rijen teruggeeft maar een contract, zodat een AI-model er veilig een wegwerp-UI op kan bouwen.**

![De demo: Kim bekijkt een voorstel van een agent in een eigen wereld, vóór het in main bestaat](docs/demo.png)

## De vraag

> Gezien de huidige ontwikkelingen in AI en de toekomst van generatieve UI: wat zou de beste nog niet uitgevonden databasetechnologie zijn, en hoe zou je die gebruiken?

## Het antwoord in het kort

Software wordt wegwerpbaar, gegevens niet. Als een model voor elke vraag een nieuwe interface schrijft, verdwijnt de applicatielaag: er is geen handgeschreven backend meer die weet wat een kolom betekent, welke waarden zinnig zijn, wie wat mag en hoe je een fout terugdraait. Al die kennis zat in code die niemand meer schrijft.

Ze moet dus ergens anders heen, en de enige plek die blijft bestaan is de database. De technologie die ontbreekt is daarom geen snellere opslag of een betere vectorindex. Het is een database die ontworpen is voor een klant die een model is, en die die klant niet vertrouwt.

GenDB noemt dat een **contract-database**. Ze draait om één nieuw begrip, de *surface*, en vijf eigenschappen die dat begrip mogelijk maken.

### De surface

Een surface is een benoemd, toegekend en live stuk van de database, gedefinieerd door de intentie die het dient: welke rijen, welke velden, welke daarvan bewerkbaar zijn en welke acties bestaan. Een surface lezen geeft meer dan gegevens terug:

| Aanroep | Wat je krijgt | Voor wie |
|---|---|---|
| `describe()` | Het contract: betekenis, eenheden, grenzen, acties, regels. **Geen enkele rij gegevens.** | Het model dat de UI schrijft |
| `read()` | De rijen, plus per rij welke acties nu kunnen en waarom niet | De UI in de browser van de gebruiker |
| `act()` | De enige manier waarop een UI iets verandert, gecontroleerd tegen surface én schema | Diezelfde UI |

Twee gevolgen maken dit de moeite waard:

1. **Het model hoeft je gegevens nooit te zien om je UI te bouwen.** Het krijgt het contract; de rijen worden pas in de browser gebonden. Dat haalt gegevenslekken naar de modelaanbieder en promptinjectie via opgeslagen tekst structureel uit het ontwerp.
2. **Een gegenereerde UI kan willekeurig fout zijn, maar niet willekeurig schadelijk.** Ze kan alleen aan haar surface binden. Een verkeerd gespeld veld, een onmogelijke waarde, een knop die niet zou mogen bestaan: de database weigert het, en zegt erbij hoe het wel moet.

Dit is hypermedia (HATEOAS) tot in de database doorgetrokken. Dat idee sloeg nooit aan omdat handgeschreven clients hun kennis toch hardcodeerden. Een taalmodel is de eerste client die een zelfbeschrijvend antwoord echt kan lezen.

### De vijf eigenschappen eronder

| Wat de applicatie vroeger deed | Waar het in GenDB zit |
|---|---|
| Weten wat de gegevens betekenen | **Het schema draagt de betekenis**: beschrijvingen, eenheden, grenzen, regels en acties, geschreven om door een model gelezen te worden |
| Migraties schrijven | **Schema's groeien alleen.** Een agent stelt uitbreidingen voor; een betekeniswijziging gaat via een *lens*, zodat oude en nieuwe UI's dezelfde feiten lezen en schrijven |
| Valideren en autoriseren | **Regels en rechten zitten in de database**, als gegevens in plaats van code. Geen enkel schrijfpad gaat eromheen |
| Testen vóór je iets live zet | **Speculatie is de standaard.** Een agent werkt in een eigen wereld (branch); een mens keurt een diff goed, geen code |
| Undo, audit, "wie deed dit?" | **Elk feit kent zijn herkomst**: wie, voor welke intentie, met welk model, hoe zeker. Je draait terug op intentie, niet op tijdstip |

En één eigenschap die geen applicatie ooit nodig had: **fouten zijn prompts.** Elke weigering heeft een stabiele code, een uitleg en een herstelhint, zodat een model zijn verzoek kan verbeteren zonder dat er een mens tussen zit.

## Zelf proberen

Node 20 of nieuwer, geen afhankelijkheden.

```bash
npm test          # 23 tests die elk van de claims hierboven hard maken
npm run demo      # het hele verhaal in de terminal, in zeven stappen
npm run serve     # de live demo op http://localhost:4173
```

In de live demo houdt Kim een hardlooplogboek bij. Er is geen hardloop-app: er is een database die weet wat een run is, en een UI die uit het contract gegenereerd wordt. Probeer dit:

- **Open het tabblad Contract.** Dat is alles wat de generator te zien krijgt.
- **Klik "Houd ook mijn kniepijn bij".** De agent breidt het schema uit en gokt de pijn voor oude runs uit de notities, met 40% zekerheid, in een eigen wereld. Kies "Eerst bekijken" en je ziet de nieuwe UI op gegevens die in main nog niet bestaan.
- **Log in als Sam** en probeer het voorstel goed te keuren. Dat mag alleen een eigenaar.
- **Klik "Ik wil afstanden in meters".** De agent probeert eerst de eenheid te wijzigen, wordt geweigerd, leest de herstelhint en stelt een lens voor. Daarna schrijven twee UI's in twee eenheden naar hetzelfde feit.
- **Laat een gehallucineerde UI los**: dertien foute pogingen, dertien weigeringen, nul geschreven transacties.
- **Maak de gok van de agent ongedaan.** Waarden die Kim intussen zelf verbeterd heeft, blijven staan.

De UI-generator in deze demo is bewust een gewone functie ([`src/genui.js`](src/genui.js)) en geen taalmodel. Ze krijgt precies wat een model zou krijgen, en bewijst daarmee dat het contract volstaat. Een echt model zou er een rijkere UI van maken; voor de database verandert er niets.

## Hoe je het gebruikt

```js
import { Database } from './src/index.js';

const db = new Database({ owners: ['user:kim'] });

// 1. De eigenaar legt vast wat de gegevens betekenen. Geen code, alleen gegevens.
db.evolve({
  types:    { Run: { description: 'Eén hardloopsessie' } },
  attrs:    { 'Run.distance_km': { type: 'number', unit: 'km', min: 0.1, max: 100, required: true,
                                   description: 'Gelopen afstand' },
              'Run.owner':       { type: 'string', required: true, description: 'Wie de run liep' } },
  rules:    { 'Run.max': { on: 'Run', description: 'Niet verder dan 100 km',
                           rule: ['<=', ['get', 'Run.distance_km'], 100] } },
  actions:  { 'Run.log': { on: 'Run', kind: 'create', description: 'Leg een run vast',
                           params: { distance_km: { attr: 'Run.distance_km' } },
                           set: { 'Run.owner': ['actor'] } } },
  surfaces: { 'mijn-runs': { description: 'Mijn hardlooplogboek', from: 'Run',
                             where: ['=', ['get', 'Run.owner'], ['actor']],
                             fields: ['Run.distance_km'], actions: ['Run.log'],
                             grants: ['user:*'] } },
}, { actor: 'user:kim', intent: 'logboek opzetten' });

// 2. Een model krijgt het contract en schrijft er een UI voor.
const surface  = db.open('mijn-runs', { actor: 'user:kim' });
const contract = surface.describe();          // betekenis en mogelijkheden, geen gegevens

// 3. Die UI leest live en handelt via het contract.
surface.subscribe((result) => render(result)); // rijen + wat er per rij kan
surface.act('Run.log', { params: { distance_km: 8.4 } });
surface.act('Run.log', { params: { distance_km: 500 } });
// → GenDBError VALIDATION_FAILED: "Run.distance_km is above the maximum of 100 km"
//   repair: "Use a value of at most 100."

// 4. Een agent die iets nieuws wil, doet dat in een eigen wereld.
db.fork('agent/kniepijn', { actor: 'agent:coach', intent: 'kniepijn bijhouden' });
db.evolve({ attrs: { 'Run.knee_pain': { type: 'number', min: 0, max: 10, description: 'Kniepijn, 0 tot 10' } } },
          { branch: 'agent/kniepijn', actor: 'agent:coach', intent: 'kniepijn bijhouden' });

db.review('agent/kniepijn');                              // de diff die een mens leest
db.merge('agent/kniepijn', { approvedBy: 'user:kim' });   // alleen een eigenaar

// 5. En als het toch niet goed was:
db.undo({ intent: 'kniepijn bijhouden' }, { actor: 'user:kim' });
```

Waar je dit voor zou inzetten:

- **Persoonlijk: één levensdatabase, eindeloos veel wegwerp-UI's.** Je vraagt vandaag een overzicht van je trainingen en volgende week of je kniepijn samenhangt met afstand. Het zijn twee gegenereerde interfaces op dezelfde feiten, en de tweede bestaat alleen omdat een agent het schema op jouw vraag mocht laten groeien.
- **Zakelijk: interne tools zonder backlog.** Elke medewerker laat zijn eigen scherm genereren op dezelfde beheerde gegevens. Wat mag en wat klopt, is één keer vastgelegd in de database en geldt voor elk scherm dat ooit nog gegenereerd wordt.
- **Meerdere agents: samenwerken via werelden in plaats van berichten.** Elke agent werkt in een branch; de diff met herkomst en zekerheid is het overdrachtsdocument.
- **Als MCP-server.** Elke surface is vanzelf een tool met een volledig schema: `describe` wordt de tooldefinitie, `act` de aanroep. Dat is de natuurlijke volgende stap voor deze repo.

## Wat bestaat al, en wat is nieuw

Bijna elk onderdeel bestaat los. Nieuw is dat ze samen één primitief vormen waar een gegenereerde UI op kan steunen.

| Bouwsteen | Bestaat al in | Wat ontbreekt |
|---|---|---|
| Branches | Neon, Dolt, PlanetScale, TiDB | Branches zijn er voor ontwikkelaars en CI. Schema en gegevens samen laten voorstellen, beoordelen en terugdraaien is nog onderzoek ([TINE](https://www.pingcap.com/blog/database-branching-ai-agents-tine/), [Columbia DAPLab](https://daplab.cs.columbia.edu/general/2026/05/26/branchable-databases-arent-ready-for-agentic-workloads.html)) |
| Betekenis in het schema | Semantische catalogi bij [Tiger Data](https://tigerdata.com/blog/the-database-new-user-llms-need-a-different-database), Oracle, Exasol | Beschrijvingen helpen een model betere SQL schrijven. Ze dwingen niets af en zeggen niets over wat je met een rij mag doen |
| Onveranderlijke feiten, tijdreizen | Datomic, XTDB | Herkomst als eerste-klas gegeven (intentie, model, zekerheid) en daarop terugdraaien |
| Lenzen | [Cambria](https://inkandswitch.com/cambria) (Ink & Switch) | Bedacht voor local-first software; niet ingebouwd in een database waar agents het schema laten groeien |
| Live queries | Convex, InstantDB, Electric | Leveren gegevens, geen mogelijkheden per rij |
| Rechten op rijniveau | Postgres RLS | Beschermt lezen en schrijven, maar beschrijft zichzelf niet aan de client |
| UI-protocollen | [A2UI](https://developers.googleblog.com/en/a2ui-and-mcp-apps/), MCP Apps, AG-UI | Regelen hoe een agent een UI aanlevert. De database blijft een tool erachter; wat er veilig mee kan, zit nog steeds in handgeschreven code |

Het dichtst bij de probleemstelling komt het Berkeley-artikel *Supporting Our AI Overlords: Redesigning Data Systems to be Agent-First* (2025), dat de eisen van agents aan databases beschrijft. GenDB voegt daar de andere helft aan toe: niet de agent die de database bevraagt, maar de mens die door een gegenereerde interface heen met zijn gegevens werkt.

## Wat dit niet is

Een proof of concept van ongeveer 1.500 regels, alles in het geheugen, bedoeld om het idee te toetsen en niet om er gegevens aan toe te vertrouwen. Wat een echte motor nog nodig heeft, staat in [docs/ontwerp.md](docs/ontwerp.md): incrementeel onderhouden views, onvervalsbare capabilities, opslag, en een antwoord op de vraag wie de regels schrijft.

## Wegwijzer

| Bestand | Inhoud |
|---|---|
| [`src/surface.js`](src/surface.js) | De surface: contract, lezen met mogelijkheden per rij, handelen, live volgen, lezen binnen een tokenbudget |
| [`src/schema.js`](src/schema.js) | Het schema als feiten, de indeling additief / strenger / brekend, lenzen |
| [`src/db.js`](src/db.js) | Rechten, schrijven, werelden beoordelen en samenvoegen, ongedaan maken op herkomst |
| [`src/store.js`](src/store.js) | Het feitenlog: transacties, branches, tijdreizen |
| [`src/validate.js`](src/validate.js), [`src/errors.js`](src/errors.js) | Validatie en fouten met herstelhints |
| [`src/expr.js`](src/expr.js) | De expressietaal voor regels, voorwaarden en filters: JSON, geen code |
| [`src/genui.js`](src/genui.js) | De plaatsvervanger voor het model: van contract naar UI |
| [`demo/`](demo/) | Het scenario, het verhaal voor de terminal en de live demo |
| [`docs/ontwerp.md`](docs/ontwerp.md) | Het ontwerp in detail, de keuzes en de open vragen |

# GenDB: het ontwerp

De [README](../README.md) zegt wat GenDB is en waarom. Dit document zegt hoe het in elkaar zit, welke keuzes erin zitten en wat nog open is.

## 1. Uitgangspunt

Een klassieke database gaat uit van een programmeur als klant: iemand die het schema kent, de query's test en de rechten in een applicatie eromheen regelt. In een wereld van generatieve UI is de klant een model, of een interface die een model een seconde geleden geschreven heeft. Die klant

- kent het schema niet, tenzij de database het vertelt;
- maakt fouten die geen mens zou maken, en maakt ze vol vertrouwen;
- wordt na gebruik weggegooid, dus niets wat ze weet of afdwingt blijft bestaan;
- moet kunnen experimenteren zonder dat een mens elke stap vooraf goedkeurt.

Elke ontwerpkeuze hieronder volgt uit één regel: **alles wat moet blijven kloppen, staat in de database; alles daarbuiten mag fout zijn.**

## 2. Gegevensmodel

Er wordt nooit iets overschreven. De database is een lijst transacties; een transactie is een verzameling feiten plus haar herkomst.

```
feit         (entiteit, attribuut, waarde, vorige waarde)
transactie   id, branch, tijdstip, feiten
             actor       wie schreef                       verplicht
             intent      waarvoor                          "kniepijn bijhouden"
             model       welk model, als het een agent was
             confidence  hoe zeker de schrijver was        0.4
             via/action  door welke surface en actie
             mergedFrom, approvedBy, undoes                bij samenvoegen en terugdraaien
```

De huidige toestand is een vouw over dat log. Daaruit volgen drie dingen zonder extra mechaniek:

- **Tijdreizen**: de toestand bij elke transactie, ook door een surface heen (`read({ asOf })`).
- **Branches**: een fork is een verwijzing in het log. Een branch ziet zijn eigen transacties en die van zijn ouder tot het moment van afsplitsen.
- **Herkomst**: `why(entiteit, attribuut)` geeft elke transactie die de waarde ooit zette, met alles hierboven.

Het schema is zelf opgeslagen als feiten (entiteit `$attr/Run.distance_km`, attribuut `$def`). Het is daardoor even vertakbaar, vergelijkbaar en terug te vinden als gegevens. Dat is geen elegantie om de elegantie: het maakt het mogelijk dat een agent een schema-uitbreiding en de gegevens die haar nodig hebben samen voorstelt, en dat een mens beide in één diff beoordeelt.

## 3. Het contract

`describe()` voor de surface `mijn-runs` uit de demo, ingekort tot één veld en één actie:

```json
{
  "gendb": "surface/0",
  "name": "mijn-runs",
  "intent": "Mijn hardlooplogboek: runs bekijken, loggen en bijwerken",
  "entity": { "type": "Run", "description": "Eén hardloopsessie van één persoon" },
  "fields": [
    { "name": "distance_km", "label": "Afstand", "type": "number", "unit": "km",
      "description": "Gelopen afstand", "required": true, "min": 0.1, "max": 100, "example": 8.4 }
  ],
  "actions": [
    { "name": "Run.remove", "kind": "delete", "scope": "row", "label": "Verwijderen",
      "destructive": true, "params": [],
      "availableWhen": "Run.race != true", "otherwise": "wedstrijdresultaten zijn definitief" }
  ],
  "summary": { "measures": [ { "name": "total_km", "label": "Totale afstand", "fn": "sum", "unit": "km" } ],
               "by": { "label": "Per maand" } },
  "rules": [ { "id": "Run.plausibel_tempo", "description": "Het tempo moet tussen 2 en 20 minuten per kilometer liggen" } ]
}
```

Het volledige contract is ongeveer 800 tokens en bevat geen enkele rij. Een model heeft hieraan genoeg om het juiste invoerveld te kiezen (getal, met eenheid, tussen 0,1 en 100), de juiste knop te tonen (verwijderen is destructief) en de gebruiker vooraf te waarschuwen voor regels die de database toch zal afdwingen.

`read()` geeft daarna de rijen, met per rij wat er op dit moment mee kan:

```json
{
  "total": 11,
  "rows": [
    { "id": "run_11",
      "values": { "date": "2026-11-15", "distance_km": 21.1, "race": true, "note": "Halve marathon! Knie hield het net" },
      "actions": { "Run.remove": { "enabled": false, "reason": "wedstrijdresultaten zijn definitief" },
                   "$edit": { "enabled": true } } }
  ],
  "summary": { "values": { "total_km": 104, "runs": 11, "longest_km": 21.1 } }
}
```

Drie details die ertoe doen:

- **De reden staat bij de rij.** De UI hoeft de voorwaarde niet na te bouwen; ze toont een uitgeschakelde knop met de reden die de database geeft. Negeert ze dat en roept ze de actie toch aan, dan krijgt ze `ACTION_UNAVAILABLE`.
- **Twee publieken.** `read({ audience: 'model' })` vervangt velden die in het schema als persoonsgegeven gemarkeerd zijn door `‹pii›`. De UI in de browser krijgt de echte waarden.
- **Lezen binnen een budget.** `read({ budget: { tokens: 400 } })` kort de rijen in tot ze passen, laat de totalen over álle rijen staan en zegt eerlijk hoeveel er is weggelaten. Een contextvenster is een schaars goed en de database is de enige die weet wat erin moet.

## 4. Wie mag wat

| | Eigenaar (`user:kim`) | Agent (`agent:coach`) | Gegenereerde UI |
|---|---|---|---|
| Lezen | alles, via `query()` | in deze PoC ook alles via `query()`; hoort een surface te worden (zie 9.2) | alleen haar surface, alleen de rijen die het rijfilter doorlaat |
| Gegevens schrijven in `main` | ja, gevalideerd | nee | alleen via de acties van haar surface |
| Schema wijzigen in `main` | ja, als het additief is of de gegevens al voldoen | nee | nee |
| Werken op een branch | ja | ja: schema uitbreiden, speculatief schrijven | via een surface op die branch |
| Samenvoegen in `main` | ja | nee, ook niet het eigen werk | nee |

Een surface werkt als een capability: ze bepaalt het volledige bereik van wie haar vasthoudt. Het rijfilter mag naar de actor verwijzen (`['=', ['get', 'Run.owner'], ['actor']]`), zodat één definitie iedereen zijn eigen rijen geeft. Acties vullen gevoelige velden zelf in (`set: { 'Run.owner': ['actor'] }`); de eigenaar van een run is nooit een parameter, dus geen enkele UI kan een run voor iemand anders loggen, hoe ze ook geschreven is.

Twee kleinigheden met een reden:

- "Bestaat niet" en "niet voor jou" geven hetzelfde antwoord (`NOT_GRANTED`, `ROW_NOT_VISIBLE`), zodat een UI niet kan aftasten wat er buiten haar surface is.
- Een surface kan geen rij maken die buiten haar eigen filter valt (`OUTSIDE_SURFACE`).

## 5. Schema's groeien alleen

Een gegenereerde UI van vorig jaar heeft geen onderhouder. Een migratie die haar breekt, breekt haar dus voorgoed. GenDB kent daarom geen brekende wijzigingen. Elke schemawijziging wordt ingedeeld:

| Niveau | Voorbeelden | Wat de database doet |
|---|---|---|
| **additief** | nieuw type, nieuw optioneel attribuut, extra enum-waarde, ruimere grens, nieuwe surface of actie, een lens | aanvaarden |
| **strenger** | nieuwe regel, nieuw verplicht attribuut, nauwere grens, enum-waarde weg | alle bestaande feiten nalopen; alleen aanvaarden als ze al voldoen |
| **brekend** | ander type, andere eenheid, attribuut of surface verwijderen | weigeren, met de lens als herstelhint |

Dat een andere eenheid brekend is, is het voorbeeld dat het meeste zegt: van `km` naar `m` verandert geen enkel opgeslagen getal, en toch betekent elk getal daarna iets anders. Een klassieke database ziet dat niet, omdat de eenheid in de hoofden van de programmeurs zat.

De uitweg is een **lens**: een nieuw attribuut dat een bestaand attribuut leest en schrijft door een omkeerbare transformatie.

```js
'Run.distance_m': { type: 'number', unit: 'm', min: 100, max: 100000,
                    lens: { kind: 'scale', from: 'Run.distance_km', factor: 1000 } }
```

Er bestaan drie soorten (`rename`, `scale`, `map`), alle drie omkeerbaar door hun vorm. Daardoor is een schrijfactie via de nieuwe naam altijd een goed gedefinieerde schrijfactie naar de oude. Er verhuist geen enkel feit, oude en nieuwe UI's delen dezelfde waarheid, en de eigen grenzen van de lens én de regels op de opgeslagen waarde gelden allebei.

## 6. Regels zijn gegevens, geen code

Regels, voorwaarden op acties, rijfilters en groeperingen gebruiken één kleine expressietaal, geschreven als JSON:

```js
['and', ['>=', ['/', ['get', 'Run.minutes'], ['get', 'Run.distance_km']], 2],
        ['<=', ['/', ['get', 'Run.minutes'], ['get', 'Run.distance_km']], 20]]
```

Dat is onhandiger dan een functie en dat is de bedoeling. Een model kan ze schrijven, de database slaat ze op als feiten, een mens leest ze in een diff, de database kan nagaan welke attributen ze raken, en niets wat een onvertrouwde agent voorstelt wordt ooit uitgevoerd als code. Onbekende waarden gedragen zich zoals in SQL: een regel faalt alleen als ze zeker onwaar is, een voorwaarde slaagt alleen als ze zeker waar is.

## 7. Fouten zijn prompts

Elke weigering heeft een stabiele `code`, een `message` en een `repair`. Bij validatie komen alle problemen in één keer terug, elk met hun veld en herstelhint, zodat één ronde volstaat.

| Code | Wanneer |
|---|---|
| `UNKNOWN_PARAM`, `UNKNOWN_FIELD`, `UNKNOWN_ATTRIBUTE`, `UNKNOWN_TYPE` | een naam bestaat niet; met `didYouMean` |
| `MISSING_PARAM`, `INVALID_PARAM` | een actie is onvolledig of verkeerd aangeroepen |
| `VALIDATION_FAILED` | bevat `violations`: `INVALID_VALUE`, `REQUIRED_MISSING`, `RULE_VIOLATED`, `REFERENCE_DANGLING` |
| `NOT_IN_SURFACE`, `FIELD_NOT_EDITABLE`, `ACTION_UNAVAILABLE`, `OUTSIDE_SURFACE` | buiten wat de surface toelaat |
| `NOT_GRANTED`, `ROW_NOT_VISIBLE` | buiten wat de actor mag zien |
| `BRANCH_PROTECTED`, `APPROVAL_REQUIRED`, `ACTOR_REQUIRED` | buiten wat de actor mag doen |
| `SCHEMA_INVALID`, `SCHEMA_BREAKING`, `SCHEMA_REJECTED_BY_DATA` | een schemavoorstel deugt niet |
| `MERGE_CONFLICT`, `MERGE_REJECTED`, `BRANCH_CLOSED` | samenvoegen kan niet |

In de demo is te zien dat dit werkt als lus: de agent die de eenheid wil wijzigen krijgt `SCHEMA_BREAKING` met de lens als hint, en doet het daarna goed.

## 8. Speculatie, samenvoegen, terugdraaien

- **`review(branch)`** geeft wat een mens goedkeurt: de schemawijzigingen met hun niveau en reden (bij een surface ook wie ze krijgt en wat ze toelaat), de gewijzigde waarden met actor, intentie en zekerheid, en de conflicten.
- **`merge(branch, { approvedBy })`** controleert het resultaat tegen wat `main` intussen geworden is, niet tegen wat het was. Daarna worden de transacties één voor één opnieuw afgespeeld, zodat de herkomst het samenvoegen overleeft.
- **`undo({ intent })`** neemt alles terug wat voor een intentie geschreven werd (of door een actor, een model, via een surface). Het is een nieuwe transactie die de vorige waarden herstelt; de geschiedenis blijft staan. Een waarde die iemand intussen opnieuw wijzigde, blijft zoals ze is en wordt gemeld. Schema-uitbreidingen worden niet teruggedraaid: schema's groeien alleen.

## 9. Wat een echte motor nog nodig heeft

Dit is een proof of concept. Wat het bewijst is dat het model samenhangt; wat het niet bewijst is dat het schaalt.

1. **Incrementeel onderhouden views.** `subscribe()` leest hier na elke transactie opnieuw. Een echte motor houdt elke surface incrementeel bij; de technieken bestaan (differential dataflow en verwanten), maar niet in combinatie met mogelijkheden per rij.
2. **Onvervalsbare capabilities.** In de demo komt de actor uit een queryparameter. Een surface hoort een ondertekend, verder in te perken en in te trekken token te zijn dat een UI vasthoudt en kan doorgeven aan een deel-UI met minder rechten.
3. **Opslag en indexen.** Alles zit in het geheugen en query's lopen alle entiteiten af. De herkomstvelden vragen eigen indexen als terugdraaien op intentie goedkoop moet blijven.
4. **Goedkope branches op schaal.** Het onderzoek dat de README aanhaalt laat zien dat bestaande systemen kiezen tussen goedkoop afsplitsen en snel werken op een branch. Als elke agentactie een branch is, moet beide.
5. **Wie schrijft de regels?** De veiligheid is precies zo goed als het schema. Een agent kan regels voorstellen, maar een mens moet ze begrijpen om ze goed te keuren. De diff leesbaar houden is een ontwerpprobleem dat hier nauwelijks aangeraakt is.
6. **Een rijkere query- en lenstaal.** Geen joins, één type per surface, drie soorten lenzen. Structurele wijzigingen (een attribuut splitsen, een type opdelen) vragen lenzen die hier niet bestaan.
7. **Zekerheid als eerste-klas begrip.** Nu is `confidence` een label op een transactie. Een surface zou onzekere waarden anders moeten kunnen tonen, en een regel zou erover moeten kunnen spreken ("geen factuur op basis van een gok").

## 10. Volgende stappen in deze repo

1. Een echte modelgenerator naast de functie in `src/genui.js`, met hetzelfde contract als enige invoer, om te meten hoe vaak een model binnen het contract blijft en hoe goed het de herstelhints gebruikt.
2. Surfaces als MCP-tools aanbieden: `describe()` als tooldefinitie, `act()` als aanroep.
3. Capabilities als tokens, met inperken en intrekken.
4. Het feitenlog op schijf, zodat een demo een herstart overleeft.

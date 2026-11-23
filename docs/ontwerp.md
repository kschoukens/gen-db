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

De samenvatting zegt in het contract zelf wat ze betekent (`meaning` per maat, `key` voor de groepssleutel). Dat is toegevoegd nadat de modellen in de proef (sectie 12) er alle drie naar moesten raden.

Drie details die ertoe doen:

- **De reden staat bij de rij.** De UI hoeft de voorwaarde niet na te bouwen; ze toont een uitgeschakelde knop met de reden die de database geeft. Negeert ze dat en roept ze de actie toch aan, dan krijgt ze `ACTION_UNAVAILABLE`.
- **Twee publieken.** `read({ audience: 'model' })` vervangt velden die in het schema als persoonsgegeven gemarkeerd zijn door `‹pii›`. De UI in de browser krijgt de echte waarden.
- **Lezen binnen een budget.** `read({ budget: { tokens: 400 } })` kort de rijen in tot ze passen, laat de totalen over álle rijen staan en zegt eerlijk hoeveel er is weggelaten. Een contextvenster is een schaars goed en de database is de enige die weet wat erin moet.

## 4. Wie mag wat

| | Eigenaar (`user:kim`) | Agent (`agent:coach`) | Gegenereerde UI |
|---|---|---|---|
| Lezen | alles, via `query()` | in deze PoC ook alles via `query()`; hoort een surface te worden | alleen haar surface, alleen de rijen die het rijfilter doorlaat |
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

Een schending van een waarde draagt daarnaast een machineleesbare `reason` (`below_min`, `above_max`, `too_long`, `not_allowed`, `wrong_type`, `no_such_reference`) en de `limit` die geraakt werd. De `message` is Engels en bedoeld voor een model; een UI die Nederlands spreekt, verwoordt de melding zelf uit reden en grens. De tokens voegen `TOKEN_INVALID`, `TOKEN_EXPIRED`, `TOKEN_REVOKED` en `CAVEAT_INVALID` toe, het journaal `JOURNAL_CORRUPT` en `JOURNAL_VERSION`.

In de demo is te zien dat dit werkt als lus: de agent die de eenheid wil wijzigen krijgt `SCHEMA_BREAKING` met de lens als hint, en doet het daarna goed.

## 8. Speculatie, samenvoegen, terugdraaien

- **`review(branch)`** geeft wat een mens goedkeurt: de schemawijzigingen met hun niveau en reden (bij een surface ook wie ze krijgt en wat ze toelaat), de gewijzigde waarden met actor, intentie en zekerheid, en de conflicten.
- **`merge(branch, { approvedBy })`** controleert het resultaat tegen wat `main` intussen geworden is, niet tegen wat het was. Daarna worden de transacties één voor één opnieuw afgespeeld, zodat de herkomst het samenvoegen overleeft.
- **`undo({ intent })`** neemt alles terug wat voor een intentie geschreven werd (of door een actor, een model, via een surface). Het is een nieuwe transactie die de vorige waarden herstelt; de geschiedenis blijft staan. Een waarde die iemand intussen opnieuw wijzigde, blijft zoals ze is en wordt gemeld. Schema-uitbreidingen worden niet teruggedraaid: schema's groeien alleen.

## 9. Capabilities: een surface die je kunt doorgeven

Een surface bepaalt alles wat een UI kan zien en doen. Over een netwerk betekent dat pas iets als het vasthouden van de surface zelf de toestemming is, zonder "wie ben jij?" bij elk verzoek. Een token is daarom een HMAC-keten in de stijl van macaroons:

```
sig0 = HMAC(geheim, { id, surface, actor, branch })     uitgegeven door de database
sigN = HMAC(sigN-1, beperkingN)                         elke beperking maakt het token smaller
```

Het token draagt de wortel, de beperkingen en alleen de laatste handtekening. Wie het heeft, kan er zelf een beperking aan toevoegen, zonder het geheim en zonder rondje langs de server. Niemand kan er een afhalen of een wortel vervalsen.

| Beperking | Effect |
|---|---|
| `fields`, `editable`, `actions` | doorsnede met wat er al mocht; een naam buiten de surface versmalt tot niets |
| `readOnly` | geen acties, niets bewerkbaar |
| `where` | een extra rijfilter, met EN verbonden aan dat van de surface |
| `expires` | de vroegste vervaldatum in de keten geldt |
| `audience: 'model'` | persoonsgegevens altijd afgeschermd, wat de aanroeper ook vraagt |
| `id` | een eigen naam, zodat dit afgeleide token apart ingetrokken kan worden |

Keuzes die ertoe doen:

- **Een verborgen veld blijft verborgen langs elke omweg.** Een filter mag alleen velden lezen die op dat punt in de keten zichtbaar zijn, anders is het filter een orakel op de verborgen waarde. Sortering, samenvatting en groepering over een verborgen veld vallen weg. Een actie waarvan de voorwaarde een verborgen veld leest, valt ook weg, omdat "kan niet, want het is een wedstrijd" dat veld zou verraden.
- **Alles wordt bij elk gebruik opnieuw gecontroleerd**: handtekening, vervaldatum, intrekking en de toekenning in het actuele schema. Een token volgt het levende schema en reikt er nooit voorbij.
- **Eén antwoord voor elk ongeldig token.** Waarom een handtekening faalt, is een hint voor een vervalser.
- **Lezen in het verleden vraagt toegang in het heden.** Wie een surface kwijt is, is ook haar geschiedenis kwijt.

Zwaktes die blijven: beperkingen zijn leesbaar voor elke houder (ze beperken, ze verbergen niet), intrekkingen leven alleen in het geheugen, in de demo reizen tokens in de URL, en een validatiefout kan de naam van een verborgen attribuut noemen.

## 10. Het feitenlog op schijf

De store was al een log waar alleen aan toegevoegd wordt, dus duurzaamheid vraagt geen tweede gegevensstructuur: elke wijziging wordt één regel JSON, en een database openen is die regels opnieuw afspelen.

```
{"t":"gendb-journal","v":1}
{"t":"tx","ids":3,"tx":{"id":2,"branch":"main","at":"…","actor":"user:kim","intent":"run loggen","facts":[…]}}
{"t":"fork","ids":15,"branch":{"name":"agent/kniepijn","parent":"main","forkTx":15,…}}
{"t":"batch","records":[ …alle transacties van een samenvoeging, plus de statuswijziging… ]}
```

- **Eerst schrijven, dan toepassen.** Een transactie raakt het geheugen pas als ze in het journaal staat. Het geheugen wordt bovendien opgebouwd uit wat geschreven is, zodat geheugen en schijf nooit uiteenlopen.
- **Een samenvoeging is één regel.** Een crash laat alles of niets achter. Mislukt het schrijven, dan wordt ook het geheugen teruggezet en horen luisteraars niets.
- **Een afgebroken laatste regel wordt weggegooid en afgeknipt**; die was nooit bevestigd. Schade elders is geen gevolg van een crash en wordt gemeld in plaats van weggeraden. Een bestand dat geen GenDB-journaal is, wordt nooit aangeraakt.
- **Afspelen controleert de geschiedenis**: transactienummers sluiten aan, er wordt alleen naar open branches geschreven.

Wat ontbreekt: vergrendeling tegen twee processen op één bestand, momentopnamen en compactie (openen leest alles), en `fsync` staat standaard uit, wat beschermt tegen een crash van het proces maar niet tegen stroomuitval.

## 11. Surfaces als MCP-tools

Een surface beschrijft zichzelf volledig, en dat is wat een tooldefinitie in het Model Context Protocol vraagt. Er hoeft per database dus geen lijm geschreven te worden.

| Tool | Wat het doet |
|---|---|
| `mijn-runs` | de surface lezen: rijen, mogelijkheden per rij, samenvatting. Altijd met `audience: 'model'`, dus persoonsgegevens afgeschermd |
| `mijn-runs__Run.log`, `mijn-runs___24edit`, … | één tool per actie, met een invoerschema (types, grenzen, enums, verplicht) afgeleid uit het contract |

- **Een weigering is geen protocolfout.** Ze komt terug als toolresultaat met `isError: true` en de volledige fout, zodat het model zijn aanroep verbetert.
- **Herkomst.** Elke actietool heeft een optioneel argument `intent` ("waarom, in de woorden van de gebruiker"); het modellabel komt uit de clientinformatie. MCP vertelt een server niet welk model belt, dus het label noemt de clienttoepassing.
- **De toollijst volgt het schema.** Wordt een branch samengevoegd en ontstaat er een surface, dan meldt de server dat de lijst veranderd is.
- **Twee protocoltijdperken op één server.** Revisie 2026-07-28 schrapte de handshake: elk verzoek draagt zijn eigen versie en clientinformatie. De server bedient die revisie zonder toestand en 2025-11-25 met handshake, per verzoek gekozen. Alle protocoldetails zijn tegen de specificatie gelezen, niet uit het hoofd; waar de specificatie zichzelf tegenspreekt, staat dat in een commentaar bij de keuze.

Niet gebouwd: Streamable HTTP, autorisatie, resources en prompts. De server handelt als één vaste actor die de starter kiest.

## 12. De sandbox en de proef

### Waar door een model geschreven code draait

Het contract maakt een gegenereerde UI onschadelijk voor de database. De sandbox ([`demo/sandbox.js`](../demo/sandbox.js)) maakt ze onschadelijk voor de gebruiker: de pagina draait in een iframe met een eigen, lege origin en een beleid dat geen netwerk toelaat. Haar enige kanaal is `window.surface`, dat via `postMessage` met de gastpagina praat. Die houdt het token; de gegenereerde pagina krijgt het nooit te zien.

`npm run evaluate` begint met een vijandige pagina die zestien uitwegen probeert, en kijkt of er een verzoek de pagina verlaat.

| Poging | Uitkomst |
|---|---|
| `fetch`, XHR, WebSocket, `sendBeacon`, afbeelding, stylesheet of script van buiten | tegengehouden door het beleid in het iframe |
| Formulier versturen, pop-up openen, de bovenste pagina wegnavigeren | tegengehouden |
| De gastpagina lezen, `localStorage`, cookies | tegengehouden door de lege origin |
| **Zichzelf wegnavigeren** met gegevens in de URL | lekte in de eerste versie; nu tegengehouden door `frame-src 'none'` op de gastpagina |
| **WebRTC** via een genest frame | **open** |

De twee vetgedrukte regels zijn gevonden door de sandbox aan te vallen, niet door erover na te denken. Een beleid binnen een document kan dat document niet beletten zichzelf weg te navigeren; alleen de pagina eromheen kan dat verbieden. En WebRTC is de ene netwerk-API die geen enkel beleid dekt: Chromium kent de richtlijn `webrtc` niet, en een opzoeking bij een STUN-server kan gegevens in een hostnaam naar buiten dragen. De constructors worden weggehaald, wat code tegenhoudt die het gewoon probeert, maar een genest frame krijgt ze terug. Dat sluiten vraagt de browser of het netwerk, en de test meldt het als open in plaats van het te verzwijgen.

### De proef

Drie model-agents kregen elk een contract, de beschrijving van `window.surface` ([`demo/generated/BRIEF.md`](../demo/generated/BRIEF.md)) en een vraag van een gebruiker:

| Pagina | De vraag |
|---|---|
| `mijn-runs.logboek` | "Ik wil mijn hardlooplogboek zien en bijhouden: een overzicht met mijn totalen en hoe het per maand loopt, al mijn runs, en een nieuwe run kunnen loggen." |
| `mijn-runs.snel-loggen` | "Ik sta net buiten na het lopen, met mijn telefoon in de hand. Ik wil in een paar tikken mijn run van vandaag loggen en daarna kort zien hoe mijn laatste runs waren." |
| `knie-en-afstand.analyse` | "Ik heb de laatste tijd last van mijn knie. Hangt dat samen met hoe ver ik loop? Laat me dat zien, en laat me de pijnscore per run verbeteren waar ze niet klopt." |

Uitkomst: alle drie werkten bij de eerste uitvoering, zonder scriptfout, zonder netwerkpoging en zonder één verzoek buiten het contract. Wat de proef leerde:

1. **Functioneel correct lukt uit het contract alleen; visueel correct vraagt een lus.** Twee pagina's hadden een zichtbaar gebrek dat het model niet kon zien omdat het de pagina nooit uitvoerde. Eén ronde feedback in woorden, zonder gegevens, loste beide op. Een echte opstelling heeft dus een stap nodig die de pagina weergeeft en beoordeelt.
2. **Wat een model moet raden, hoort in het contract.** Alle drie vroegen zich af hoe groepssleutels eruitzien; één vroeg wat een telling telt en of een lege waarde nul is. Dat staat er nu in.
3. **De taal van de fout is niet de taal van de gebruiker.** Vandaar `reason` en `limit`.
4. **De twee logboekpagina's liepen tegen dezelfde grens van de surface aan**: afstand en datum zijn na het loggen niet te verbeteren, en een wedstrijd is niet te verwijderen. De modellen meldden het en bouwden er niet omheen. Zo hoort het: de UI stelt de grens niet ter discussie, de eigenaar wel.
5. **Zekerheid bereikt de UI niet.** De analysepagina is zorgvuldig over kleine aantallen en oorzakelijkheid, maar noemt een verband "duidelijk" op scores die een agent met 40% zekerheid gokte. Ze kon het niet weten: `read()` geeft waarden, geen herkomst.

De grenzen van de proef: drie pagina's, één modelfamilie, met de hand geschreven bedieningsstappen, en de regel "lees alleen deze twee bestanden" was een instructie die de agents bevestigden, geen technische afsluiting.

## 13. Wat een echte motor nog nodig heeft

Dit is een proof of concept. Wat het bewijst is dat het model samenhangt; wat het niet bewijst is dat het schaalt.

1. **Incrementeel onderhouden views.** `subscribe()` leest hier na elke transactie opnieuw. Een echte motor houdt elke surface incrementeel bij; de technieken bestaan (differential dataflow en verwanten), maar niet in combinatie met mogelijkheden per rij.
2. **Herkomst en zekerheid in wat een surface teruggeeft.** Zie punt 5 hierboven. Een surface zou per waarde moeten kunnen zeggen wie ze schreef en hoe zeker, en een regel zou erover moeten kunnen spreken ("geen factuur op basis van een gok").
3. **Echte identiteit vóór de tokens.** Inloggen is in de demo nagebootst, tokens reizen in de URL en intrekkingen overleven geen herstart.
4. **Een dichte sandbox.** WebRTC staat open; dat vraagt een browserinstelling of een netwerklaag.
5. **Opslag die schaalt.** Het journaal is duurzaam maar wordt bij openen helemaal gelezen; query's lopen alle entiteiten af. Er zijn momentopnamen, indexen (ook op herkomst) en vergrendeling nodig.
6. **Goedkope branches op schaal.** Het onderzoek dat de README aanhaalt laat zien dat bestaande systemen kiezen tussen goedkoop afsplitsen en snel werken op een branch. Als elke agentactie een branch is, moet beide.
7. **Wie schrijft de regels?** De veiligheid is precies zo goed als het schema. Een agent kan regels voorstellen, maar een mens moet ze begrijpen om ze goed te keuren. De diff leesbaar houden is een ontwerpprobleem dat hier nauwelijks aangeraakt is.
8. **Een rijkere query- en lenstaal.** Geen joins, één type per surface, drie soorten lenzen. Structurele wijzigingen (een attribuut splitsen, een type opdelen) vragen lenzen die hier niet bestaan.

## 14. Volgende stappen in deze repo

1. De generatielus sluiten: een model dat op het moment van de vraag een pagina schrijft, de weergave beoordeelt en verbetert, in plaats van de drie vooraf geschreven pagina's.
2. Herkomst en zekerheid opnemen in `read()` en in het contract.
3. De proef verbreden: meer surfaces, meer modellen, en bedieningsstappen die uit het contract worden afgeleid in plaats van met de hand geschreven.
4. De MCP-server over Streamable HTTP, met een token als autorisatie.

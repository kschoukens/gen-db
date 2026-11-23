# UI's die een model schreef

Elke pagina in deze map is geschreven door een taalmodel dat precies twee dingen kreeg: het contract van één surface (`surface.describe()`) en de beschrijving van de runtime in [`BRIEF.md`](BRIEF.md). Geen gegevens, geen broncode van GenDB. De vraag van de gebruiker waar elke pagina op antwoordt staat in [`docs/ontwerp.md`](../../docs/ontwerp.md), sectie 12.

De bestandsnaam is `<surface>.<variant>.html`. De live demo toont ze als tabblad naast de surface; `npm run evaluate` draait ze in de sandbox tegen een echte database en telt wat ze versturen.

De pagina's zijn niet met de hand bewerkt. Twee ervan zijn één keer door hun eigen model verbeterd, na feedback in woorden over een weergavefout; de git-geschiedenis toont de eerste versie en de verbetering.

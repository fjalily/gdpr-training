# Sporing av kursgjennomføring i GDPR-opplæringens Azure Static Web App

Denne oppskriften er tilpasset fra Compliance-treningens `TRACKING-RECIPE.md` og
beskriver hvordan dere kan måle hvilken ansatt som har gjennomført hvilken modul
— og hvor langt de har kommet i hver modul — i GDPR-opplæringen. Den bygger
videre på den eksisterende SWA-strukturen (`index.html`, `modul1_grunnkurs.html`
til `modul5_fordypning.html`, `gdpr_dosanddonts.html`).

## 1. Arkitektur i grove trekk

```
[ Ansatt i nettleser ]
        |
        | logger inn med Entra ID (jobbkonto)
        v
[ Azure Static Web App ]  --- serverer index.html + modul1..5 + dosanddonts
        |
        | POST /api/progress  (ved hver seksjon OG ved modul-fullføring)
        v
[ Azure Function (Managed API) ]
        |
        | skriver { user, moduleId, sectionIdx?, score?, completedAt }
        v
[ Azure Table Storage: GdprTrainingProgress ]
        |
        | leses av
        v
[ admin.html ]  --- intern rapportside for DPO
```

Forskjellen fra Compliance-oppskriften: her spores **to nivåer**, ikke bare
modul-fullføring:

1. **Seksjon-nivå** (`kind: "section"`) — hver gang en ansatt navigerer til en
   ny seksjon inne i en modul (via "Neste"/progress-dots), sendes en rad som
   viser at seksjonen er besøkt. Dette gir dere innsikt i hvor langt noen har
   kommet, selv om de ikke har fullført hele modulen.
2. **Modul-nivå** (`kind: "module"`, standard) — når hele modulen er
   gjennomgått og sluttquizen er ferdig, sendes score og fullføringstidspunkt,
   akkurat som i Compliance-kurset.

## 2. Komponenter i Azure

### 2.1 Static Web App
Filene i denne mappen deployes til SWA. Anbefalt: koble repoet mot SWA via
GitHub Actions slik at hver commit blir et nytt deploy automatisk (se
`.github/workflows/azure-static-web-apps.yml` i Compliance-repoet som mal).

### 2.2 Autentisering — Entra ID
`staticwebapp.config.json` i repo-roten bruker samme Instabank Entra-tenant
som Compliance-kurset:

```json
"openIdIssuer": "https://login.microsoftonline.com/e55a0cda-cf06-4f2a-9c25-970b0df22c1f/v2.0"
```

Alle sider krever `authenticated`-rollen. `admin.html` krever i tillegg
rollen **`gdpradmin`**, som tildeles DPO og relevante Compliance/HR-personer
via Entra ID-appregistrering (App roles) eller SWA Role management.

`/.auth/me` gir frontenden brukerens e-post uten ekstra kode — `index.html`
bruker dette til å vise "Innlogget som ...".

### 2.3 Lagring — Azure Table Storage

| Felt | Type | Eksempel |
|---|---|---|
| PartitionKey | string | `ola.nordmann@instabank.no` |
| RowKey (modul) | string | `3` |
| RowKey (seksjon) | string | `3_section_2` |
| user | string | `ola.nordmann@instabank.no` |
| moduleId | string | `3` |
| type | string | `module` eller `section` |
| sectionIdx | int | `2` (kun for `type: section`) |
| score | int | `10` (kun for `type: module`) |
| total | int | `11` (kun for `type: module`) |
| completedAt | datetime | `2026-07-03T10:32:11Z` |
| ipMasked | string | `10.0.0.0` |
| authenticated | bool | `true` |

Tabellnavn: **`GdprTrainingProgress`** (egen tabell, separat fra
`ComplianceTrainingProgress`, slik at dataene ikke blandes).

`upsertEntity` med `Replace` betyr at hvis brukeren tar en modul eller
seksjon på nytt, oppdateres raden. Ønsker dere full historikk over alle
forsøk (revisorbevis), bruk `RowKey = "<moduleId>_<timestamp>"` /
`"<moduleId>_section_<sectionIdx>_<timestamp>"` i stedet for å overskrive.

### 2.4 Backend — Azure Function

`api/progress/function.json` og `api/progress/index.js` er allerede lagt inn
i denne mappen. Endepunktet håndterer:

- `GET /api/progress` — returnerer innlogget brukers egen fremdrift
  (`{ modules: {...}, sections: {...} }`).
- `GET /api/progress?mode=admin` — returnerer alle brukeres fremdrift,
  krever `gdpradmin`-rolle.
- `POST /api/progress` — registrerer fremdrift:
  - `{ kind: "section", moduleId, sectionIdx, completedAt }` — seksjon besøkt.
  - `{ moduleId, score, total, completedAt }` (uten `kind`, eller
    `kind: "module"`) — modul fullført.

Sett opp miljøvariablene i SWA (**Settings → Environment variables**):

```
STORAGE_ACCOUNT = <deres storage-konto>
STORAGE_KEY     = <Storage account → Access keys → key1/key2 → Show → kopier>
```

### 2.5 Endringer i frontend (allerede gjort)

Hver modul-fil (`modul1_grunnkurs.html` … `modul5_fordypning.html`) har fått:

- En konstant `MODULE_ID` (1–5).
- `trackSection(idx)` — sendes automatisk når en seksjon vises (både ved
  første last av seksjon 0, og ved `goToSection`).
- Et `sendProgress({ kind: "module", ... })`-kall inni fullførings-logikken
  i `nextSection()`, med samme score-beregning som allerede fantes.

`index.html` henter nå `/api/progress` ved page-load og synkroniserer
modul-fullføring inn i den eksisterende `localStorage`-baserte UI-en
(`ib_gdpr_done`), slik at "X/5 moduler fullført" stemmer på tvers av enheter
for innloggede brukere. localStorage brukes fortsatt som lokal
cache/fallback dersom API-et er utilgjengelig.

## 3. Admin-rapport

`admin.html` viser en tabell med én rad per ansatt og én kolonne per modul.
En fullført modul vises i grønt med score. En påbegynt-men-ikke-fullført
modul vises i gult med "X / Y seksjoner" basert på hvor mange seksjoner som
er besøkt. CSV-eksport og søk på e-post er inkludert, som i Compliance-kurset.

## 4. Personvern og compliance

Samme prinsipper som i Compliance-oppskriften gjelder:

- **Lagring i EU-region** (West Europe / North Europe).
- **Slett-policy** — lifecycle-rule som sletter rader eldre enn f.eks. 5 år.
- **Tilgangskontroll** — kun DPO/Compliance/HR får `gdpradmin`-rollen.
- **Logg-tilgang** — Azure Monitor / Diagnostic Settings på Storage Account.
- **DPIA** — vurder behovet sammen med DPO, spesielt siden seksjonsnivå-
  sporing er mer detaljert enn Compliance-kursets modul-nivå-sporing.
- **Informasjonsplikt** — informer ansatte om at både seksjonsbesøk og
  modulfullføring spores. Legg gjerne en kort tekst i `index.html`.

## 5. Revisorbevis

Som i Compliance-oppskriften: vurder append-only lagring (ny rad per
fullføring med tidsstempel i `RowKey`) hvis Finanstilsynet eller intern
revisjon skal kunne bekrefte historikk, ikke bare siste tilstand.

## 6. Steg-for-steg deploy

1. Push filene i denne mappen (inkl. `api/` og `staticwebapp.config.json`)
   til et GitHub-repo.
2. Opprett en Static Web App i Azure-portalen, koble den til repoet
   (West Europe).
3. Opprett en Storage Account i samme region. Lag en tabell som heter
   `GdprTrainingProgress`.
4. Hent access key fra Storage Account og legg inn `STORAGE_ACCOUNT` /
   `STORAGE_KEY` som Environment variables i SWA.
5. Bekreft at Entra ID-appregistreringen (samme tenant som Compliance-kurset)
   har `AAD_CLIENT_ID` og `AAD_CLIENT_SECRET` satt i SWA.
6. Push en testendring og vent på at Actions-jobben deployer.
7. Logg inn med en testbruker. Gå gjennom noen seksjoner og fullfør én
   modul. Verifiser rader i tabellen (både `type: section` og
   `type: module`).
8. Gi `gdpradmin`-rollen til DPO/Compliance-teamet i Entra ID (App roles
   eller SWA Role management), og test `admin.html`.
9. Skriv en kort intern instruks / personvernmerknad til alle ansatte.

## 7. Sjekkliste

- [ ] SWA er deployet og tilgjengelig
- [ ] Innlogging fungerer mot Entra ID
- [ ] `/api/progress` skriver seksjon-rader ved navigasjon
- [ ] `/api/progress` skriver modul-rad ved fullført quiz
- [ ] `admin.html` viser data korrekt for `gdpradmin`-rolle
- [ ] Personvernerklæring er på plass i `index.html` eller ansatthåndbok
- [ ] Oppbevaringspolicy er satt på Storage Account
- [ ] DPO har godkjent oppsettet (inkl. seksjonsnivå-sporing)
- [ ] Compliance/HR/DPO vet hvor de finner `admin.html`

---

**Spørsmål?** Denne oppskriften er et utgangspunkt, tilpasset fra
Compliance-treningens tilsvarende dokument. Detaljene rundt Entra ID,
lagringsvalg og rapporteringsstruktur bør avklares med IT-Sikkerhet og DPO
før produksjonssetting.

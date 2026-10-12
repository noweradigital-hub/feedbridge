# FeedBridge

Medzistupeň medzi WooCommerce produktovým feedom a Metou (Commerce Manager). Berie feed vygenerovaný Woo pluginom, aplikuje pravidlá na úrovni projektu (1 projekt = 1 eshop), voliteľne vyrobí obrázky s novým pozadím a vystaví upravený feed na verejnej URL, ktorú si Meta sťahuje ako naplánovaný feed.

Používateľ (Nowera) je WordPress/Woo vývojár a robí reklamy klientom, takže nástroj musí zvládať viac klientskych eshopov. Komunikácia a UI sú po slovensky.

## Príkazy

```bash
npm install
npm test                  # test/run.js (pipeline + obrázky) a test/api.js (HTTP vrstva); bez internetu a kľúčov
ADMIN_PASSWORD=x PUBLIC_URL=http://localhost:3000 npm run dev
```

Node >= 22.13 (používa vstavaný `node:sqlite`, bez natívnych závislostí okrem `sharp`). Spúšťaj s `--no-warnings`, `node:sqlite` vypisuje experimental warning.

## Architektúra

```
src/server.js          Express: verejné /feeds/:slug.xml a /img/*, admin /admin + /api za Basic auth
src/db.js              SQLite: projects (config ako JSON), runs (log + súhrn, max 100 na projekt)
src/config.js          env konfigurácia + defaultProjectConfig()
src/runner.js          triggerRun() (zámok na projekt) + scheduler (tick každú minútu)
src/feed/parse.js      RSS 2.0 / Google Merchant -> objekty (odstraňuje g: prefix)
src/feed/rules.js      pravidlový engine, podmienky, šablóny, validácia pre Metu
src/feed/xml.js        serializácia späť do RSS s g: prefixom
src/feed/pipeline.js   previewProject() (bez obrázkov) a runProject() (plný beh, atomický zápis feedu)
src/images.js          vystrihnutie produktu (whitekey/removebg/rembg), pozadie, kompozícia, cache
public/                admin UI (vanilla JS, bez buildu)
```

Dáta: `DATA_DIR/feedbridge.db`, `feeds/<slug>.xml`, `images/<slug>/<hash>.jpg`, `cache/{orig,cutouts,bg}`.

## Dôležité rozhodnutia a invarianty

- Pravidlá sú usporiadaný zoznam (`config.rules`), typy: `exclude set replace clean_html truncate price remove`. Každé má voliteľné `when` (AND podmienky). Pridanie typu = `rules.js` (applyRules) + `RULE_TYPES`/`ruleBody` v `public/app.js`.
- Vstupný formát je zámerne len RSS 2.0 (to generujú Woo pluginy). Vnorené polia (`shipping`) a opakované (`additional_image_link`) sa zachovávajú.
- Zlyhaný beh NESMIE prepísať posledný dobrý feed: feed sa zapisuje cez `.tmp` + rename a až po úspešnom spracovaní; prázdny zdroj je chyba.
- Obrázky: výrez produktu sa cacheuje zvlášť (`cache/cutouts`, kľúč = URL + provider), výsledný JPEG podľa hashu všetkých nastavení. Zmena pozadia teda nevolá remove.bg znova. Nepoužívané súbory sa po behu mažú (`pruneImages`).
- Výstupné obrázky majú min. 500 px (požiadavka Mety).
- `image_link` vo výstupe ukazuje na `PUBLIC_URL/img/...`, preto musí byť `PUBLIC_URL` verejná HTTPS adresa.
- Admin API používa Basic auth (`ADMIN_USER`/`ADMIN_PASSWORD`); `/feeds` a `/img` sú verejné.
- Poistka poklesu (`config.safety.maxDropPct`, default 50, 0 = vypnuté, rovnako ako `drop_guard` v nwr-product-feeds): beh porovná počet unikátnych ID s publikovaným feedom ešte pred obrázkami. Pri 0 ID alebo väčšom poklese hodí `GuardError`, takže feed sa neprepíše. Meta v režime „nahradiť“ by chýbajúce produkty zmazala. Obísť sa dá len manuálne cez `POST /run {force:true}` (UI sa pýta); scheduler nikdy.
- Slug sa po vytvorení nemení (PUT vráti 409), lebo na ňom visí URL feedu v Mete.
- Na konci `applyRules` sa `availability` normalizuje na hodnoty Mety (`in_stock` → `in stock`, `backorder` → `available for order`). Podmienky nad `availability` akceptujú oba zápisy. `condition` je povinné, `brand/gtin/mpn` je len odporúčanie (`checkItem().warnings`).
- Obrázky: ten istý súbor sa vyrába len raz (`once()` v images.js) a všetko sa zapisuje cez `writeAtomic`. Varianty so spoločnou fotkou tak neplatia remove.bg viackrát.
- Jeden proces nad DB: pri štarte `recoverStaleRuns()` označí behy `running` ako `error`.
- Všetko, čo sa sťahuje z dát (zdrojový feed, `image_link`, URL pozadia), ide cez `safeFetch` v `src/net.js`: blokuje interné adresy aj po presmerovaní a pri spájaní, má strop veľkosti. Adresy z vlastnej konfigurácie (`REMBG_URL`, `NOTIFY_WEBHOOK_URL`) idú bežným `fetch`. Lokálne a v testoch `ALLOW_PRIVATE_FETCH=1` alebo `FETCH_ALLOW_HOSTS=host:port`.
- Originály sa po `ORIG_CACHE_HOURS` overujú podmieneným GET; kľúč výrezu aj výstupu je odtlačok OBSAHU originálu, nie URL. Vymenená fotka pod rovnakou URL tak dostane nový obrázok.
- `pruneImages` nemaže hneď: použitým súborom obnoví čas, nepoužívané zmaže po `IMAGE_RETENTION_DAYS` (Meta môže mať starú URL ešte v načítanom feede). `pruneCache` raz denne.
- `images.mode`: `cutout` (výrez), `photo` (celá fotka ako karta), `auto` (podľa bielych okrajov). Reálne katalógy miešajú produktové a lifestyle fotky.
- Knižnica pozadí: `DATA_DIR/assets`, API `/api/assets` (PUT surové telo, validácia cez sharp). Pozadie `{type:'image', asset:'nazov.jpg'}`.
- Upozornenia (`src/notify.js`): webhook len pri ZMENE stavu behu (chyba, poistka, zotavenie).
- Nasadenie: `deploy/compose.yml` (Traefik labels, sieť `root_default`), image z GHCR cez `.github/workflows/ci.yml`.
- Exportné profily (`config.profiles[]`: id, slug, name, channel `meta|google`, enabled, imageMode `project|original`, rules): jeden beh stiahne zdroj raz a každému zapnutému profilu zapíše vlastný feed `/feeds/<slug profilu>.xml`. Pravidlá = pravidlá projektu + pravidlá profilu, na konci normalizácia a validácia pre kanál (`CHANNELS` v rules.js). Projekt bez profilov dostane pri čítaní predvolený `{id:'main', slug: slug projektu}`, takže stará URL platí ďalej.
- Slug profilu je po uložení nemenný a jedinečný naprieč všetkými projektmi aj profilmi (`readProfiles`, `slugTaken`). Zmazaný profil = zmazaný feed. Počas behu sa profil ani projekt zmazať nedá (409).
- Google profil dostáva VŽDY pôvodnú fotku (`imageModeOf`), nikdy vygenerovanú grafiku. Až budú šablóny, čisté šablóny sa môžu povoliť, promo nikdy.
- Poistka poklesu je na profil. Zastavený profil ostatné nezastaví; výsledok je v `summary.profiles[slug]`, súhrnne `summary.error/guard/guardProfiles`. `runProject` vyhadzuje chybu len pri zlyhaní zdroja. `force` = `true` alebo zoznam slugov.
- Obrázky zdieľajú všetky profily projektu (`images/<slug projektu>/`); pri upratovaní sa rátajú aj obrázky zo zverejnených feedov profilov, ktoré tento raz nezapísali.
- História konfigurácie: tabuľka `config_versions` (posledných 30), obnovenie vracia pravidlá a nastavenia, zoznam profilov a ich URL necháva.
- Magnific API (`src/magnific.js`, `MAGNIFIC_API_KEY`, hlavička `x-magnific-api-key`): provider výrezu `magnific` a generovanie pozadí do knižnice (`POST /api/assets/generate`). API si fotku sťahuje samo z URL a nevie WebP, preto verejná cesta `/src/<odtlačok>.jpg` (originál z cache ako JPEG).
- Režim `auto`: biely okraj = výrez vždy; pri AI provideroch (rembg, magnific, removebg) aj jednofarebný štúdiový okraj (podiel pixelov okraja blízko mediánu ≥ 0,8). Lifestyle fotka ostáva celá.

## Pasce (už raz zaúčali)

- sharp: po `.blur()` vracia raw buffer 3 kanály aj pri 1-kanálovom vstupe, treba `.extractChannel(0)` (inak je alfa maska rozbitá do pruhov).
- Express handlery obaľuj cez `wrap()`, ktorý zachytí aj synchrónne chyby; validačné chyby hádž ako `HttpError(status, msg)`.
- `fast-xml-parser` s `parseTagValue:false`, aby ID-čka ako `00123` neprišli o nuly.

## Čo je overené a čo nie

Overené automaticky: parsovanie, všetky typy pravidiel, labely, ceny, vylúčenie, výstupný XML, whitekey výrez a kompozícia, cache druhého behu, podmienené pozadia, API (auth, CRUD, beh, verejný feed/obrázky, path traversal, zlyhanie zdroja).

NEoverené: vzhľad a ovládanie admin UI v prehliadači (iba syntax + že sa servíruje), provider `removebg` a `rembg` proti reálnym službám, Docker build, import výstupného feedu do reálneho Meta katalógu, beh s reálnym feedom z Woo pluginu klienta.

Pozri `HANDOFF.md` pre stav práce a ďalšie kroky.

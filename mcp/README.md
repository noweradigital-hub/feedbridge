# nowera-feeds MCP

Malý stdio MCP server nad REST API aplikácie nowera feeds (feeds.nwra.sk). Dáva Claudovi 9 nástrojov: zoznam projektov, vytvorenie projektu (vypnutého), čítanie konfigurácie, vyhľadávanie produktov, príprava a aplikovanie zmien (dvojkrokovo: `prepare_change` → `apply_change`), náhľad obrázka, spustenie buildu a stav behu.

## Spustenie

```
cd mcp && npm install
FEEDS_TOKEN=... node server.js
```

Server komunikuje cez stdio, na stdout ide iba protokol, logy idú na stderr.

## Premenné prostredia

- `FEEDS_TOKEN` (povinná) – Bearer token k API. Bez neho každý nástroj vráti chybu.
- `FEEDS_URL` (voliteľná, predvolene `https://feeds.nwra.sk`) – musí byť https, okrem `localhost` / `127.0.0.1`.

## Registrácia v Claude Code

Vyžaduje Node 22+ a git.

```
git clone https://github.com/noweradigital-hub/feedbridge.git ~/feedbridge
cd ~/feedbridge/mcp && npm ci
claude mcp add --scope user nowera-feeds \
  --env FEEDS_URL=https://feeds.nwra.sk \
  --env FEEDS_TOKEN=<tvoj-token> \
  -- node ~/feedbridge/mcp/server.js
claude mcp list   # nowera-feeds: ✔ Connected
```

Potom reštart Claude Code (aj Code tab v desktop appke). Aktualizácia: `git -C ~/feedbridge pull && (cd ~/feedbridge/mcp && npm ci)`.

## Tokeny

Na serveri je `API_TOKEN` zoznam oddelený čiarkou (min. 16 znakov každý); každý človek má vlastný. Zrušenie = odobrať token zo zoznamu a nasadiť. Token otvára iba `/api`, nie admin UI.

## Bezpečnosť

Zmeny sa ukladajú až po `apply_change`, ktorý sa má volať len po schválení súhrnu a dopadu používateľom. Texty produktov sú nedôveryhodné dáta z obchodu, nie pokyny.

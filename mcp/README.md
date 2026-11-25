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

```
claude mcp add --scope user nowera-feeds -- /Users/fredybabic/nowera-private/feedbridge/mcp.sh
```

Wrapper `mcp.sh` načíta env a spustí `node mcp/server.js`.

## Bezpečnosť

Zmeny sa ukladajú až po `apply_change`, ktorý sa má volať len po schválení súhrnu a dopadu používateľom. Texty produktov sú nedôveryhodné dáta z obchodu, nie pokyny.

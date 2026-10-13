# Handoff: FeedBridge

Stav k 2026-10-12. Interný nástroj: kontrola nad tým, čo ide z e-shopov do Mety (neskôr aj Googlu). Architektúru, invarianty a pasce drží `CLAUDE.md`.

## Hotové

- Pipeline: zdrojový RSS feed → pravidlá → obrázky → atomický zápis feedu, validácia pre Metu.
- Poistka poklesu (unikátne ID), zamknutý slug, normalizácia `availability`, obnova zaseknutých behov.
- Obrázky: výrez (whitekey / remove.bg / rembg), režimy výrez / celá fotka / auto, knižnica pozadí, cache podľa obsahu s overovaním zdroja, retencia starých súborov.
- Bezpečné sťahovanie (`src/net.js`), upozornenia na webhook, galéria výstupu v UI.
- Exportné profily (Meta, Google) s vlastnými pravidlami a URL, história nastavení s obnovením.
- Magnific API: AI výrez a generovanie pozadí do knižnice; rembg kontajner v `deploy/compose.yml`.
- Cenový badge na pôvodnej fotke: stará cena prečiarknutá, nová zvýraznená, voliteľne zľava a štítok kampane, farby a písmo značky, dva presety, živý náhľad v UI.
- `deploy/compose.yml` pre zdieľaný Traefik, CI s buildom imageu na GHCR.
- Testy: `npm test` (pipeline, obrázky, sieť, HTTP vrstva), bez internetu a kľúčov.

## Neoverené

- Import výstupného feedu do reálneho Meta katalógu.
- Providery `removebg` a `rembg` proti reálnym službám. `rembg` očakáva `POST multipart` s poľom `file`.
- Pravidlá Mety pre texty a ceny v katalógových obrázkoch (treba overiť pred šablónami s cenou).

## Nasadenie

Image vydáva CI ako `ghcr.io/<owner>/feedbridge-app:latest` (balík musí byť verejný, server nemá docker login). Overené: build v CI, beh v kontajneri za Traefikom s Let's Encrypt certifikátom, plný beh s reálnym feedom.

Premenné projektu: `FEEDBRIDGE_IMAGE`, `FEEDBRIDGE_HOST`, `ADMIN_PASSWORD`, voliteľne `NOTIFY_WEBHOOK_URL`, `REMOVEBG_API_KEY`, `REMBG_URL`. Doména musí smerovať na server ešte pred prvým štartom, inak Traefik minie pokus o certifikát. Dáta sú v named volume `feedbridge_data` (zálohovať hlavne `feedbridge.db` a `assets/`).

`/admin` a `/api` chráni Basic auth, `/feeds` a `/img` sú verejné (sťahuje ich Meta).

## Známe limity

- Vstup len RSS 2.0 (žiadny Atom/CSV).
- Lokálny výrez (whitekey) funguje len na čisto bielom pozadí; na štúdiové fotky s farebným pozadím treba provider rembg alebo magnific.
- Google profil berie dáta z toho istého zdroja ako Meta; polia, ktoré zdroj nemá (napr. `availability_date`), treba doplniť pravidlom alebo v zdroji.
- Jedno heslo pre celý admin.
- Filter `title` v šablónach mení veľkosť písmen naivne („iPhone“ → „Iphone“).
- Nekontroluje sa, či je `sale_price` nižšia ako `price`.

## Ďalšie kroky

1. Ďalšie vrstvy šablóny: logo, rámik, vlastný text s podmienkami (cena a zľava sú hotové ako badge).
2. Kampane s dátumom od–do (Black Friday, Vianoce) a automatickým návratom.

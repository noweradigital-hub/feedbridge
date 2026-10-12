# Handoff: FeedBridge

Stav k 2026-10-12. Interný nástroj: kontrola nad tým, čo ide z e-shopov do Mety (neskôr aj Googlu). Architektúru, invarianty a pasce drží `CLAUDE.md`.

## Hotové

- Pipeline: zdrojový RSS feed → pravidlá → obrázky → atomický zápis feedu, validácia pre Metu.
- Poistka poklesu (unikátne ID), zamknutý slug, normalizácia `availability`, obnova zaseknutých behov.
- Obrázky: výrez (whitekey / remove.bg / rembg), režimy výrez / celá fotka / auto, knižnica pozadí, cache podľa obsahu s overovaním zdroja, retencia starých súborov.
- Bezpečné sťahovanie (`src/net.js`), upozornenia na webhook, galéria výstupu v UI.
- `deploy/compose.yml` pre zdieľaný Traefik, CI s buildom imageu na GHCR.
- Testy: `npm test` (pipeline, obrázky, sieť, HTTP vrstva), bez internetu a kľúčov.

## Neoverené

- Docker build a beh v kontajneri (lokálne nebol spustený, overí ho CI a prvé nasadenie).
- Import výstupného feedu do reálneho Meta katalógu.
- Providery `removebg` a `rembg` proti reálnym službám. `rembg` očakáva `POST multipart` s poľom `file`.
- Pravidlá Mety pre texty a ceny v katalógových obrázkoch (treba overiť pred šablónami s cenou).

## Nasadenie

Premenné projektu: `FEEDBRIDGE_IMAGE`, `FEEDBRIDGE_HOST`, `ADMIN_PASSWORD`, voliteľne `NOTIFY_WEBHOOK_URL`, `REMOVEBG_API_KEY`, `REMBG_URL`. Doména musí smerovať na server ešte pred prvým štartom, inak Traefik minie pokus o certifikát. Dáta sú v named volume `feedbridge_data` (zálohovať hlavne `feedbridge.db` a `assets/`).

`/admin` a `/api` chráni Basic auth, `/feeds` a `/img` sú verejné (sťahuje ich Meta).

## Známe limity

- Vstup len RSS 2.0 (žiadny Atom/CSV).
- Jeden výstup na projekt; profily pre viac kanálov (Meta promo, Google čistý) ešte nie sú.
- Lokálny výrez funguje len na čisto bielom pozadí. Jemne béžové štúdiové fotky skončia v režime auto ako „karta“.
- Jedno heslo pre celý admin.
- Filter `title` v šablónach mení veľkosť písmen naivne („iPhone“ → „Iphone“).
- Nekontroluje sa, či je `sale_price` nižšia ako `price`.

## Ďalšie kroky

1. Exportné profily: viac výstupov z jedného projektu, oddelenie čistých a promo obrázkov, Google výstup.
2. Šablóny s vrstvami: odznak, cena, logo, rámik, podmienky na vrstvách; režim cez pôvodnú fotku aj cez výrez.
3. Kampane s dátumom od–do (Black Friday, Vianoce) a automatickým návratom.
4. Lepší výrez: rembg kontajner alebo výrez podľa farby okraja.

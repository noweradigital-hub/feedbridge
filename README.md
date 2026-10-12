# FeedBridge

Medzistupeň medzi produktovým feedom e-shopu a reklamným katalógom (Meta Commerce Manager). Zoberie RSS feed z WooCommerce pluginu, aplikuje pravidlá projektu, voliteľne vyrobí obrázky s novým pozadím a vystaví upravený feed na verejnej URL.

- Viac projektov (jeden e-shop = jeden projekt), admin UI v slovenčine.
- Pravidlá: vylúčenie, šablóny polí, nájdi/nahraď, čistenie HTML, skrátenie, ceny, custom labely.
- Obrázky: výrez produktu alebo celá fotka na vlastnom pozadí, knižnica pozadí.
- Poistka proti zmazaniu katalógu pri prázdnom alebo výrazne menšom feede.

```bash
npm install
npm test
ADMIN_PASSWORD=x PUBLIC_URL=http://localhost:3000 ALLOW_PRIVATE_FETCH=1 npm run dev
```

Node 22.13+. Konfigurácia je v `.env.example`, nasadenie v `deploy/compose.yml`, stav práce v `HANDOFF.md`.

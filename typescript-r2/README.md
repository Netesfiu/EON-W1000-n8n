# E.ON W1000 importálása Home Assistantba

**E.ON W1000 ütemezett XLSX-export → e-mail → Cloudflare Email Routing → Email Worker → R2 → TypeScript importáló → Home Assistant Energia irányítópult**

A Node.js 24-es importáló negyedórás mérésekből órás Recorder-statisztikát készít. Meglévő Home Assistant gépen is futtatható. Külön hardver, postafiók és IMAP-hozzáférés nélkül használható.

## 1. Ütemezett W1000 export

1. A W1000 portálon nyisd meg a **Távleolvasás → Új ütemezett exportálási beállítás** menüt, és válassz egyetlen mérési pontot (POD).
2. Válaszd az XLSX formátumot és lehetőleg a napi küldést. Ha megadható a visszamenőleges időszak, hét nap segíthet pótolni egy kimaradt küldést. Címzettnek az alább létrehozott Email Routing-címet add meg.
3. Válaszd ki a mérőváltozókat.

   | Változó | Tartalom |
   | --- | --- |
   | `+A` | A hálózatról vételezett energia mérési intervallumonként (kWh) |
   | `-A` | A hálózatba betáplált energia mérési intervallumonként (kWh) |
   | `1.8.0` | Kumulatív vételezési mérőállás (kWh) |
   | `2.8.0` | Kumulatív betáplálási mérőállás (kWh) |

Ha a portál külön ütemezést kér a negyedórás adatokhoz és a mérőállásokhoz, a mérőállásos jelentést küldd másik címre. Az importáló a négy oszlopcsoportos, mindkét energiairányt tartalmazó munkafüzetet várja. Az ugyanabban a fájlban szereplő mérőállások opcionálisak. A külön mérőállásos export önmagában nem importálható. [Upstream W1000-beállítások](../netesfiu/readme.md#eon-portál-beállítása)

## 2. Cloudflare Email Routing, Worker és R2

1. A Cloudflare-ben válaszd ki a kezelt domaint, majd az **Email Routing** alatt kapcsold be a szolgáltatást. Hagyd jóvá a szükséges DNS-rekordokat, és várd meg az aktív állapotot. Ha a domain már másik levelezőszolgáltatót használ, kezeld külön aldomainen az útvonalat, hogy a meglévő MX-rekordokat ne kelljen lecserélni. [Domainbeállítás](https://developers.cloudflare.com/email-service/configuration/domains/) · [Aldomainek](https://developers.cloudflare.com/email-service/configuration/subdomains/)
2. Az **R2 Object Storage** alatt hozz létre egy privát, `eon-meter-data` nevű bucketet.
### Worker telepítése

Node.js 24 alatt, egy külön, üres könyvtárban mentsd el az alábbi két fájlt. Az `EON_EMAILS` kötés ezen a néven teszi elérhetővé az R2 bucketet a Workerben. [Wrangler konfiguráció](https://developers.cloudflare.com/workers/wrangler/configuration/#r2-buckets)

`wrangler.toml`

```toml
name = "eon-email"
main = "worker.mjs"
compatibility_date = "2026-11-14"
workers_dev = false
preview_urls = false

[[r2_buckets]]
binding = "EON_EMAILS"
bucket_name = "eon-meter-data"
```

`worker.mjs`

```js
export default {
  async email(message, env) {
    const raw = await new Response(message.raw).arrayBuffer();
    const day = new Date().toISOString().slice(0, 10);
    const key = `incoming/${day}/${crypto.randomUUID()}.eml`;

    await env.EON_EMAILS.put(key, raw, {
      httpMetadata: { contentType: "message/rfc822" },
    });
  },
};
```

A Worker a teljes MIME-üzenetet menti a mellékletekkel együtt. A kulcs dátuma az érkezés UTC-napja. A telepítéshez futtasd a következőket. [Email Worker API](https://developers.cloudflare.com/email-service/api/route-emails/email-handler/) · [R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)

```sh
npx wrangler@4 login
npx wrangler@4 deploy
```

### Cím hozzárendelése a Workerhez

A domain **Email Routing → Routing rules** részében hozz létre egy egyedi címet, például `w1000@example.com`. Műveletnek válaszd a **Send to a Worker** lehetőséget, célként pedig az `eon-email` Workert. Ez a cím kerüljön a W1000 export beállításaiba. Egy megérkezett jelentés után ellenőrizd az R2 felületén az `incoming/YYYY-MM-DD/` alatti `.eml` fájlt. [Útvonalszabályok](https://developers.cloudflare.com/email-service/configuration/email-routing-addresses/)

### Olvasási hozzáférés az importálóhoz

A Cloudflare felületén az **R2 Object Storage → Overview → Manage API tokens** alatt hozz létre **Object Read only** jogosultságú tokent, és korlátozd az `eon-meter-data` bucketre. Az **Access Key ID**, a **Secret Access Key** és az S3 végpont kerüljön a megfelelő `R2_*` mezőkbe. A végpont a fiókhoz tartozó S3 URL, a bucket neve nélkül. Ha a buckethez régióspecifikus végpont tartozik, azt add meg. [Cloudflare R2 dokumentáció](https://developers.cloudflare.com/r2/api/tokens/)

## 3. Az importáló telepítése

A Home Assistantban admin fiókkal a **Profil → Biztonság → Hosszú élettartamú hozzáférési tokenek** alatt hozz létre egy tokent. Másold a `HA_TOKEN` mezőbe. A Recorder importáló parancsa admin jogosultságot kér. A `HA_URL` olyan alap URL legyen, amelyet a konténer is elér. Ubuntu alatt ez lehet például a gép helyi hálózati címe vagy egy elérhető HTTPS-cím. Próbaüzemhez elegendőek az R2 beállításai. [Home Assistant hitelesítés](https://www.home-assistant.io/docs/authentication/)

### Docker Compose Ubuntun

Docker Engine és a Compose bővítmény szükséges. Klónozd a repót egy állandó könyvtárba. A cron példájában is ugyanezt az útvonalat használd.

```sh
cd "$HOME"
git clone https://github.com/zkiiito/EON-W1000-n8n.git
cd EON-W1000-n8n/typescript-r2
umask 077
cp .env.example .env
chmod 600 .env
```

Töltsd ki a `.env` fájlt. A Home Assistant címét és tokenjét az éles futás előtt kell megadni.

```dotenv
IMPORT_MODE=dry-run
R2_ENDPOINT=https://ACCOUNT_ID.r2.cloudflarestorage.com
R2_BUCKET=eon-meter-data
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
HA_URL=
HA_TOKEN=
```

```sh
docker compose build
docker compose run --rm eon-importer --dry-run
```

A Compose az `importer-state` nevű kötetet csatolja a `/state` útvonalra. Az SQLite itt tárolja a méréseket és a Recorder-visszaigazolásokat. Helyi Node.js futásnál a `STATE_DIR` alapértéke `./state`. A konténer nem root felhasználóval, csak olvasható gyökérfájlrendszerrel fut, és nem nyit portot. Tartsd meg ugyanazt a Compose-projektet és kötetet a futások között. A kötetről leállított importáló mellett készíts mentést. Az eredeti R2 e-mailekből újra felépíthető a mérési előzmény.

Helyi futtatáshoz Node.js 24 szükséges.

```sh
npm ci
npm run check
npm test
npm run build
npm run start -- --dry-run --since 2026-11-01
npm run start -- --reprocess
```

- A `--dry-run` felülírja az éles módot. Újra letölti a kiválasztott e-maileket, a mentett állapot memóriában lévő másolatával dolgozik, és nem kapcsolódik a Home Assistanthoz. Az összesítés a korábban mentett előzményeket is tartalmazza.
- A `--since YYYY-MM-DD` az `incoming/YYYY-MM-DD/` útvonal dátuma alapján választ e-maileket, a megadott naptól kezdve. Az e-mailek régebbi méréseket is tartalmazhatnak. A kumulatív összeg számításához a mentett előzmény továbbra is rendelkezésre áll.
- A `--reprocess` a korábban feldolgozott e-maileket is újra beolvassa. Éles módban a teljes helyi előzmény összes teljes óráját újraküldi, beleértve a `--since` előtti órákat is. Recorder-mentés visszaállítása után ezzel pótolhatod az adatokat. Alapértelmezésben az importáló csak az új vagy módosult objektumokat tölti le, és csak a függőben lévő órákat küldi el.

## Támogatott W1000 formátum

A feldolgozó egy `POD_*` munkalapot olvas, rajta a `Pod` és az `Időbélyeg` oszloppal, valamint négy `Változó`, `Érték`, `Mértékegység` oszlopcsoporttal. A vételezett energiát a `+A`, a betápláltat a `-A` változó jelöli. Mindkettőnél `kWh` az elvárt egység. Egy állapotkötet egyetlen mérési ponthoz tartozik.

Az Excel dátumok budapesti helyi időt jelölnek. A mintában az időpontok 00:00 és 23:45 közé esnek, ezért a feldolgozó az intervallumok kezdeteként értelmezi őket. Ha az őszi óraátállítás ismétlődő órájának két előfordulása nem különböztethető meg, a fájl feldolgozása hibával leáll. Az eredeti e-mail megmarad az R2-ben. Az átállás napjáról származó export szükséges annak ellenőrzéséhez, hogyan jelöli a W1000 az ismétlődő időpontokat. Az opcionális `1.8.0` és `2.8.0` mérőállásokat a feldolgozó külön olvassa ki.

A kiinduló repó ugyanezeket az energiairányokat és az órás összesítést dokumentálja. A repóban nem találtunk licencfájlt vagy licencnyilatkozatot. Az importáló önállóan írt kód. [Kiinduló megoldás](https://github.com/Netesfiu/EON-W1000-n8n/tree/main/prixeus)

## 4. Próbaüzem és éles ellenőrzés

1. Futtasd a `docker compose run --rm eon-importer --dry-run --since YYYY-MM-DD` parancsot egy ismert jelentés dátumával. Hasonlítsd össze a naplóban szereplő UTC-időtartományt és a két energiairány összegét a munkafüzettel. Átfedő jelentéseknél nézd meg a duplikációk és korrekciók számát is. Hibás mellékletnél a napló megadja az R2-kulcsot és a melléklet sorszámát.
2. Sikeres próbaüzem után állítsd a `.env` fájlban az `IMPORT_MODE` értékét `write`-ra. Futtasd a `docker compose run --rm eon-importer --since YYYY-MM-DD` parancsot ugyanazzal a dátummal. Minden importált energiairánynál keresd a `statistics_confirmed` eseményt. Ekkor az importáló már visszaolvasta a megfelelő kumulatív értékeket a Recorderből.
3. A Home Assistantban nyisd meg a **Beállítások → Irányítópultok → Energia** beállításait. A hálózatról vételezett energiához válaszd az **E.ON grid import** (`eon:grid_import`) statisztikát, a visszatápláláshoz az **E.ON grid export** (`eon:grid_export`) statisztikát. Hasonlíts össze egy teljes napot vagy órát a jelentéssel.
4. Futtasd újra ugyanazt az importot. Változatlan bemenet esetén nulla függőben lévő statisztikának kell maradnia. Ezután ütemezheted a futást egy Docker-hozzáféréssel rendelkező felhasználó crontabjában.

Az alábbi példa óránként fut. A napló útvonalának írhatónak kell lennie. Ha a cron levélküldése be van állítva, hiba esetén rövid értesítést küld.

```cron
17 * * * * cd "$HOME/EON-W1000-n8n/typescript-r2" && { /usr/bin/docker compose run --rm -T eon-importer >> /var/log/eon-importer.log 2>&1 || { status=$?; echo "E.ON import failed (exit $status). See /var/log/eon-importer.log."; exit "$status"; }; }
```

## Korrekciók és újrafuttatás

Az SQLite az energiairány és az intervallum UTC-kezdete alapján azonosítja a mérést. A mellékletek hash-e azonosítja az egyforma fájlokat különböző e-mailekben is. Módosult mérésnél az R2 `LastModified` szerint újabb érték nyer. Azonos módosítási idejű, eltérő értékek hibát okoznak. Ha egy későbbi jelentésből hiányzik egy már ismert mérés, a korábbi érték megmarad. Az R2-hibák és a feldolgozhatatlan mellékletek újrapróbálhatók. A futás akkor is hibakóddal zárul, ha közben más e-maileket sikerült feldolgozni.

Az importáló csak az adott irányhoz tartozó, négy külön negyedórát tartalmazó órákat küldi el. A hiányos órák mérései a helyi állapotban maradnak, amíg egy későbbi jelentés ki nem egészíti őket. Az órás `sum` az adott óra végéig mért kumulatív energia, az első teljes óra előtt nulláról indulva. Ha egy régi érték módosul vagy új óra kerül az előzménybe, az importáló újraszámolja és frissíti az érintett későbbi összegeket is.

A Home Assistant Core 2026.11.0 `recorder/import_statistics` WebSocket parancsa a külső statisztikákat az órák UTC-kezdete alapján írja vagy frissíti. Az Energia irányítópult választója támogatja az `energy` egységosztályú külső statisztikákat. Az importáló `kWh` egységgel, `has_sum: true` és `mean_type: 0` beállítással küldi őket. A két statisztikához nem tartozik szenzor-entitás. [Recorder parancs](https://github.com/home-assistant/core/blob/2026.11.0/homeassistant/components/recorder/websocket_api.py) · [Recorder frissítés](https://github.com/home-assistant/core/blob/2026.11.0/homeassistant/components/recorder/statistics.py) · [Energia választó](https://github.com/home-assistant/frontend/blob/dev/src/panels/config/energy/editors/ha-energy-grid-source-editor.ts)

A Recorder először az import sorba állítását igazolja vissza. Az importáló a köteg elküldése előtt törli a helyi visszaigazolást, majd az elvárt értékek sikeres visszaolvasása után újra rögzíti. Ha közben elszakad a kapcsolat vagy leáll a folyamat, a következő futás ugyanazokat az órákat újra elküldi. A két statisztikai azonosítót csak ez az importáló írja, és egy azonosítópárhoz egy írót futtass.

## Hibaelhárítás

| Tünet | Mit ellenőrizz? |
| --- | --- |
| Nem érkezik levél | A domain vagy aldomain Email Routing állapota legyen aktív. Ellenőrizd az MX-rekordokat, a W1000-ben megadott címet és az engedélyezett útvonalszabályt. A Cloudflare **Activity log** mutatja, meddig jutott a levél. |
| A Worker fut, de nincs fájl az R2-ben | Ellenőrizd, hogy a telepített Workerhez az `EON_EMAILS` kötés tartozik, és az `eon-meter-data` bucketre mutat. A Worker hibáit a `npx wrangler@4 tail eon-email` paranccsal követheted. |
| `Email contains no XLSX attachments` | Az R2-ből letöltött eredeti `.eml`-ben keresd a csatolt XLSX fájlt. Egy letöltési link vagy más formátum önmagában kevés. A melléklet nélküli levél akkor is hibásnak számít, ha a többi jelentést sikerült importálni. |
| R2-hitelesítési hiba | Az S3 **Access Key ID** és **Secret Access Key** párost használd. Ellenőrizd a bucket nevét, a bucketre adott olvasási jogosultságot és azt, hogy a HTTPS-végpont a megfelelő Cloudflare-fiókhoz tartozik. |
| Hiányzó Home Assistant-statisztika | Nézd meg, hogy `dryRun: false` mellett megjelent-e a `statistics_confirmed` esemény. Kapcsolódási hibánál ellenőrizd a `HA_URL` elérhetőségét a futtatás helyéről, hitelesítési hibánál pedig az admin token beállítását. Ha a mentés sikerült, az Energia beállításaiban válaszd ki a két külső statisztikát, és nyisd meg az importált napot. |

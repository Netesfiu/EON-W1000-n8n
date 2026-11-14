# E.ON W1000 importálása Home Assistantba

A Node.js 24-es importáló a Cloudflare R2-ben tárolt nyers e-mailekből olvassa ki a W1000 XLSX jelentéseit. A negyedórás adatokat óránként összesíti, és a Home Assistant Recorderben rögzíti. A konténer egyszer lefut és kilép.

A feldolgozót valódi W1000 exporttal ellenőriztük. Alapértelmezésben próbaüzemben fut. Az éles beüzemeléshez ellenőrizd a mentést és a megjelenítést a saját Energia irányítópultodon.

## Hozzáférések

A Cloudflare felületén az **R2 Object Storage → Overview → Manage API tokens** alatt hozz létre **Object Read only** jogosultságú tokent, és korlátozd az `eon-meter-data` bucketre. Az **Access Key ID**, a **Secret Access Key** és az S3 végpont kerüljön a megfelelő `R2_*` mezőkbe. A végpont a fiókhoz tartozó S3 URL, a bucket neve nélkül. Ha a buckethez régióspecifikus végpont tartozik, azt add meg. [Cloudflare R2 dokumentáció](https://developers.cloudflare.com/r2/api/tokens/)

A Home Assistantban admin fiókkal a **Profil → Biztonság → Hosszú élettartamú hozzáférési tokenek** alatt hozz létre egy tokent. Másold a `HA_TOKEN` mezőbe. A Recorder importáló parancsa admin jogosultságot kér. A `HA_URL` olyan alap URL legyen, amelyet a konténer is elér. Ubuntu alatt ez lehet például a gép helyi hálózati címe vagy egy elérhető HTTPS-cím. Próbaüzemhez elegendőek az R2 beállításai. [Home Assistant hitelesítés](https://www.home-assistant.io/docs/authentication/)

## Telepítés Ubuntun

Docker Engine és a Compose bővítmény szükséges. Helyezd az importáló könyvtárát állandó útvonalra, például `/opt/eon-importer` alá. Innen futtasd a parancsokat.

```sh
umask 077
cp .env.example .env
chmod 600 .env
# Töltsd ki a .env fájlt. Az IMPORT_MODE maradjon dry-run.
docker compose build
docker compose run --rm eon-importer --dry-run
```

A Compose névvel ellátott kötetet csatol a `/state` útvonalra. A konténer nem root felhasználóval, csak olvasható gyökérfájlrendszerrel fut, és nem nyit portot. Tartsd meg ugyanazt a Compose-projektet és kötetet a futások között. A kötetről leállított importáló mellett készíts mentést. Az eredeti R2 e-mailekből újra felépíthető a mérési előzmény.

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

## Próbaüzem és éles ellenőrzés

1. Futtasd a `docker compose run --rm eon-importer --dry-run --since YYYY-MM-DD` parancsot egy ismert jelentés dátumával. Hasonlítsd össze a naplóban szereplő UTC-időtartományt és a két energiairány összegét a munkafüzettel. Átfedő jelentéseknél nézd meg a duplikációk és korrekciók számát is. Hibás mellékletnél a napló megadja az R2-kulcsot és a melléklet sorszámát.
2. Sikeres próbaüzem után állítsd a `.env` fájlban az `IMPORT_MODE` értékét `write`-ra. Futtass kézzel egy importot ugyanazzal a `--since` dátummal. Minden importált energiairánynál keresd a `statistics_confirmed` eseményt. Ekkor az importáló már visszaolvasta a megfelelő kumulatív értékeket a Recorderből.
3. A Home Assistantban nyisd meg a **Beállítások → Irányítópultok → Energia** beállításait. A hálózatról vételezett energiához válaszd az **E.ON grid import** (`eon:grid_import`) statisztikát, a visszatápláláshoz az **E.ON grid export** (`eon:grid_export`) statisztikát. Hasonlíts össze egy teljes napot vagy órát a jelentéssel.
4. Futtasd újra ugyanazt az importot. Változatlan bemenet esetén nulla függőben lévő statisztikának kell maradnia. Ezután ütemezheted a futást egy Docker-hozzáféréssel rendelkező felhasználó crontabjában.

Az alábbi példa óránként fut. A napló útvonalának írhatónak kell lennie. Ha a cron levélküldése be van állítva, hiba esetén rövid értesítést küld.

```cron
17 * * * * cd /opt/eon-importer && { /usr/bin/docker compose run --rm -T eon-importer >> /var/log/eon-importer.log 2>&1 || { status=$?; echo "E.ON import failed (exit $status). See /var/log/eon-importer.log."; exit "$status"; }; }
```

## Korrekciók és újrafuttatás

Az SQLite az energiairány és az intervallum UTC-kezdete alapján azonosítja a mérést. A mellékletek hash-e azonosítja az egyforma fájlokat különböző e-mailekben is. Módosult mérésnél az R2 `LastModified` szerint újabb érték nyer. Azonos módosítási idejű, eltérő értékek hibát okoznak. Ha egy későbbi jelentésből hiányzik egy már ismert mérés, a korábbi érték megmarad. Az R2-hibák és a feldolgozhatatlan mellékletek újrapróbálhatók. A futás akkor is hibakóddal zárul, ha közben más e-maileket sikerült feldolgozni.

Az importáló csak az adott irányhoz tartozó, négy külön negyedórát tartalmazó órákat küldi el. A hiányos órák mérései a helyi állapotban maradnak, amíg egy későbbi jelentés ki nem egészíti őket. Az órás `sum` az adott óra végéig mért kumulatív energia, az első teljes óra előtt nulláról indulva. Ha egy régi érték módosul vagy új óra kerül az előzménybe, az importáló újraszámolja és frissíti az érintett későbbi összegeket is.

A Home Assistant Core 2026.11.0 `recorder/import_statistics` WebSocket parancsa a külső statisztikákat az órák UTC-kezdete alapján írja vagy frissíti. Az Energia irányítópult választója támogatja az `energy` egységosztályú külső statisztikákat. Az importáló `kWh` egységgel, `has_sum: true` és `mean_type: 0` beállítással küldi őket. A két statisztikához nem tartozik szenzor-entitás. [Recorder parancs](https://github.com/home-assistant/core/blob/2026.11.0/homeassistant/components/recorder/websocket_api.py) · [Recorder frissítés](https://github.com/home-assistant/core/blob/2026.11.0/homeassistant/components/recorder/statistics.py) · [Energia választó](https://github.com/home-assistant/frontend/blob/dev/src/panels/config/energy/editors/ha-energy-grid-source-editor.ts)

A Recorder először az import sorba állítását igazolja vissza. Az importáló a köteg elküldése előtt törli a helyi visszaigazolást, majd az elvárt értékek sikeres visszaolvasása után újra rögzíti. Ha közben elszakad a kapcsolat vagy leáll a folyamat, a következő futás ugyanazokat az órákat újra elküldi. A két statisztikai azonosítót csak ez az importáló írja, és egy azonosítópárhoz egy írót futtass.

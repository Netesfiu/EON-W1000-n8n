# E.ON W1000 → n8n → Home Assistant (Spook) "integráció"

Ez a repó n8n workflow sablonokat tartalmaz tartalmaz, ami az E.ON portálról e-mailben érkező, **15 perces +A/-A** (import/export) adatokkal és a **1.8.0 / 2.8.0** napi mérőóra-állásokkállásokat tudja az ütemezett exportok alapján importálni a Homeassistant-be.
A csatolt **XLSX** fájlból kinyeri a szükséges oszlopokat, órára csoportosítja a negyedórás értékeket, majd:

* frissíti a **Spook/Recorder** statisztikáit `sensor.grid_energy_import` és `sensor.grid_energy_export` ID-k alatt, és
* beállítja az aktuális mérőóra-állást a `input_number.grid_import_meter` és `input_number.grid_export_meter` entitásokon.

> [!NOTE]
> A workflowkat szükséges lehet változtatni, amennyiben az EON által küldött ütemezett exportok kézbesítésében változás történik. Ha az exportált adatokban változás történik kérem, hogy [jelezd](https://github.com/Netesfiu/EON-W1000-n8n/issues/new)!

## Workflow sablonok
### [\[Netesfiu\] Alap workflow](/netesfiu/readme.md)
Ez a sablon egy workflow-ban kezeli a teljes folyamatot.

### [\[ZsBT\] három workflow](/zsbt/README.md)
Három külön workflow, hogy az Excel feldolgozás szükség szerint cserélhető legyen.

## Egyéb megoldások
### [\[prixeus\] Golang (docker-scratch)](/prixeus/README.md)

## Közreműködés
Ha szeretnéd a saját workflow-dat, vagy megoldásodat megosztani azt PR formájában megteheted a következő módon:
* Fork-old a repót
* Készíts egy új mappát a felhasználóneveddel
* A mappában mentsd le az általad készített megoldást:
  * Az n8n workflow esetén:
    * n8n-en belül a workflow nézetben: Ctrl-A, majd Ctrl-C
    * egy új `.json` file-ba pedig Ctrl-t
* Ha a beállításhoz szükséges készíts a mappában egy `readme` file-t.
* frissítsd ezt a `readme`-t a workflow sablonoknál:

```markdown
### [\[<FELHASZNÁLÓNÉV>\] <WORKFLOW_NEVE>](/<FELHASZNÁLÓNÉV>/README.md)
<workflow leírása>
```

> [!IMPORTANT]
> Győződj meg róla, hogy ha HTTP node-ot használsz nincsenek benne a saját hitelesítő adataid , mint pl. Bearer token (a Gmail, és Homeassistant node-ok nem osztják meg.)

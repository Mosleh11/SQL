# diagnostic.md — `explain()` et profiler

Base `citibike`, collection `trips` — 10 000 trajets Citi Bike NYC.

---

## Q31 — `explain("executionStats")` avant / après index

Requête analysée : `db.trips.find({ "start station id": 476 })`

| | Stage | `totalKeysExamined` | `totalDocsExamined` | `nReturned` | **Ratio docs/nReturned** | ms |
|---|---|---|---|---|---|---|
| **(a) Avant tout index** | `COLLSCAN` | 0 | **10 000** | 36 | **277,78** | 3 |
| **(b) Après `createIndex({ "start station id": 1 })`** | `FETCH ← IXSCAN` | 36 | **36** | 36 | **1,00** | 0 |
| **(c) + projection couvrante** | `PROJECTION_COVERED ← IXSCAN` | 36 | **0** | 36 | **0,00** | 0 |

```js
db.trips.createIndex({ "start station id": 1 })     // start station id_1
```

**(c) Analyse des ratios.**

Le ratio passe de **277,78 à 1,00** : sans index, le moteur lit **278 documents pour chaque
document utile** ; avec l'index, il ne lit **que ceux qu'il va renvoyer**.

**La valeur idéale est 1,00**, et c'est bien ce qu'on atteint ici — mais il faut comprendre
pourquoi ce n'est pas toujours le cas. Un ratio de 1 signifie « aucun document lu inutilement »,
ce qui suppose que l'index à lui seul identifie exactement l'ensemble des résultats. Dès que le
filtre porte sur un champ non indexé en plus du champ indexé, ou qu'un `$or` fait converger
plusieurs plans, le moteur remonte des documents qu'il écarte ensuite, et le ratio grimpe.

**Pourquoi on ne descend presque jamais en dessous de 1 sans projection :** parce que le stage
`FETCH` est obligatoire dès que la requête renvoie un champ absent de l'index. L'index ne
contient que `start station id` et le pointeur vers le document ; pour renvoyer le document
complet, il **faut** aller le chercher sur disque — un document lu par document renvoyé, soit
exactement 1,00.

La ligne (c) montre la seule façon de faire mieux : la **covered query**. En limitant la
projection aux champs présents dans l'index — et en excluant `_id`, sinon il faut aller le
chercher — le stage devient `PROJECTION_COVERED`, le `FETCH` disparaît et
**`totalDocsExamined` tombe à 0** : la collection n'est jamais touchée, tout est lu dans le
B-Tree. C'est le seul cas où le ratio descend sous 1.

```js
db.trips.find({ "start station id": 476 }, { _id: 0, "start station id": 1 })
```

---

## Q32 — Le profiler

```js
db.setProfilingLevel(1, { slowms: 0 })       // { was: 0, slowms: 100, sampleRate: 1, ok: 1 }

db.trips.find({ "end station name": "W 52 St & 9 Ave" }).toArray()      // 48 resultats
db.trips.aggregate([{ $group: { _id: "$usertype", n: { $sum: 1 } } }])

db.setProfilingLevel(0)                      // { was: 1, slowms: 0, sampleRate: 1, ok: 1 }
```

**Nombre d'entrées dans `db.system.profile` : 2.**

```js
db.system.profile.find({}, { op: 1, ns: 1, millis: 1, planSummary: 1, _id: 0 }).sort({ ts: 1 })
```

| `op` | `ns` | `millis` | `planSummary` |
|---|---|---|---|
| `query` | `citibike.trips` | 4 | **`COLLSCAN`** |
| `command` | `citibike.trips` | 8 | **`COLLSCAN`** |

**`planSummary` vaut `COLLSCAN` pour les deux opérations, et c'est toute l'information utile.**

Le champ résume en un mot le plan retenu par l'optimiseur. `COLLSCAN` signifie que la collection
a été **parcourue intégralement** : aucun index n'a servi. Pour le `find` sur
`end station name`, c'est attendu — je n'ai créé d'index que sur `start station id` (Q31), pas
sur ce champ-là. Pour l'agrégation, c'est structurel : un `$group` sans `$match` préalable doit
de toute façon voir tous les documents (c'est exactement le constat de la Q23).

Ce que cela m'apprend, et qui est le vrai intérêt du profiler : **je n'avais pas écrit ces deux
requêtes en pensant qu'elles seraient lentes.** `explain()` suppose que je sache *quelle*
requête analyser ; le profiler, lui, m'a montré **ce qui s'est réellement exécuté**, y compris
une requête que je n'aurais pas songé à examiner. Sur une base de 10 000 documents, 4 et 8 ms
sont indolores — sur 10 millions, ces deux `COLLSCAN` seraient les premières lignes du
tableau de bord d'incident.

Noter aussi que `millis` est plus élevé pour l'agrégation (8 ms) que pour le `find` (4 ms)
alors que l'agrégation ne renvoie que 2 documents : le coût est dans le **parcours**, pas dans
le volume renvoyé.

---

## Q33 — Les trois niveaux de profiling

| Niveau | Comportement |
|---|---|
| **0** | Profiler **désactivé** (défaut). Aucune écriture dans `system.profile`. |
| **1** | Enregistre **uniquement les opérations dépassant `slowms`** (100 ms par défaut). |
| **2** | Enregistre **toutes les opérations**, sans exception. |

**En production, j'utiliserais le niveau 1**, avec un `slowms` **abaissé à 50 ms** plutôt que
laissé à 100. L'argument est celui du rapport signal/bruit : à 100 ms on ne voit que les
requêtes déjà pathologiques, alors que la dégradation qui précède un incident se joue entre
30 et 100 ms. À 50 ms, on capture les requêtes qui *deviennent* lentes — celles sur lesquelles
on peut encore agir — tout en écrivant assez peu pour que le coût reste négligeable. Sur une
base à très fort trafic, on complète avec `sampleRate` (par exemple `0.1`) pour n'échantillonner
qu'une fraction des opérations lentes.

**Deux risques à laisser le niveau 2 activé sur une base chargée :**

1. **Le profiler écrit à chaque opération.** Chaque lecture engendre une écriture dans
   `system.profile` : on transforme une charge en lecture en charge en écriture, on consomme des
   IOPS, on pollue le cache WiredTiger, et l'on ajoute une latence à *toutes* les requêtes — y
   compris celles qui allaient bien. L'outil de mesure devient lui-même la cause du
   ralentissement, et le diagnostic tourne en rond.
2. **La collection est capped, donc elle écrase silencieusement.** Vérification :

   ```js
   db.system.profile.stats().capped     // true
   db.system.profile.stats().maxSize    // 1048576  (1 Mo)
   ```

   **`system.profile` est une collection *capped* de 1 Mo par défaut.** Au niveau 2 sur une base
   chargée, ce mégaoctet est rempli en quelques secondes, puis **écrasé en boucle**. Conséquence
   concrète : on cherche la requête lente signalée par les utilisateurs à 14 h 03, on ouvre
   `system.profile` à 14 h 10 — et elle a déjà disparu, remplacée par des milliers d'opérations
   sans intérêt. **Plus on enregistre, moins on garde.** Le niveau 2 est un outil de
   développement, à activer quelques secondes sur un environnement de test, jamais un réglage
   de production.

---

## Q34 — La requête de tableau de bord : les COLLSCAN lents

```js
const N = 50;   // seuil en millisecondes

db.system.profile.find(
  { planSummary: "COLLSCAN", millis: { $gte: N } },
  { op: 1, ns: 1, millis: 1, planSummary: 1, "command.filter": 1, ts: 1, _id: 0 }
).sort({ millis: -1 })
```

Résultat sur mes deux opérations (seuil abaissé à 0 pour qu'elles apparaissent, ma base étant
trop petite pour dépasser 50 ms) :

```js
[ { op: 'command', ns: 'citibike.trips', millis: 8, planSummary: 'COLLSCAN' },
  { op: 'query',   ns: 'citibike.trips', millis: 4, planSummary: 'COLLSCAN' } ]
```

C'est le croisement des deux critères qui en fait un indicateur exploitable, et non une simple
liste de requêtes lentes :

- **`planSummary: "COLLSCAN"`** isole les requêtes qui **n'utilisent aucun index** — donc celles
  dont le temps d'exécution croîtra **linéairement avec le volume de la collection**. Une
  requête lente qui utilise déjà un index est un problème de volume ou de matériel ; un
  `COLLSCAN` est un problème d'**index manquant**, c'est-à-dire un problème que l'on sait
  corriger.
- **`millis: { $gte: N }`** écarte les `COLLSCAN` sur de petites collections de configuration,
  parfaitement légitimes et qu'il serait absurde d'indexer.

Ce que renvoie cette requête est donc directement une **liste de tâches** : chaque ligne est un
index à créer. Le tri par `millis` décroissant met en tête celui qui rapportera le plus. En
production, on l'enrichit d'un `$group` par `ns` et par forme de filtre, pour compter les
occurrences — un `COLLSCAN` de 60 ms exécuté 10 000 fois par heure coûte bien plus cher qu'un
`COLLSCAN` de 3 secondes lancé une fois par nuit, et c'est le premier qu'il faut traiter.

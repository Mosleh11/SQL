# bench_shard.md — mesures du cluster shardé

Cluster : `cfg1` (config server, replica set `cfgRS`) · `shardA` · `shardB` · `mongos` (routeur).
Jeu : `census.zips` — 29 470 codes postaux US. Taille de chunk ramenée à **1 Mo**.

---

## Q2 — Distribution après `sh.shardCollection("census.zips", { state: 1 })`

```js
db.zips.getShardDistribution()
```

```
Shard shardA at shardA/shardA:27017
{ data: '2.15MiB', docs: 29470, chunks: 1,
  'estimated data per chunk': '2.15MiB', 'estimated docs per chunk': 29470 }
---
Shard shardB at shardB/shardB:27017
{ data: '1006KiB', docs: 9242, chunks: 1,
  'estimated data per chunk': '1006KiB', 'estimated docs per chunk': 9242 }
---
Totals
{ data: '3.13MiB', docs: 38712, chunks: 2,
  'Shard shardA': [ '68.68 % data', '76.12 % docs in cluster', '111B avg obj size on shard' ],
  'Shard shardB': [ '31.31 % data', '23.87 % docs in cluster', '111B avg obj size on shard' ] }
```

| | shardA | shardB |
|---|---|---|
| Chunks | 1 | 1 |
| Documents affichés | 29 470 | 9 242 |
| % documents | **76,12 %** | **23,87 %** |
| % données | 68,68 % | 31,31 % |

**Non, la répartition n'est pas équilibrée : 76 / 24.** Et le total affiché — **38 712 documents
pour 29 470 réellement importés** — est déjà un signal : `shardA` compte encore les 9 242
documents qu'il a migrés vers `shardB` mais n'a pas encore effacés. C'est le phénomène de la Q5.

---

## Q3 — Frontières de chunks

```js
const c = db.getSiblingDB("config");
const u = c.collections.findOne({ _id: "census.zips" }).uuid;
c.chunks.find({ uuid: u }).sort({ shard: 1 }).toArray().forEach(x => printjson(x.min, x.max));
```

```
{ shard: 'shardA', min: { state: 'KY' },       max: { state: MaxKey() } }
{ shard: 'shardB', min: { state: MinKey() },   max: { state: 'KY' } }
```

Affichage lisible :

```
shardA [KY     -> MaxKey]
shardB [MinKey -> KY]
```

**`MinKey` et `MaxKey`** sont les deux **valeurs sentinelles** de l'ordre BSON : `MinKey` est
strictement inférieure à toute valeur possible, `MaxKey` strictement supérieure. Elles bornent
l'espace de la shard key aux extrémités, garantissant que **tout document a exactement un
chunk d'accueil**, y compris un `state` qui n'existe pas encore dans le jeu (`"ZZ"` irait dans
le chunk `KY → MaxKey`). Les intervalles sont **semi-ouverts** : `[min, max)`.

**La coupure a été faite sur `KY`** (Kentucky). Ce n'est **pas** le milieu de l'alphabet — la
lettre médiane serait autour de M/N, et sur les 51 valeurs d'États triées, `KY` est en 18ᵉ
position seulement.

**Ce que le balancer a cherché à équilibrer, ce n'est donc pas l'alphabet ni le nombre d'États,
mais le volume de données.** Il coupe là où la masse se répartit le mieux : les États de `AK` à
`KY` pèsent ~1 Mo, ceux de `KY` à `WY` ~2,15 Mo. Le déséquilibre restant (68/31) vient de ce
qu'un seul chunk ne peut pas être coupé plus finement que ce que la clé permet.

---

## Q4 — Découper plus, est-ce rééquilibrer ?

```js
["FL","MI","NY","TX"].forEach(s => sh.splitAt("census.zips", { state: s }))
```

**(a) Chunks après les splits : 6** (2 + 4).

```
shardA [KY -> MI]
shardA [MI -> NY]
shardA [NY -> TX]
shardA [TX -> MaxKey]
shardB [MinKey -> FL]
shardB [FL -> KY]
```

**(b) Pourcentage de documents par shard**

| | shardA | shardB |
|---|---|---|
| Avant (Q2, 2 chunks) | 76,12 % | 23,87 % |
| Après (Q4, 6 chunks) | **76,12 %** | **23,87 %** |
| **Déplacement** | **0,00 point** | **0,00 point** |

**Il n'a pas bougé d'un seul point** — vérifié à deux reprises, à 70 s puis à 160 s après les
splits, pour laisser au balancer le temps d'agir.

**(c) Explication**

Nombre de codes postaux par État :

```js
db.zips.aggregate([{ $group: { _id: "$state", n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: 5 }])
```

| État | Codes postaux |
|---|---|
| TX | **1 676** |
| NY | 1 596 |
| CA | 1 523 |
| PA | 1 458 |
| IL | 1 240 |

**Découper n'est pas rééquilibrer.** Le `splitAt` ne fait que redessiner des frontières
*logiques* dans les métadonnées ; seul le **balancer** déplace réellement les données, et il ne
déplace **jamais moins d'un chunk entier**. Or la granularité minimale d'un chunk est celle de
la shard key : avec `{ state: 1 }`, **un chunk ne peut pas être plus petit qu'un État**.

Quand un seul État pèse plus qu'un chunk — TX, 1 676 documents, largement au-delà du
`chunksize` de 1 Mo — le balancer se retrouve devant un **jumbo chunk** : indivisible, car il
n'existe aucune valeur de `state` *à l'intérieur* de `TX` sur laquelle couper. Il ne peut ni le
découper, ni le déplacer utilement, et le déséquilibre devient **structurel**.

C'est la limite fondamentale d'une shard key à **faible cardinalité** : le nombre maximal de
chunks est plafonné par le nombre de valeurs distinctes de la clé (ici 51). Aucune quantité de
`splitAt` ne le contournera. La réponse n'est pas de découper davantage, mais **de changer de
clé** — soit une clé hachée (Q8), soit une clé composée `{ state: 1, zip: 1 }` qui rend
possible une coupure *à l'intérieur* d'un État.

---

## Q5 — Le piège du comptage

**(a)**

```js
db.zips.countDocuments({})          // 29470
db.zips.estimatedDocumentCount()    // 38712
```

**Écart : 38 712 − 29 470 = 9 242 documents.**

**(b)** Ce nombre est **exactement celui affiché pour `shardB` en Q2** (9 242 documents). Autrement
dit, le cluster compte deux fois les documents migrés : une fois sur `shardB` où ils vivent
désormais, une fois sur `shardA` où ils n'ont pas encore été effacés. Vérification par connexion
directe à chaque shard :

```
shardA local : 29470     <- 20 228 documents légitimes + 9 242 orphelins
shardB local :  9242
```

**(c)** Le phénomène s'appelle les **documents orphelins** (*orphaned documents*) : des documents
restés sur le shard d'origine après une migration de chunk, alors qu'ils appartiennent
désormais à un autre shard.

- **À bannir sur un cluster shardé : `estimatedDocumentCount()`.** Elle lit les **métadonnées de
  collection de chaque shard** (compteur rapide, `count` local) et additionne, sans filtrer par
  appartenance de chunk : elle compte donc les orphelins. Elle est rapide, mais **fausse**.
- **`countDocuments()` est correcte mais plus coûteuse** : c'est une agrégation
  (`$group`/`$sum`) qui parcourt réellement les documents et applique un **filtre de shard**
  (`shard filter`) écartant ceux qui n'appartiennent plus au shard interrogé. On paie un scan
  pour obtenir un chiffre juste.

**(d) Prédiction écrite avant vérification.** `orphanCleanupDelaySecs` vaut **900 secondes
(15 minutes)** — valeur relevée sur le shard :

```js
db.adminCommand({ getParameter: 1, orphanCleanupDelaySecs: 1 })   // { orphanCleanupDelaySecs: 900, ok: 1 }
```

> **Prédiction :** quinze minutes après la migration, le `rangeDeleter` aura supprimé les 9 242
> orphelins de `shardA`. `countDocuments()` renverra toujours **29 470** (elle était déjà juste),
> et `estimatedDocumentCount()` **convergera vers 29 470** ; l'écart passera de 9 242 à **0**.

```
14:42:17  countDocuments : 29470 | estimated : 38712 | shardA local : 29470   (écart 9242)
14:45:21  countDocuments : 29470 | estimated : 38712 | shardA local : 29470   (écart 9242)
14:51:18  countDocuments : 29470 | estimated : 29470 | shardA local : 20228   (écart 0)
```

**Prédiction confirmée, à la minute près.** À 14:51:18, soit environ 15 minutes après la
migration, le `rangeDeleter` a purgé les orphelins : `shardA` passe de **29 470 à 20 228**
documents locaux, exactement **9 242 de moins**, et `estimatedDocumentCount()` converge sur
**29 470**. L'écart est tombé à **0** sans qu'aucune commande ne soit lancée, sans trace dans
les logs applicatifs, et sans que rien ne signale que le chiffre précédent était faux.

(Détail dans `reponses_jour4.md`, Q5(d).)

**Pourquoi une anomalie qui disparaît d'elle-même est plus dangereuse qu'une anomalie
permanente :** parce qu'elle est **irreproductible**. Une anomalie permanente est constatée,
reproduite, corrigée. Celle-ci, non : le développeur voit 38 712 sur son écran, alerte l'équipe,
et quand quelqu'un vérifie vingt minutes plus tard, le chiffre est redevenu juste. Le bug est
classé « non reproductible », personne ne corrige `estimatedDocumentCount()` — et il reviendra à
**chaque migration de chunk**, c'est-à-dire précisément lors des rééquilibrages, donc en période
de forte croissance. Un compteur faux par intermittence est plus toxique qu'un compteur
constamment faux : le second finit par être corrigé, le premier détruit la confiance dans
l'outil de mesure sans jamais être attribué à sa cause.

---

## Q6 / Q7 — Targeted vs broadcast

```js
db.zips.find({ state: "NY" }).explain("executionStats")        // filtre = la shard key
db.zips.find({ city:  "NEW YORK" }).explain("executionStats")  // filtre = un autre champ
```

| | `{ state: "NY" }` | `{ city: "NEW YORK" }` |
|---|---|---|
| **Stage racine `winningPlan`** | **`SINGLE_SHARD`** | **`SHARD_MERGE`** |
| **Shards interrogés** | `[shardA]` — **1** | `[shardB, shardA]` — **2** |
| `nReturned` | 1 596 | 40 |
| `totalDocsExamined` | **1 596** | **38 712** |
| `totalKeysExamined` | 1 596 | 0 |
| `executionTimeMillis` | 3 | 10 |
| Détail par shard | shardA : 1 596 | shardB : **0** · shardA : 40 |

**(a)** La première est **targeted**, la seconde est **broadcast** (scatter-gather).

Le signe est double et sans ambiguïté :
1. **Le nom du stage racine.** `SINGLE_SHARD` signifie que `mongos` a su, à partir de la seule
   valeur du filtre, dans quel chunk — donc sur quel shard — vit la donnée : il n'a interrogé
   que celui-là. `SHARD_MERGE` signifie qu'il a interrogé tous les shards et **fusionné** leurs
   réponses.
2. **Le contenu de `winningPlan.shards`.** `[shardA]` pour la première, `[shardB, shardA]` pour
   la seconde.

Le détail par shard est éloquent : **`shardB` a renvoyé 0 document**. Il a parcouru toute sa
part de collection pour ne rien trouver — travail intégralement gaspillé, mais que le client a
dû attendre.

**(b) Ratio pour la requête broadcast**

```
totalDocsExamined / nReturned = 38 712 / 40 = 967,8
```

**Près de 968 documents lus pour chaque document utile.**

**(c) Extrapolation à 20 shards et 500 millions de documents**

| | Valeur |
|---|---|
| Machines mobilisées | **20 sur 20** — la totalité du cluster |
| Documents lus | **500 000 000** |
| Documents utiles (même sélectivité) | ~516 |

**Ce que cela dit de la scalabilité d'un cluster mal shardé : elle est nulle, et pire encore,
elle est négative.** Une requête broadcast mobilise *tout* le cluster ; sa latence est celle du
**shard le plus lent**, et le nombre de requêtes simultanées que le cluster peut traiter ne
dépend plus du nombre de machines mais de la capacité de chacune à absorber *toutes* les
requêtes. Ajouter un 21ᵉ shard ne fait alors qu'**ajouter un participant de plus à chaque
requête** : on augmente la latence moyenne et la probabilité qu'un nœud traîne, sans augmenter
le débit.

C'est le paradoxe à retenir : **avec une mauvaise shard key, on paie tout le coût du sharding
— complexité, machines, orphelins, opérations — sans en obtenir le bénéfice.** Un simple
Replica Set aurait été plus rapide.

---

## Q8 — La clé hachée

```js
sh.shardCollection("census.zips_hashed", { _id: "hashed" })   // collection encore vide
docker exec mongos mongoimport --db census --collection zips_hashed --file /tmp/zips.json
```

```
Shard shardA : { data: '1.54MiB', docs: 14517, chunks: 2 }
Shard shardB : { data: '1.58MiB', docs: 14953, chunks: 2 }
---
Totals
{ data: '3.13MiB', docs: 29470, chunks: 4,
  'Shard shardA': [ '49.26 % data', '49.26 % docs in cluster' ],
  'Shard shardB': [ '50.73 % data', '50.73 % docs in cluster' ] }
```

| | shardA | shardB |
|---|---|---|
| Documents | 14 517 | 14 953 |
| % documents | **49,26 %** | **50,73 %** |
| Chunks | 2 | 2 |

**4 chunks, sans aucun `splitAt` manuel**, et une répartition à **1,5 point d'écart** contre
52 points pour `{ state: 1 }`.

**Pourquoi le hachage donne d'emblée cette répartition — le *pre-splitting*.** Quand on shard
une collection **vide** sur une clé hachée, MongoDB sait que la fonction de hachage distribue
les valeurs uniformément sur tout l'espace des `int64`. Il n'a donc pas besoin d'observer les
données : il **découpe immédiatement** l'espace de hachage en intervalles égaux (par défaut
2 chunks par shard) et les répartit sur les shards **avant le moindre insert**. Chaque document
importé tombe ensuite dans un chunk quasi au hasard — d'où l'équilibre immédiat, sans
migration.

C'est aussi ce qui explique le point suivant.

**Comparaison des deux comptages sur la collection hachée :**

```js
db.zips_hashed.countDocuments({})         // 29470
db.zips_hashed.estimatedDocumentCount()   // 29470
```

**L'écart de la Q5 n'existe pas ici : 0 orphelin.** La raison est directe : les orphelins sont
un **résidu de migration**. Grâce au pre-splitting, les chunks étaient déjà à leur place
définitive avant l'import — **aucun chunk n'a jamais été déplacé**, donc aucun document n'a été
laissé derrière. `census.zips`, à l'inverse, a été shardée **après** l'import : les 9 242
documents ont dû traverser le réseau, et leurs copies d'origine attendent la purge.

Leçon d'exploitation : **sharder une collection vide, jamais une collection déjà remplie**, si
on en a le choix.

---

## Q9 — Le compromis, prouvé puis arbitré

```js
db.zips_hashed.find({ state: "NY" }).explain("executionStats")
```

| | `census.zips` (`{ state: 1 }`) | `census.zips_hashed` (`{ _id: "hashed" }`) |
|---|---|---|
| **Stage racine** | **`SINGLE_SHARD`** | **`SHARD_MERGE`** |
| Shards interrogés | `[shardA]` | `[shardA, shardB]` |
| `nReturned` | 1 596 | 1 596 |
| `totalDocsExamined` | **1 596** | **29 470** |
| Ratio | 1,0 | **18,5** |
| ms | 3 | 6 |

**(a)** Non, le stage racine n'est **pas** le même : `SHARD_MERGE` au lieu de `SINGLE_SHARD`.
La requête métier la plus courante est devenue **broadcast**, et lit **18,5 fois** le volume
utile.

> **Le compromis fondamental du sharding, en une phrase :** une shard key ne peut pas être à la
> fois parfaitement distribuée et parfaitement ciblée — ce qui rend l'écriture équilibrée
> (le hachage, qui disperse) est exactement ce qui rend la lecture non ciblée (la localité
> perdue), et l'on doit donc choisir en fonction de la requête que l'on veut protéger.

**(b) Tableau de décision**

| Shard key candidate | Cardinalité | Distribution mesurée | Requêtes métier ciblées ? | Verdict |
|---|---|---|---|---|
| `{ state: 1 }` | **51 valeurs** — faible | **76,12 / 23,87** (Q2), inchangée après 4 splits (Q4) | **Oui** — `SINGLE_SHARD`, 1 596 docs examinés (Q6) | ❌ **Rejetée.** Ciblage parfait, mais cardinalité trop faible : jumbo chunks (TX = 1 676 docs), déséquilibre structurel que le balancer ne peut pas corriger. |
| `{ _id: "hashed" }` | **29 470** — maximale | **49,26 / 50,73** (Q8), pre-splitting, 0 orphelin | **Non** — `SHARD_MERGE`, 29 470 docs examinés pour 1 596 utiles (Q9) | ⚠️ **Acceptable par défaut.** Idéale pour l'écriture et l'équilibrage ; toute requête par État devient broadcast. À retenir si la charge est dominée par les accès unitaires par `_id`. |
| `{ zip: 1 }` | **29 467** pour 29 470 documents (Q4 du Jour 3) — quasi maximale | Excellente en théorie (valeurs uniformément réparties) | Ciblée **uniquement** si l'on filtre par `zip` ; les requêtes par État restent broadcast | ⚠️ **Piège.** Le champ **n'est pas unique** : 3 doublons (`63673`, `42223`, `32350`, codes à cheval sur deux États). L'index unique échoue en `DuplicateKey`. Utilisable comme shard key non unique, mais inutile pour la requête métier réelle. |
| `{ state: 1, zip: 1 }` | **51 × ~578** — élevée | Bonne : la coupure peut désormais se faire **à l'intérieur** d'un État, donc plus de jumbo chunk | **Oui** — le préfixe `state` suffit à cibler : une requête filtrant seulement sur `state` reste **targeted** | ✅ **Retenue.** |

**Verdict argumenté.** Je recommande **`{ state: 1, zip: 1 }`**. Elle combine les deux
propriétés que les trois autres n'obtiennent que séparément :

- **Le ciblage de `{ state: 1 }`.** Une shard key composée est utilisable **par préfixe** :
  `mongos` sait router `{ state: "NY" }` sans connaître `zip`, exactement comme avec
  `{ state: 1 }`. La requête métier de la Q6 reste `SINGLE_SHARD`.
- **La cardinalité qui manquait.** Le second champ multiplie les valeurs distinctes par ~578 :
  le chunk `TX` de la Q4, indivisible avec `{ state: 1 }`, devient coupable en
  `{state:"TX", zip:"75001"} → {state:"TX", zip:"79999"}`. **Le jumbo chunk disparaît, le
  balancer retrouve sa marge de manœuvre.**

Réserve à documenter : la clé reste **monotone par État** — un import massif concentré sur un
seul État créerait un point chaud temporaire en écriture. Sur cette base (référentiel
géodémographique en lecture quasi exclusive, mis à jour à chaque recensement), c'est sans
conséquence. Sur une base transactionnelle, on privilégierait
`{ state: 1, zip: "hashed" }`.

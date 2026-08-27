# TP Jour 4 — Sharding appliqué, Performances & Diagnostic

**Mohammed Monsleh** — MIA4 · Conception et intégration d'un SGBD NoSQL — IPSSI

- **Partie A** — cluster shardé (`cfg1`, `shardA`, `shardB`, `mongos`), jeu `census.zips` (29 470 codes postaux US)
- **Partie B** — instance simple `mongo-j4`, jeu `citibike.trips` (10 000 trajets Citi Bike NYC)

> Les mesures de sharding sont détaillées dans **[`bench_shard.md`](bench_shard.md)**, les
> mesures de diagnostic dans **[`diagnostic.md`](diagnostic.md)**. Les pipelines sont dans
> **[`pipelines.js`](pipelines.js)** et **[`geo.js`](geo.js)**.

---

# PARTIE A — Sharding appliqué

## A0 — Monter le cluster

```bash
docker compose -f docker-compose.shard.yml up -d
docker exec cfg1   mongosh --quiet --eval "rs.initiate({_id:'cfgRS',configsvr:true,members:[{_id:0,host:'cfg1:27017'}]})"
docker exec shardA mongosh --quiet --eval "rs.initiate({_id:'shardA',members:[{_id:0,host:'shardA:27017'}]})"
docker exec shardB mongosh --quiet --eval "rs.initiate({_id:'shardB',members:[{_id:0,host:'shardB:27017'}]})"
docker exec mongos mongosh --quiet --eval "sh.addShard('shardA/shardA:27017'); sh.addShard('shardB/shardB:27017')"
docker exec mongos mongosh --quiet config --eval "db.settings.updateOne({_id:'chunksize'},{\$set:{value:1}},{upsert:true})"
```

```
shards
[ { _id: 'shardA', host: 'shardA/shardA:27017', state: 1 },
  { _id: 'shardB', host: 'shardB/shardB:27017', state: 1 } ]
active mongoses : [ { '7.0.40': 1 } ]
balancer : { 'Currently enabled': 'yes', 'Currently running': 'no' }
```

### Q1 — Rôle des 4 conteneurs

| Conteneur | Rôle |
|---|---|
| **`cfg1`** | **Config server** (replica set `cfgRS`, lancé avec `--configsvr`). Détient la base `config` : liste des shards, collections shardées, shard keys, et surtout **la carte des chunks** — quel intervalle de valeurs vit sur quel shard. |
| **`shardA`, `shardB`** | **Shards** (lancés avec `--shardsvr`). Ce sont eux qui stockent réellement les documents, chacun sa part. En production, chaque shard est lui-même un Replica Set (cf. R2 du Jour 3). |
| **`mongos`** | **Routeur**. Point d'entrée unique des clients. Il télécharge la carte des chunks depuis `cfg1`, la met en cache, et aiguille chaque requête vers le ou les shards concernés, puis fusionne les réponses. |

- **Celui qui stocke la carte « tel intervalle vit sur tel shard » : `cfg1`**, dans la
  collection `config.chunks` — c'est elle que j'interroge en Q3.
- **Celui qui n'héberge aucune donnée : `mongos`.** Il est entièrement **stateless** : sa seule
  mémoire est un cache de métadonnées qu'il peut reconstruire à tout instant depuis `cfg1`.
  C'est ce qui permet d'en déployer plusieurs sans coordination — d'où la recommandation d'en
  avoir au moins deux en production, pour éviter un point de panne unique.

**Pourquoi réduire les chunks de 128 Mo à 1 Mo est indispensable ici :** le jeu entier ne pèse
que **3,13 Mo**. Avec la taille par défaut, la collection tiendrait dans **un seul chunk** —
indivisible, donc jamais migré : on observerait 100 % des données sur un shard et 0 % sur
l'autre, et **le TP n'aurait rien à mesurer**. À 1 Mo, le jeu se découpe en plusieurs chunks et
le balancer a de quoi travailler.

**Pourquoi ce serait une très mauvaise idée en production**, pour trois raisons qui
s'additionnent :

1. **Explosion du nombre de chunks.** Une collection de 500 Go donnerait 500 000 chunks au lieu
   de 4 000. La carte stockée sur les config servers enfle d'autant, chaque `mongos` doit la
   charger et la tenir en cache, et chaque changement de version de métadonnées force un
   rafraîchissement plus coûteux.
2. **Migrations permanentes.** Le balancer déclenche une migration dès qu'il constate un
   déséquilibre en nombre de chunks. Avec des chunks minuscules, le moindre insert suffit à
   franchir le seuil : le cluster passe son temps à déplacer des données au lieu de servir les
   requêtes — chaque migration consommant du réseau, du CPU, et **produisant des orphelins**
   (Q5).
3. **Dégradation du routage.** Plus il y a de chunks, plus la table de routage est longue à
   parcourir pour chaque requête, et plus la fenêtre pendant laquelle un `mongos` travaille sur
   une carte périmée est fréquente.

La valeur par défaut de 128 Mo est un compromis : assez petit pour que le balancer ait de la
granularité, assez grand pour que les migrations restent rares.

---

## A1 — Sharder sur `state`

```js
sh.enableSharding("census")
db.zips.createIndex({ state: 1 })            // obligatoire : la shard key doit etre indexee
sh.shardCollection("census.zips", { state: 1 })   // { collectionsharded: 'census.zips', ok: 1 }
```

### Q2 — Distribution

| | shardA | shardB |
|---|---|---|
| Chunks | 1 | 1 |
| Documents affichés | 29 470 | 9 242 |
| **% documents** | **76,12 %** | **23,87 %** |

**Non, ce n'est pas équilibré : 76 / 24.** Sortie complète dans
[`bench_shard.md`](bench_shard.md). Le total affiché (**38 712** pour 29 470 importés) annonce
déjà le problème de la Q5.

### Q3 — Frontières de chunks

```
shardA [KY     -> MaxKey]
shardB [MinKey -> KY]
```

**`MinKey` / `MaxKey`** sont les sentinelles de l'ordre BSON : inférieure et supérieure à toute
valeur possible. Elles bornent l'espace de la shard key pour qu'aucun document ne soit sans
chunk d'accueil — y compris une valeur qui n'existe pas encore.

**La coupure est faite sur `KY`, qui n'est pas le milieu de l'alphabet** (18ᵉ des 51 États
triés). **Le balancer n'équilibre ni l'alphabet ni le nombre d'États : il équilibre le volume de
données.**

### Q4 — Découper plus, est-ce rééquilibrer ?

**(a) 6 chunks** après les 4 `splitAt`.

**(b)**

| | shardA | shardB |
|---|---|---|
| Avant (Q2) | 76,12 % | 23,87 % |
| Après (Q4) | **76,12 %** | **23,87 %** |
| Déplacement | **0,00 point** | **0,00 point** |

Vérifié deux fois, à 70 s puis 160 s après les splits.

**(c)** Codes postaux par État : **TX 1 676**, NY 1 596, CA 1 523, PA 1 458, IL 1 240.

Le `splitAt` ne redessine que des frontières **logiques** dans les métadonnées ; seul le
**balancer** déplace des données, et **jamais moins d'un chunk entier**. Avec `{ state: 1 }`,
un chunk ne peut pas être plus petit qu'un État : quand un seul État pèse plus qu'un chunk (TX,
1 676 documents, au-delà du `chunksize` de 1 Mo), on obtient un **jumbo chunk** — indivisible,
faute d'une valeur de `state` *à l'intérieur* de `TX` sur laquelle couper.

**C'est la limite d'une shard key à faible cardinalité : le nombre maximal de chunks est
plafonné par le nombre de valeurs distinctes de la clé** (51 ici). Aucun `splitAt` ne le
contourne — il faut changer de clé (Q9b).

---

## A2 — Le piège du comptage

### Q5

**(a)**

```js
db.zips.countDocuments({})          // 29470
db.zips.estimatedDocumentCount()    // 38712
```

**Écart : 9 242.**

**(b)** C'est **exactement le nombre de documents affiché pour `shardB` en Q2**. Confirmé par
connexion directe aux shards :

```
shardA local : 29470     <- 20 228 documents légitimes + 9 242 orphelins
shardB local :  9242
```

`shardA` compte encore les documents qu'il a migrés vers `shardB` mais pas encore effacés.

**(c)** Le phénomène s'appelle les **documents orphelins** (*orphaned documents*).

- **À bannir sur un cluster shardé : `estimatedDocumentCount()`.** Elle additionne les
  compteurs de métadonnées de chaque shard sans filtrer par appartenance de chunk : elle
  **compte les orphelins**. Rapide, mais fausse.
- **`countDocuments()` est correcte et plus coûteuse** : c'est une agrégation qui parcourt les
  documents en appliquant un **filtre de shard** écartant ceux qui n'appartiennent plus au shard
  interrogé. On paie un scan pour un chiffre juste.

**(d) Prédiction, écrite avant vérification.**

```js
db.adminCommand({ getParameter: 1, orphanCleanupDelaySecs: 1 })
// { orphanCleanupDelaySecs: 900, ok: 1 }
```

**900 secondes = 15 minutes.**

> **Prédiction :** quinze minutes après la migration, le `rangeDeleter` aura purgé les 9 242
> orphelins de `shardA`. `countDocuments()` renverra toujours 29 470 (elle était déjà juste) et
> `estimatedDocumentCount()` convergera vers **29 470** — écart ramené de 9 242 à **0**.

**Vérification en fin de séance** (cluster resté allumé pendant toute la Partie B) :

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

**Pourquoi une anomalie qui disparaît d'elle-même est plus dangereuse qu'une anomalie
permanente :** parce qu'elle est **irreproductible**. Un développeur voit 38 712, alerte
l'équipe ; vingt minutes plus tard quelqu'un vérifie, le chiffre est juste, le ticket est classé
« non reproductible ». Personne ne corrige l'appel à `estimatedDocumentCount()` — et il
refaussera les chiffres à **chaque migration de chunk**, c'est-à-dire précisément pendant les
rééquilibrages, donc en période de forte croissance. Un compteur faux par intermittence détruit
la confiance dans l'outil de mesure sans jamais être attribué à sa cause ; un compteur
constamment faux, lui, finit par être corrigé.

---

## A3 — Targeted vs broadcast

### Q6

| | `{ state: "NY" }` | `{ city: "NEW YORK" }` |
|---|---|---|
| Stage racine `winningPlan` | **`SINGLE_SHARD`** | **`SHARD_MERGE`** |
| Shards interrogés | `[shardA]` | `[shardB, shardA]` |
| `nReturned` | 1 596 | 40 |
| `totalDocsExamined` | **1 596** | **38 712** |
| ms | 3 | 10 |
| Par shard | shardA : 1 596 | shardB : **0** · shardA : 40 |

### Q7

**(a)** La première est **targeted**, la seconde **broadcast** (scatter-gather).

Deux signes concordants : **le stage racine** (`SINGLE_SHARD` contre `SHARD_MERGE`) et **le
contenu de `winningPlan.shards`** (`[shardA]` contre `[shardB, shardA]`). Détail parlant :
**`shardB` a renvoyé 0 document** — il a parcouru toute sa part pour rien, mais le client a
attendu.

**(b)** `38 712 / 40 = ` **967,8 documents lus par document utile.**

**(c) Extrapolation à 20 shards et 500 millions de documents**

| | Valeur |
|---|---|
| Machines mobilisées | **20 sur 20** |
| Documents lus | **500 000 000** |
| Documents utiles (même sélectivité) | ~516 |

**Ce que cela dit de la scalabilité d'un cluster mal shardé : elle est nulle, et même
négative.** Une requête broadcast mobilise tout le cluster, sa latence est celle du **shard le
plus lent**, et le débit ne dépend plus du nombre de machines mais de la capacité de chacune à
absorber *toutes* les requêtes. Ajouter un 21ᵉ shard **ajoute un participant de plus à chaque
requête** : on augmente la latence moyenne et le risque qu'un nœud traîne, sans gagner en débit.
On paie tout le coût du sharding sans aucun de ses bénéfices — un simple Replica Set aurait été
plus rapide.

---

## A4 — La clé hachée et le compromis

### Q8

```js
sh.shardCollection("census.zips_hashed", { _id: "hashed" })    // collection encore vide
```

| | shardA | shardB |
|---|---|---|
| Documents | 14 517 | 14 953 |
| **% documents** | **49,26 %** | **50,73 %** |
| Chunks | 2 | 2 |

**4 chunks sans aucun `splitAt` manuel**, et **1,5 point** d'écart contre 52 points pour
`{ state: 1 }`.

**Le *pre-splitting*.** Sharder une collection **vide** sur une clé hachée permet à MongoDB de
se passer d'observer les données : la fonction de hachage distribuant uniformément sur l'espace
des `int64`, il **découpe immédiatement** cet espace en intervalles égaux (2 chunks par shard
par défaut) et les répartit **avant le moindre insert**. Chaque document tombe ensuite dans un
chunk quasi au hasard — équilibre immédiat, sans migration.

**Comparaison des comptages :**

```js
db.zips_hashed.countDocuments({})         // 29470
db.zips_hashed.estimatedDocumentCount()   // 29470
```

**L'écart de la Q5 n'existe pas : 0 orphelin.** Les orphelins sont un **résidu de migration** ;
ici, grâce au pre-splitting, **aucun chunk n'a jamais été déplacé**. `census.zips` a au
contraire été shardée *après* l'import : 9 242 documents ont dû traverser le réseau et leurs
copies d'origine attendent la purge. D'où la règle d'exploitation : **sharder une collection
vide, jamais une collection déjà remplie**, quand on a le choix.

### Q9

```js
db.zips_hashed.find({ state: "NY" }).explain("executionStats")
```

| | `census.zips` (`{ state: 1 }`) | `census.zips_hashed` (`{ _id: "hashed" }`) |
|---|---|---|
| Stage racine | **`SINGLE_SHARD`** | **`SHARD_MERGE`** |
| `nReturned` | 1 596 | 1 596 |
| `totalDocsExamined` | **1 596** | **29 470** |
| Ratio | 1,0 | **18,5** |

**(a)** Non, le stage racine n'est pas le même. La requête métier la plus courante devient
**broadcast** et lit **18,5 fois** le volume utile.

> **Le compromis fondamental du sharding :** une shard key ne peut pas être à la fois
> parfaitement distribuée et parfaitement ciblée — ce qui rend l'écriture équilibrée (le
> hachage, qui disperse) est exactement ce qui rend la lecture non ciblée (la localité perdue).

**(b) Tableau de décision** — version complète dans [`bench_shard.md`](bench_shard.md).

| Shard key | Cardinalité | Distribution mesurée | Requêtes ciblées ? | Verdict |
|---|---|---|---|---|
| `{ state: 1 }` | 51 — faible | 76,12 / 23,87, inchangée après splits | Oui (`SINGLE_SHARD`) | ❌ Jumbo chunks, déséquilibre structurel |
| `{ _id: "hashed" }` | 29 470 — maximale | **49,26 / 50,73**, 0 orphelin | Non (`SHARD_MERGE`, 18,5×) | ⚠️ Par défaut si accès par `_id` |
| `{ zip: 1 }` | 29 467 / 29 470 | Bonne en théorie | Seulement si filtre sur `zip` | ⚠️ **Non unique** : 3 doublons (Jour 3 Q4) |
| `{ state: 1, zip: 1 }` | 51 × ~578 — élevée | Coupure possible **dans** un État | **Oui**, par préfixe | ✅ **Retenue** |

**Verdict : `{ state: 1, zip: 1 }`.** Elle réunit ce que les autres n'ont que séparément. Une
shard key composée est utilisable **par préfixe** : `mongos` route `{ state: "NY" }` sans
connaître `zip`, donc la requête métier reste `SINGLE_SHARD`. Et le second champ multiplie les
valeurs distinctes par ~578 : le chunk `TX`, indivisible avec `{ state: 1 }`, devient coupable
en `{state:"TX", zip:"75001"} → {state:"TX", zip:"79999"}` — **le jumbo chunk disparaît**.

Réserve documentée : la clé reste **monotone par État**, donc un import massif concentré sur un
seul État créerait un point chaud temporaire. Sans conséquence sur un référentiel en lecture
quasi exclusive ; sur une base transactionnelle, on prendrait `{ state: 1, zip: "hashed" }`.

---

# PARTIE B — Performances & diagnostic

## B0 — Import

```bash
docker compose up -d
curl -L -o trips.json https://raw.githubusercontent.com/neelabalan/mongodb-sample-dataset/main/sample_training/trips.json
wc -l trips.json                    # 10000
docker cp trips.json mongo-j4:/tmp/trips.json
docker exec mongo-j4 mongoimport -u admin -p ipssi2025 --authenticationDatabase admin \
  --db citibike --collection trips --drop --file /tmp/trips.json
```

```
10000 document(s) imported successfully. 0 document(s) failed to import.
```

**Point de contrôle B0 : `db.trips.countDocuments({})` = 10000** OK

```js
{
  _id: ObjectId('572bb8222b288919b68abf6c'),
  tripduration: 888,
  'start station id': 284,                    // <-- espaces dans le nom
  'start station name': 'Greenwich Ave & 8 Ave',
  'end station id': 439,
  'end station name': 'E 4 St & 2 Ave',
  bikeid: 15082,
  usertype: 'Subscriber',
  'birth year': 1982,
  gender: 1,
  'start station location': { type: 'Point', coordinates: [ -74.0026376103, 40.7390169121 ] },
  'end station location':   { type: 'Point', coordinates: [ -73.98978041,   40.7262807   ] },
  'start time': ISODate('2016-01-01T00:08:47.000Z'),
  'stop time':  ISODate('2016-01-01T00:23:36.000Z')
}
```

### Q10 — Les espaces dans les noms de champs

Conséquence concrète : **tout nom de champ contenant un espace doit être entre guillemets**, à
la fois comme clé d'objet et dans les expressions `$`.

**(a) Filtre `find` :**

```js
db.trips.find({ "start station id": 476 })          // correct
```

**(b) Référence dans un `$group` :**

```js
{ $group: { _id: "$start station id", n: { $sum: 1 } } }    // correct
```

Ici les guillemets sont doublement nécessaires : ceux de la clé JSON, et ceux qui entourent
`"$start station id"` — la référence de champ est de toute façon une chaîne.

**Si on oublie les guillemets**, ce n'est même pas une erreur MongoDB, c'est une **erreur de
syntaxe JavaScript**, levée avant que la requête ne parte :

```js
db.trips.find({ start station id: 476 })
// SyntaxError : Unexpected identifier 'station'
```

L'interpréteur lit `start` comme une clé, puis tombe sur `station` sans séparateur. C'est le cas
favorable — l'erreur est bruyante et immédiate. Le cas dangereux serait un champ dont l'oubli
produirait du JavaScript valide mais faux ; on retrouve exactement le même risque en agrégation,
où `"$start station id"` mal orthographié ne lève **aucune erreur** et regroupe silencieusement
tout sous `_id: null`.

### Q11 — Plage temporelle

```js
db.trips.aggregate([{ $group: { _id: null, debut: { $min: "$start time" }, fin: { $max: "$stop time" } } }])
```

```
premier depart : 2016-01-01T00:00:41.000Z
dernier retour : 2016-01-05T21:47:46.000Z
```

**Le jeu s'annonce comme « janvier 2016 » ; en réalité il ne couvre que les 1ᵉʳ et 2 janvier.**
La date de fin (5 janvier à 21 h 47) ne contredit pas ce constat — elle correspond au **retour**
d'un vélo parti le 2, resté sorti plus de trois jours. C'est justement l'une des valeurs
aberrantes de la Q20.

À retenir : `$max` sur `stop time` mesure la fin du **dernier trajet terminé**, pas la fin de la
**période de collecte**. Confondre les deux ferait croire à cinq jours de données là où il n'y a
que deux jours de départs (confirmé en Q14).

---

## B1 — Aggregation Pipeline

> Tous les pipelines sont dans **[`pipelines.js`](pipelines.js)**, exécutable via
> `docker exec -i mongo-j4 mongosh -u admin -p ipssi2025 --authenticationDatabase admin citibike < pipelines.js`

### Q12 — Top 5 des stations de départ

| Station | Trajets |
|---|---|
| Central Park S & 6 Ave | **114** |
| Lafayette St & E 8 St | 99 |
| Carmine St & 6 Ave | 95 |
| Broadway & E 14 St | 93 |
| E 17 St & Broadway | 86 |

### Q13 — Par type d'abonnement

| `usertype` | Trajets | Durée moyenne |
|---|---|---|
| **Subscriber** | 8 011 | **762,4 s** (12,7 min) |
| **Customer** | 1 989 | **2 610,7 s** (43,5 min) |

**Le rapport est de 3,42×** — un Customer roule en moyenne **3,4 fois plus longtemps** qu'un
Subscriber.

**Hypothèse métier :** ce sont deux usages, pas deux populations d'un même usage. Le
**Subscriber** est un abonné annuel, un New-Yorkais qui utilise le vélo comme moyen de
transport : trajet direct, court, d'un point A à un point B. Le **Customer** est un ticket
occasionnel — touriste ou usage de loisir : il se promène, s'arrête, fait des détours. La
tarification renforce l'effet : l'abonné, facturé au-delà de 45 minutes, a intérêt à rendre le
vélo vite ; le ticket 24 h n'a pas la même incitation.

*(Ces deux moyennes sont recalculées en Q21 — et l'écart y est éclairant.)*

### Q14 — Trajets par jour (`$dateTrunc`)

| Jour | Trajets |
|---|---|
| 2016-01-01 | **6 348** |
| 2016-01-02 | **3 652** |

**2 jours seulement.** C'est cohérent avec la Q11 : les départs sont bien confinés aux 1ᵉʳ et
2 janvier, seuls les *retours* débordent jusqu'au 5. En regroupant sur `start time`, on retrouve
la vraie période de collecte. Le déséquilibre 6 348 / 3 652 est lui aussi parlant : le 1ᵉʳ
janvier, jour férié, concentre 63 % des départs.

### Q15 — Heure de pointe

| Heure | Trajets |
|---|---|
| **13 h** | **1 061** |
| 12 h | 827 |
| 11 h | 778 |
| 15 h | 709 |
| 14 h | 685 |

**Non, ce n'est pas un profil domicile-travail.** Un usage pendulaire produirait deux pics
marqués, vers 8-9 h et 17-18 h, avec un creux à midi. Ici c'est l'inverse exact : **une seule
bosse centrée sur 13 h**, et les cinq heures de pointe sont toutes entre 11 h et 15 h.

**Le 1ᵉʳ janvier 2016 était un vendredi** — mais un vendredi **férié**, suivi d'un **samedi**.
Aucun des deux jours du jeu n'est un jour ouvré : personne ne va travailler. Le profil observé
est un profil de **loisir**, avec un démarrage tardif (le 1ᵉʳ janvier au matin, la ville dort)
et un pic en début d'après-midi.

**Conséquence méthodologique : ce jeu ne permet aucune conclusion sur l'usage habituel du
service.** Extrapoler « les New-Yorkais font du vélo à 13 h » à partir de deux jours fériés
serait une faute d'analyse — c'est le genre de biais qu'aucune requête ne signale.

### Q16 — Distribution des durées (`$bucket`)

| Tranche | Effectif |
|---|---|
| 0 – 300 s (< 5 min) | 2 009 |
| 300 – 600 s (5-10 min) | 3 136 |
| **600 – 1 800 s (10-30 min)** | **3 953** |
| 1 800 – 3 600 s (30-60 min) | 652 |
| 3 600 – 1 000 000 s (> 1 h) | 250 |

**La tranche la plus peuplée est 10-30 minutes (3 953 trajets, 39,5 %).** Les trois premières
tranches réunissent 91 % des trajets : l'usage réel est court. Les 250 trajets de plus d'une
heure — 2,5 % — sont la queue de distribution qui fausse la moyenne (Q21).

### Q17 — Boucles

```js
{ $match: { $expr: { $eq: ["$start station id", "$end station id"] } } }
```

**316 trajets** repartent de leur station de départ, soit **3,2 %**.

`$expr` est indispensable : un `$match` classique compare un champ à une **valeur constante**,
jamais deux champs entre eux. `$expr` permet d'utiliser des expressions d'agrégation dans un
filtre de requête.

Métier : une boucle est presque toujours un usage de promenade — ou un vélo pris puis
immédiatement reposé (défaut constaté). Croisé avec la Q15, cela conforte la lecture « loisir ».

---

## B2 — Qualité de données et optimiseur

### Q18 — Le champ piégé

```js
db.trips.aggregate([
  { $group: { _id: { type: { $type: "$birth year" }, usertype: "$usertype" }, n: { $sum: 1 } } },
  { $sort: { n: -1 } }
])
```

| Type de `birth year` | `usertype` | Trajets |
|---|---|---|
| **`int`** | **Subscriber** | **8 011** |
| **`string`** | **Customer** | **1 989** |

**La découverte est totale et sans exception : 100 % des Subscriber ont une année de naissance
entière, 100 % des Customer l'ont en chaîne.** Et ces deux nombres — 8 011 et 1 989 — sont
**exactement** les effectifs de la Q13. Il n'y a pas un seul contre-exemple sur 10 000
documents.

Ce n'est donc pas une erreur de saisie dispersée, c'est une **anomalie structurelle** : les deux
populations passent par deux chemins de saisie différents (formulaire d'abonnement contre borne
de location), et l'un des deux ne convertit pas le champ. Le sous-ensemble touché est
parfaitement corrélé à une variable métier — le cas le plus vicieux, car toute analyse par
`usertype` est biaisée de façon **systématique** et non aléatoire.

**Pourquoi `{ "birth year": { $lt: 1950 } }` est silencieusement fausse :** à cause du **type
bracketing** de BSON. Une comparaison ne s'applique qu'à l'intérieur d'un même type ; un `$lt`
avec un opérande numérique ne compare qu'aux valeurs numériques. Les 1 989 chaînes ne sont pas
« converties puis comparées », elles sont **exclues d'office**. Aucune erreur, aucun
avertissement : la requête renvoie un résultat parfaitement plausible, calculé sur 80 % du jeu
seulement — et exactement sur la population *la moins* pertinente pour une question d'âge, les
touristes étant précisément ceux qu'on aurait voulu étudier.

### Q19 — Âge moyen en 2016

```js
{ $match: { "birth year": { $type: "number" } } },
{ $project: { age: { $subtract: [2016, "$birth year"] } } },
{ $group: { _id: null, age_moy: { $avg: "$age" }, n: { $sum: 1 }, age_max: { $max: "$age" } } }
```

| | Valeur |
|---|---|
| Âge moyen | **39,9 ans** |
| Effectif retenu | **8 011** trajets (80,1 % du jeu) |
| Âge du plus vieil usager | **131 ans** |

**Non, 131 ans n'est pas crédible** : cela correspond à une année de naissance de **1885**, soit
un record du monde de longévité battu à vélo dans New York. C'est une **valeur sentinelle** — un
champ obligatoire rempli au hasard, ou une valeur par défaut d'un formulaire.

**Ce que j'en ferais en production :** surtout **pas une suppression du document**, qui reste
parfaitement valide pour toutes les autres analyses (durée, station, heure). Je poserais une
**règle de plausibilité explicite et documentée** — âge entre 14 et 100 ans, soit une année de
naissance entre 1916 et 2002 — appliquée **au calcul, pas à la donnée** :

```js
{ $match: { "birth year": { $type: "number", $gte: 1916, $lte: 2002 } } }
```

La donnée brute est conservée (on ne détruit jamais une source), l'exclusion est visible dans le
code, et son effectif est reporté à côté du résultat. En amont, j'ajouterais une validation de
schéma (`$jsonSchema`) pour que le problème cesse d'entrer dans la base, et une alerte sur le
taux de valeurs hors bornes.

### Q20 — Valeurs aberrantes

```js
db.trips.countDocuments({ tripduration: { $gt: 10800 } })   // 54   (> 3 h)
db.trips.countDocuments({ tripduration: { $gt: 86400 } })   //  9   (> 24 h)
```

Les 3 plus longs :

| Durée | Converti | `usertype` |
|---|---|---|
| 326 222 s | **90,6 h** | Subscriber |
| 279 620 s | **77,7 h** | Customer |
| 173 357 s | **48,2 h** | Customer |

**Explication métier.** Personne ne pédale 90 heures. Ces trajets sont des **vélos non
restitués correctement** : la durée n'est pas un temps de trajet mais le délai entre le
déverrouillage et la clôture de la location. Trois causes classiques :

1. **Vélo mal raccroché** à la borne d'arrivée — le système ne détecte pas le retour et laisse
   le compteur courir jusqu'à ce qu'un agent régularise.
2. **Vol ou perte** — la location reste ouverte jusqu'à clôture administrative.
3. **Panne de borne** au retour.

C'est cohérent avec la Q11 : le « dernier retour » du 5 janvier, trois jours après le dernier
départ, est précisément l'un de ces vélos.

Ces trajets sont des **incidents d'exploitation**, pas des trajets. Ils ont une vraie valeur —
pour l'équipe maintenance — mais **aucune** dans un calcul de durée moyenne d'usage.

### Q21 — La question d'écart

**(a) Nouvelles moyennes, trajets de plus de 3 h exclus**

| `usertype` | Trajets retenus | Durée moyenne |
|---|---|---|
| Subscriber | 7 998 | **648,6 s** (10,8 min) |
| Customer | 1 948 | **1 717,9 s** (28,6 min) |

**(b) Écart avec la Q13**

| `usertype` | Q13 (brut) | Q21 (filtré) | Écart absolu | **Écart relatif** |
|---|---|---|---|---|
| Subscriber | 762,4 s | 648,6 s | −113,8 s | **−14,9 %** |
| Customer | 2 610,7 s | 1 717,9 s | −892,8 s | **−34,2 %** |

**Non, les deux populations ne sont pas affectées de la même façon : l'effet est plus de deux
fois plus fort sur les Customer.**

La raison est arithmétique et tient à deux facteurs qui se cumulent. D'abord **la proportion
d'aberrants** : 41 des 54 trajets exclus sont des Customer (1 989 − 1 948), soit **2,06 %** de
cette population, contre 13 sur 8 011 = **0,16 %** des Subscriber — treize fois plus. Ensuite
**la taille de la population** : chaque aberrant pèse d'autant plus lourd dans une moyenne que
l'effectif est petit, et les Customer sont quatre fois moins nombreux.

Interprétation métier : le ticket occasionnel est le mode où l'on oublie de raccrocher
correctement — usager non familier du système, pas de compte à protéger, pas de pénalité
immédiate.

**(c) Volume exclu**

```
54 trajets exclus / 10 000 = 0,54 % du jeu
```

**Le rapport est frappant : 0,54 % des données déplacent la moyenne des Customer de 34,2 %.**
Un facteur **63**. C'est la démonstration de ce qu'est une valeur aberrante : ce n'est pas une
question de *nombre*, c'est une question d'**amplitude**. Un trajet de 90 heures pèse, dans une
moyenne, autant que 450 trajets de 12 minutes. La moyenne arithmétique n'a aucune défense contre
les valeurs extrêmes — c'est précisément pour cela qu'on lui préfère la médiane (R3b).

La comparaison avec le Jour 1 est instructive : là, 13 scores négatifs sur 93 463 déplaçaient la
moyenne de **0,015 %**, et j'avais conclu qu'il ne fallait pas nettoyer en urgence. Ici, 54
trajets sur 10 000 la déplacent de **34 %**. **Le même raisonnement — rapporter l'anomalie à son
impact mesuré — conduit à des décisions opposées.** C'est le raisonnement qui compte, pas la
règle.

**(d) Ce que je communiquerais**

**La valeur filtrée (Q21)**, sans hésitation, mais **jamais seule** : toujours accompagnée du
critère d'exclusion et de l'effectif écarté (voir R3a).

La raison est que la moyenne brute ne répond **pas à la question posée**. La direction demande
« combien de temps dure un trajet », c'est-à-dire une question sur le **comportement des
usagers**. Or 2 610 s pour un Customer ne décrit le comportement de personne : c'est un mélange
de 1 948 trajets réels et de 41 incidents d'exploitation. Communiquer ce chiffre reviendrait à
dire que le touriste new-yorkais pédale trois quarts d'heure, ce qui est **faux** — et
dimensionnerait la flotte, la tarification et les rotations de maintenance sur une réalité qui
n'existe pas.

En revanche, les 54 trajets exclus doivent être **remontés séparément** à l'exploitation : ce
sont 54 vélos qui ont été indisponibles pendant des jours. Ils ne disparaissent pas du rapport,
ils changent de chapitre.

### Q22 — `$match` en premier, vraiment ?

```js
// A
[ { $match: { usertype: "Subscriber" } },
  { $group: { _id: "$start station id", n: { $sum: 1 } } } ]

// B
[ { $group: { _id: { s: "$start station id", u: "$usertype" }, n: { $sum: 1 } } },
  { $match: { "_id.u": "Subscriber" } } ]
```

| | Pipeline A | Pipeline B |
|---|---|---|
| Pipeline **après optimisation** | `$cursor -> $group` | **`$cursor -> $group`** |
| Filtre poussé dans le curseur | `{"usertype":{"$eq":"Subscriber"}}` | **`{"usertype":{"$eq":"Subscriber"}}`** |
| Plan | `PROJECTION_SIMPLE ← COLLSCAN` | `PROJECTION_SIMPLE ← COLLSCAN` |
| `totalDocsExamined` | 10 000 | 10 000 |
| **Documents remontés du curseur** | **8 011** | **8 011** |

**Les deux plans sont rigoureusement identiques.**

**Ce que l'optimiseur a fait :** il a **remonté le `$match` du pipeline B avant le `$group`**
(*predicate pushdown*, ou « $match coalescence/reordering » dans la documentation *aggregation
pipeline optimization*). Il a pu le faire parce que le filtre porte sur `_id.u`, qui n'est
qu'une **projection directe du champ source `$usertype`** : filtrer avant ou après le
regroupement donne rigoureusement le même résultat, et filtrer avant coûte moins cher. Il a
réécrit `{"_id.u": "Subscriber"}` en `{"usertype": {"$eq": "Subscriber"}}` et l'a poussé jusque
dans le curseur — au niveau où un index aurait pu être utilisé (il n'y en a pas ici sur
`usertype`, d'où le `COLLSCAN`, mais le mécanisme est le même).

Les 8 011 documents remontés au lieu de 10 000 le prouvent : dans les deux cas, le `$group` ne
voit que les Subscriber.

### Q23 — La limite de l'optimiseur

```js
[ { $group: { _id: "$start station id", n: { $sum: 1 } } },
  { $match: { n: { $gt: 50 } } } ]
```

| | Valeur |
|---|---|
| Pipeline après optimisation | **`$cursor -> $group -> $match`** — le `$match` **n'a pas bougé** |
| Filtre poussé dans le curseur | **`{}`** — aucun |
| **Documents traversant le `$group`** | **10 000** |
| Stations à plus de 50 départs | **34** |

**10 000 documents traversent le `$group`**, contre 8 011 en Q22.

**Pourquoi l'optimiseur ne peut rien faire ici :** parce que `n` **n'existe pas avant le
`$group`**. Ce n'est pas un champ des documents source, c'est le **résultat du calcul**
(`{ $sum: 1 }`). Il est logiquement impossible de filtrer sur un agrégat avant de l'avoir
calculé — il faudrait avoir compté tous les départs d'une station pour savoir si elle dépasse
50, donc avoir déjà lu tous les documents. L'optimiseur ne bute pas sur une limite
d'implémentation mais sur une **impossibilité logique**.

Le contraste avec la Q22 est net : là, le filtre portait sur une valeur **présente dans les
documents source** (`usertype`), simplement transportée jusque dans la clé de groupe ; ici il
porte sur une valeur **créée** par le pipeline.

> **La règle générale : l'optimiseur sait déplacer un filtre portant sur une donnée qui existe
> déjà dans les documents d'entrée ; il ne peut rien pour un filtre portant sur une valeur que
> le pipeline calcule.** Autrement dit, `$match` sur un champ source est gratuit où qu'on le
> place — mais `$match` sur un agrégat est nécessairement payé au prix fort. C'est pourquoi
> l'ordre des stages reste une décision d'auteur : l'optimiseur rattrape la maladresse, jamais
> la conception. (Troisième cas, plus subtil, en **R2**.)

---

## B3 — Matérialisation et jointure

### Q24 — `$merge`

```js
db.trips.aggregate([
  { $group: { _id: "$start station id",
              nom:      { $first: "$start station name" },
              position: { $first: "$start station location" },
              departs:  { $sum: 1 } } },
  { $merge: { into: "stations", whenMatched: "replace" } }
])
```

**462 stations** obtenues à partir de 10 000 trajets.

| Station | Départs |
|---|---|
| Central Park S & 6 Ave (id 2006) | **114** |
| Lafayette St & E 8 St (id 293) | 99 |
| Carmine St & 6 Ave (id 368) | 95 |

Cohérent avec la Q12, comme attendu.

### Q25 — `$out` contre `$merge`

| | `$out` | `$merge` |
|---|---|---|
| Collection cible existante | **Remplacée intégralement** (drop puis recréation) | **Conservée**, fusionnée document par document |
| Granularité | Tout ou rien | Par `_id` : `whenMatched` (replace / merge / keepExisting / fail / pipeline) et `whenNotMatched` (insert / discard / fail) |
| Cible dans une autre base | Non (même base) | Oui |
| Index de la cible | **Perdus** (collection recréée) | **Conservés** |
| Écriture pendant l'exécution | Cible indisponible / remplacée à la fin | Mise à jour incrémentale |

**Celle qui permet un rafraîchissement quotidien incrémental : `$merge`**, et pour trois raisons
concrètes sur notre cas.

D'abord, **elle ne détruit pas la cible**. Avec `$out`, la collection `stations` est droppée
puis recréée à chaque exécution : **l'index `2dsphere` créé en Q30 disparaîtrait toutes les
nuits**, et la première requête géospatiale du matin échouerait — ou pire, tomberait en
`COLLSCAN` sans prévenir. `$merge` préserve les index.

Ensuite, **elle permet le traitement d'un delta**. Le rafraîchissement quotidien ne doit pas
rejouer les 10 000 (puis 10 millions) de trajets depuis l'origine : on filtre sur les trajets de
la veille (`$match` sur `start time`) et l'on fusionne le résultat avec l'existant —
`whenMatched: [{ $set: { departs: { $add: ["$departs", "$$new.departs"] } } }]` cumule au lieu
d'écraser. Le coût du batch devient proportionnel au **volume du jour**, pas à l'historique.

Enfin, **elle n'interrompt pas le service**. Le tableau de bord peut lire `stations` pendant que
le batch tourne ; avec `$out`, la collection est remplacée d'un bloc et l'on s'expose à servir
une page vide.

### Q26 — `$lookup` : top 5 des stations d'arrivée

| Arrivées | Départs (Q24) | Station |
|---|---|---|
| **96** | 86 | E 17 St & Broadway |
| 95 | **114** | Central Park S & 6 Ave |
| 91 | 93 | Broadway & E 14 St |
| 85 | 67 | W 21 St & 6 Ave |
| 85 | 68 | West St & Chambers St |

**Oui, des stations apparaissent dans les deux classements** — trois sur cinq : *E 17 St &
Broadway* (5ᵉ au départ, 1ʳᵉ à l'arrivée), *Central Park S & 6 Ave* (1ʳᵉ au départ, 2ᵉ à
l'arrivée) et *Broadway & E 14 St* (4ᵉ et 3ᵉ). Ce sont des **pôles**, fréquentés dans les deux
sens.

**Ce que signale une station qui reçoit beaucoup plus de vélos qu'elle n'en émet**, c'est un
**déséquilibre de flux**, et c'est le cœur du métier d'un opérateur de vélos partagés. Deux
stations le montrent ici : *W 21 St & 6 Ave* (85 arrivées pour 67 départs, **+27 %**) et
*West St & Chambers St* (85 pour 68, **+25 %**).

Concrètement, une telle station se **remplit** : ses bornes finissent occupées, et l'usager
suivant ne peut plus rendre son vélo — il doit chercher une autre station, ce qui est le premier
motif de réclamation du service. Symétriquement, la station qui émet plus qu'elle ne reçoit se
**vide**, et l'usager ne trouve pas de vélo.

C'est exactement l'indicateur qui pilote le **rééquilibrage** : les camions qui, la nuit,
déplacent les vélos des stations excédentaires vers les stations déficitaires. Le rapport
arrivées/départs par station et par tranche horaire est la donnée qui dimensionne cette
tournée — et c'est le premier tableau de bord que je proposerais à la direction, avant même
les classements de la Q12.

*(Techniquement : `$lookup` produit toujours un tableau, d'où le `$unwind`, et je l'ai assorti
d'un `preserveNullAndEmptyArrays` + `$ifNull` pour ne pas perdre silencieusement une station
d'arrivée qui n'apparaîtrait jamais au départ — cas parfaitement possible, et qui serait
justement le déséquilibre le plus extrême.)*

---

## B4 — Index géospatial 2dsphere

> Requêtes complètes dans **[`geo.js`](geo.js)**. Référence : Times Square
> `[-73.9855, 40.7580]` (longitude, latitude).

### Q27 — `$near` sans index

```js
db.trips.find({ "start station location": { $near: {
  $geometry: { type: "Point", coordinates: [-73.9855, 40.7580] }, $maxDistance: 500 } } })
```

```
codeName : NoQueryExecutionPlans   code : 291
message  : error processing query: ns=citibike.trips Tree: GEONEAR field=start station location
           maxdist=500 isNearSphere=0
```

**La requête n'est pas lente : elle est refusée.** Le planificateur annonce qu'il ne trouve
**aucun plan d'exécution** possible.

**Pourquoi un index est obligatoire ici alors qu'il n'est que conseillé ailleurs :** parce que
`$near` n'est pas seulement un filtre, c'est un **filtre trié**. Il doit renvoyer les résultats
**par distance croissante**, ce qui suppose de savoir ordonner des points sur une sphère — une
opération que MongoDB ne sait faire qu'à travers la structure de l'index `2dsphere`, qui encode
les coordonnées en cellules hiérarchiques (S2). Sans cet index, il n'existe aucun algorithme de
repli : un `COLLSCAN` saurait tester une appartenance, il ne saurait pas produire un ordre
géographique. D'où un refus net plutôt qu'une exécution dégradée — comportement bien plus sain,
d'ailleurs, qu'un `COLLSCAN` silencieux.

### Q28 — Avec l'index

```js
db.trips.createIndex({ "start station location": "2dsphere" })   // start station location_2dsphere
```

**148 trajets** partent à moins de 500 m de Times Square.

Les 5 premiers :

```
1. W 45 St & 6 Ave
2. W 45 St & 6 Ave
3. W 45 St & 6 Ave
4. W 45 St & 6 Ave
5. W 45 St & 8 Ave
```

**`$near` les renvoie par distance croissante** — d'où la répétition : les quatre premiers sont
quatre *trajets différents* partis de la **même station**, la plus proche du point de référence
(256 m, cf. Q30). On interroge la collection `trips`, pas `stations` : chaque document est un
trajet, plusieurs partagent la même position.

### Q29 — Le piège du comptage, encore

```js
db.trips.countDocuments({ "start station location": { $near: { ... } } })
```

```
codeName : Location5626500   code : 5626500
message  : $geoNear, $near, and $nearSphere are not allowed in this context, as these operators
           require sorting geospatial data. If you do not need sort, consider using $geoWithin instead.
```

**Explication.** `countDocuments()` n'est pas une commande `count` : c'est une **agrégation
déguisée**, réécrite en `[{ $match: <filtre> }, { $group: { _id: null, n: { $sum: 1 } } }]`. Or
`$near` exige un **tri géospatial**, et un tri n'a aucun sens à l'intérieur d'un `$match` de
pipeline — le contexte ne le permet pas. Le message le dit explicitement : *« these operators
require sorting geospatial data »*, et il suggère lui-même la solution.

C'est le même piège que le Jour 1 (bonus B2), et la même leçon : **`countDocuments` n'accepte
pas tous les opérateurs que `find` accepte**, parce que ce n'est pas le même moteur d'exécution.

**L'opérateur de remplacement : `$geoWithin` + `$centerSphere`**, qui teste une appartenance
sans imposer d'ordre. Le rayon s'exprime en **radians**, d'où la division par le rayon terrestre
(6 378,1 km) :

```js
db.trips.countDocuments({ "start station location": {
  $geoWithin: { $centerSphere: [[-73.9855, 40.7580], 0.5 / 6378.1] } } })
```

| Rayon | Trajets |
|---|---|
| **500 m** | **148** |
| **1 000 m** | **774** |

Les 148 à 500 m correspondent exactement au résultat de la Q28 — les deux opérateurs
sélectionnent le même ensemble, seul l'ordre diffère. Et le passage de 500 m à 1 km multiplie le
résultat par **5,2** pour une surface multipliée par 4 : la densité de départs augmente en
s'éloignant du cœur touristique de Times Square.

### Q30 — `$geoNear` sur `stations`

```js
db.stations.createIndex({ position: "2dsphere" })       // position_2dsphere

db.stations.aggregate([
  { $geoNear: { near: { type: "Point", coordinates: [-73.9855, 40.7580] },
                distanceField: "distance_m", maxDistance: 1000, spherical: true } },
  { $project: { _id: 0, nom: 1, departs: 1, distance_m: { $round: ["$distance_m", 0] } } }
])
```

**34 stations** à moins de 1 km de Times Square. Extrait :

| Distance | Départs | Station |
|---|---|---|
| **256 m** | 4 | **W 45 St & 6 Ave** |
| 298 m | 33 | W 45 St & 8 Ave |
| 310 m | 24 | Broadway & W 49 St |
| 332 m | 10 | Broadway & W 41 St |
| 362 m | 26 | W 43 St & 6 Ave |
| … | … | … |
| 947 m | 52 | Pershing Square North |
| 986 m | 5 | E 53 St & Madison Ave |

**La plus proche est `W 45 St & 6 Ave`, à 256 m** — et c'est bien elle qui occupait les quatre
premières places de la Q28.

Détail intéressant : cette station la plus proche du carrefour le plus fréquenté du monde ne
compte que **4 départs**, quand *Pershing Square North*, à 947 m, en compte **52**. Times Square
est un lieu où l'on va, pas un lieu d'où l'on part à vélo ; les stations productives sont celles
qui bordent Grand Central. Le tri par distance et le tri par usage n'ont aucun rapport.

**Pourquoi `$geoNear` doit être le premier stage du pipeline :** parce qu'il ne se contente pas
de filtrer, il **produit** un champ (`distanceField`) et **impose l'ordre** de sortie. Ces deux
propriétés supposent un accès direct à l'index `2dsphere`, qui n'est disponible qu'au moment où
le pipeline attaque la collection. Dès qu'un stage précédent a transformé le flux (`$group`,
`$project`, `$unwind`…), les documents ne sont plus les documents indexés : il n'y a plus
d'index à interroger, donc plus moyen ni de calculer efficacement les distances, ni de garantir
l'ordre. C'est la même logique que `$text`, soumis à la même contrainte, et pour la même raison.

---

## B5 — Diagnostic

> Tableaux complets dans **[`diagnostic.md`](diagnostic.md)**.

### Q31 — `explain()`

| | Stage | `totalKeysExamined` | `totalDocsExamined` | `nReturned` | **Ratio** |
|---|---|---|---|---|---|
| **(a) Avant index** | `COLLSCAN` | 0 | **10 000** | 36 | **277,78** |
| **(b) Après index** | `FETCH ← IXSCAN` | 36 | **36** | 36 | **1,00** |
| (c) + projection couvrante | `PROJECTION_COVERED ← IXSCAN` | 36 | **0** | 36 | **0,00** |

**(c)** Le ratio passe de **277,78 à 1,00** : 278 documents lus par document utile, contre
exactement un.

**La valeur idéale est 1,00.** On ne descend presque jamais en dessous sans projection parce que
le stage `FETCH` est **obligatoire** dès qu'on renvoie un champ absent de l'index : l'index ne
contient que la clé et un pointeur, il faut aller chercher le document — un document lu par
document renvoyé. La seule échappatoire est la **covered query** (ligne c) : en limitant la
projection aux champs de l'index et en excluant `_id`, le `FETCH` disparaît et
`totalDocsExamined` tombe à **0** — la collection n'est jamais touchée.

### Q32 — Le profiler

```js
db.setProfilingLevel(1, { slowms: 0 })
db.trips.find({ "end station name": "W 52 St & 9 Ave" })          // 48 resultats
db.trips.aggregate([{ $group: { _id: "$usertype", n: { $sum: 1 } } }])
db.setProfilingLevel(0)
```

**2 entrées** dans `db.system.profile` :

| `op` | `ns` | `millis` | `planSummary` |
|---|---|---|---|
| `query` | `citibike.trips` | 4 | **`COLLSCAN`** |
| `command` | `citibike.trips` | 8 | **`COLLSCAN`** |

**`planSummary` vaut `COLLSCAN` pour les deux**, ce qui signifie qu'aucun index n'a servi. Pour
le `find` sur `end station name`, c'est attendu (je n'ai indexé que `start station id`) ; pour
l'agrégation, c'est structurel — un `$group` sans `$match` doit voir tous les documents (Q23).

Ce que cela m'apprend, et qui est le véritable intérêt de l'outil : **je n'avais pas écrit ces
requêtes en les soupçonnant lentes.** `explain()` suppose de savoir *quoi* analyser ; le
profiler montre **ce qui s'est réellement exécuté**. Sur 10 000 documents, 4 et 8 ms sont
indolores — sur 10 millions, ces deux `COLLSCAN` seraient les deux premières lignes d'un rapport
d'incident.

### Q33 — Les trois niveaux

| Niveau | Comportement |
|---|---|
| **0** | Désactivé (défaut) |
| **1** | Enregistre uniquement les opérations dépassant `slowms` (100 ms par défaut) |
| **2** | Enregistre **toutes** les opérations |

**En production : niveau 1, avec `slowms` abaissé à 50 ms.** À 100 ms on ne voit que le déjà
pathologique ; la dégradation qui précède un incident se joue entre 30 et 100 ms. À 50 ms on
capture les requêtes qui *deviennent* lentes — celles sur lesquelles on peut encore agir — pour
un coût d'écriture négligeable. Sur une base à très fort trafic, on complète par `sampleRate`.

**Deux risques du niveau 2 sur une base chargée :**

1. **Chaque opération devient une écriture.** On transforme une charge de lecture en charge
   d'écriture, on consomme des IOPS, on pollue le cache WiredTiger et on ajoute de la latence à
   *toutes* les requêtes — y compris celles qui allaient bien. **L'outil de mesure devient la
   cause du ralentissement**, et le diagnostic tourne en rond.
2. **La collection est capped, donc elle écrase silencieusement.**

   ```js
   db.system.profile.stats().capped     // true
   db.system.profile.stats().maxSize    // 1048576  (1 Mo)
   ```

   Au niveau 2, ce mégaoctet est rempli en quelques secondes puis **écrasé en boucle** : on
   cherche la requête lente signalée à 14 h 03, on ouvre `system.profile` à 14 h 10, elle a
   disparu. **Plus on enregistre, moins on garde.**

### Q34 — La requête de tableau de bord

```js
const N = 50;   // seuil en millisecondes

db.system.profile.find(
  { planSummary: "COLLSCAN", millis: { $gte: N } },
  { op: 1, ns: 1, millis: 1, planSummary: 1, "command.filter": 1, ts: 1, _id: 0 }
).sort({ millis: -1 })
```

Le croisement des deux critères est ce qui la rend exploitable : **`COLLSCAN`** isole les
requêtes dont le temps croîtra **linéairement avec le volume** — donc les **index manquants**,
un problème qu'on sait corriger — et **`millis >= N`** écarte les `COLLSCAN` légitimes sur de
petites collections de configuration. Le résultat n'est pas une liste de symptômes, c'est une
**liste de tâches** : chaque ligne est un index à créer, triées par gain décroissant. En
production, on y ajoute un `$group` par `ns` et par forme de filtre : un `COLLSCAN` de 60 ms
exécuté 10 000 fois par heure coûte bien plus cher qu'un `COLLSCAN` de 3 secondes lancé une fois
par nuit.

---

# PARTIE C — Réflexion

### R1 — Le tableau de bord quotidien

**L'architecture.** Un **batch nocturne à 5 h**, déclenché par un ordonnanceur externe (cron,
Airflow — MongoDB n'a pas de planificateur intégré), qui exécute les pipelines de la Partie B et
**matérialise** leurs résultats dans des collections dérivées via **`$merge`** : `stations`
(Q24), plus une collection `kpi_journaliers` par jour. À 6 h, le tableau de bord ne fait plus
que des `find()` sur ces collections pré-calculées — **aucune agrégation à l'affichage**.

Trois compléments indispensables :

- **Les index qui vont avec.** `2dsphere` sur `stations.position` (Q30), `{ departs: -1 }` pour
  les classements. `$merge` les préserve, contrairement à `$out` (Q25) — c'est précisément
  pourquoi on choisit `$merge`.
- **Un rafraîchissement incrémental.** Le batch ne rejoue pas l'historique : `$match` sur les
  trajets de la veille, puis fusion cumulative
  (`whenMatched: [{ $set: { departs: { $add: [...] } } }]`). Le coût reste proportionnel au
  volume du jour.
- **Le profiler en niveau 1 / `slowms: 50`** (Q33) sur la base de production, avec la requête de
  la Q34 en supervision : c'est ce qui préviendra que le batch se dégrade avant que la direction
  ne s'en aperçoive.

**Le gain, chiffré.**

| | Documents lus |
|---|---|
| Agrégation complète sur `trips` (Q23, `totalDocsExamined`) | **10 000** |
| Lecture de la collection `stations` (Q24) | **462** |

**Rapport : 10 000 / 462 = 21,6×.** Chaque affichage lit 21,6 fois moins de documents. Et ce
rapport **s'aggrave dans le bon sens avec le temps** : le nombre de stations est borné par la
géographie (462, il n'y en aura jamais 50 000), alors que le nombre de trajets croît
indéfiniment. À un an de données — environ 1,8 million de trajets en extrapolant les 10 000
de deux jours — le rapport dépasserait **3 900×**. Le calcul n'est plus fait qu'une fois par
nuit, et non à chaque ouverture de page par chaque utilisateur.

**Le compromis accepté : la fraîcheur.** Le tableau de bord affiche l'état d'hier soir, pas
celui de l'instant. C'est un choix, et il est **acceptable ici** parce que la direction a
elle-même demandé un rafraîchissement **quotidien à 6 h** : elle n'a aucun usage d'une donnée à
la seconde. On accepte aussi un coût de stockage (les collections dérivées) et une dette
opérationnelle (un batch de plus à superviser — s'il échoue silencieusement, le tableau affiche
la veille sans le dire, d'où la nécessité d'horodater chaque ligne matérialisée).

C'est exactement le **Computed Pattern** du Jour 2 — avec la même facture : le Jour 2 m'a montré
**12 244 compteurs faux sur 15 740** faute de réconciliation. La leçon s'applique ici : le batch
doit être **idempotent et rejouable**, et un contrôle de cohérence doit comparer périodiquement
le pré-calculé au recalculé.

### R2 — La règle d'écriture des pipelines, vérifiée

**Ma règle en trois phrases :**

1. **Écrivez toujours `$match` en premier** — non pas parce que l'optimiseur en serait
   incapable, mais parce que c'est la seule position qui soit correcte dans *tous* les cas, y
   compris ceux où il ne peut rien.
2. **L'optimiseur sait remonter un filtre portant sur une donnée déjà présente dans les
   documents source**, même à travers un `$group`, et le pousser jusque dans le curseur où un
   index peut le servir (Q22 : les pipelines A et B produisent un plan **identique**, 8 011
   documents remontés dans les deux cas).
3. **Il ne peut rien pour un filtre portant sur une valeur que le pipeline calcule** — ce n'est
   pas une limite d'implémentation mais une impossibilité logique (Q23 : `$match` sur `n`, les
   **10 000** documents traversent le `$group`, aucun filtre poussé).

**Le troisième cas, testé.**

```js
[ { $project: { _id: 0, "start station id": 1 } },      // le champ usertype est supprime
  { $match: { usertype: "Subscriber" } } ]
```

| | Résultat |
|---|---|
| Pipeline après optimisation | **`$cursor -> $match`** |
| Filtre poussé dans le curseur | **`{}`** — aucun |
| Documents remontés du curseur | **10 000** |

**Non, l'optimiseur ne remonte pas le `$match` cette fois** — alors que le filtre porte pourtant
sur un champ **bien présent** dans les documents source (`usertype`), contrairement à la Q23.

**Ce que ce troisième cas m'apprend sur la frontière exacte de l'optimiseur :** elle n'est pas
« champ source contre champ calculé », comme la comparaison Q22/Q23 pouvait le laisser croire.
Elle est **sémantique** : l'optimiseur ne déplace un stage que s'il peut **prouver que le
résultat sera identique**. Ici, remonter le `$match` avant le `$project` changerait le sens du
pipeline — après le `$project`, `usertype` n'existe plus, donc le filtre ne matche **rien** et le
pipeline renvoie 0 document ; avant, il matcherait 8 011 documents. Deux résultats différents :
la transformation est **interdite**, même si elle serait plus rapide.

Autrement dit, **l'optimiseur préserve la sémantique avant la performance** — il refuse de
« corriger » ce qui ressemble à une erreur d'auteur, et exécute fidèlement ce qu'on a écrit,
fût-ce un pipeline qui ne renvoie rien. Ce troisième cas est le plus instructif des trois,
parce qu'il est celui où le pipeline est **silencieusement faux** : ni erreur, ni
avertissement, juste un résultat vide qu'on prendra pour une absence de données.

**La règle finale, corrigée :** placez `$match` en premier — et si vous ne le pouvez pas,
vérifiez que les champs qu'il utilise existent encore à l'endroit où vous l'avez mis.

### R3 — Le chiffre unique, et son coût

**(a) La phrase du rapport**

> « **La durée moyenne d'un trajet Citi Bike est de 10,8 minutes pour les abonnés (Subscriber,
> 7 998 trajets) et de 28,6 minutes pour les usagers occasionnels (Customer, 1 948 trajets),
> sur les 1ᵉʳ et 2 janvier 2016. Sont exclus du calcul les 54 trajets de plus de 3 heures
> (0,54 % du jeu), qui correspondent à des vélos non restitués et non à des trajets réels ; ils
> font l'objet d'un suivi distinct par l'exploitation.** »

Trois éléments obligatoires y figurent : **la valeur**, **l'effectif retenu**, **le critère
d'exclusion explicite** — plus la période, sans laquelle le chiffre serait ininterprétable
(Q15 : deux jours fériés).

**(b) La médiane**

```js
db.trips.aggregate([{ $group: { _id: null,
  mediane: { $median: { input: "$tripduration", method: "approximate" } },
  moyenne: { $avg: "$tripduration" } } }])
```

| Indicateur | Valeur | En minutes |
|---|---|---|
| Moyenne brute, tous usertype (Q13 pondérée) | **1 130,0 s** | 18,8 min |
| Moyenne filtrée > 3 h exclues (Q21) | ~861 s | ~14,4 min |
| **Médiane, jeu non filtré** | **579,0 s** | **9,7 min** |

**La médiane est la plus robuste des trois**, et l'écart le démontre : calculée sur le jeu
**non filtré**, elle vaut 9,7 min — soit **presque deux fois moins** que la moyenne brute
(18,8 min) sur exactement les mêmes données. Elle est même inférieure à la moyenne filtrée, dont
elle n'a pourtant pas eu besoin.

La raison est structurelle : la médiane est le **rang central**, elle ne dépend que de l'ordre
des valeurs, pas de leur amplitude. Qu'un trajet dure 3 heures ou 90 heures (Q20) ne change
**rien** à sa position dans le classement — il reste « le dernier ». La moyenne, elle, additionne
les amplitudes : un trajet de 90 heures pèse autant que 450 trajets de 12 minutes. C'est
pourquoi 0,54 % des données déplacent la moyenne de 34 % (Q21c) et la médiane de rien du tout.

La médiane a aussi un **avantage opérationnel décisif** : elle est robuste **sans qu'on ait à
décider d'un seuil**. Mon exclusion à 3 heures est un choix défendable, mais c'est un choix — un
collègue prendrait 2 heures, un autre 4, et chacun obtiendrait un chiffre différent. La médiane
ne demande aucun arbitrage, donc elle n'en dissimule aucun.

Elle a en contrepartie une limite qu'il faut dire : elle **ignore les extrêmes au lieu de les
signaler**. Sur les mêmes données, elle vaudrait 9,7 min avec ou sans les 54 vélos volés — donc
elle ne les aurait jamais fait découvrir. **La bonne pratique est de publier les deux** :
médiane comme indicateur central, moyenne filtrée comme mesure économique (c'est elle qui
dimensionne les rotations et la tarification), et l'écart entre les deux comme **signal de
qualité de données**.

**(c) En quoi une réponse sans précaution serait malhonnête — et pas seulement imprécise**

La différence tient à ce qu'on sait au moment où l'on parle. Une réponse **imprécise** est une
réponse dont on ignore les limites ; une réponse **malhonnête** est une réponse dont on connaît
les limites et qu'on livre sans les dire.

Annoncer « 18,8 minutes en moyenne » serait malhonnête à trois titres, et j'ai le chiffre pour
chacun. **Un** : je sais que 54 trajets ne sont pas des trajets mais des vélos non restitués
(Q20), et qu'ils déplacent la moyenne de 34 % chez les Customer (Q21b) — je livrerais donc
sciemment un chiffre qui décrit le comportement de personne. **Deux** : je sais que 1 989
usagers ont une année de naissance en chaîne (Q18) et que toute segmentation par âge exclurait
silencieusement 100 % des Customer — la seule population que la direction voudrait justement
comprendre. **Trois** : je sais que les données couvrent deux jours fériés (Q14, Q15) et ne
représentent en rien un usage ordinaire.

Chacune de ces trois choses, je l'ai **mesurée**. Les taire ne rend pas le chiffre approximatif,
cela le rend **trompeur avec l'autorité du chiffre** : mon interlocuteur, lui, n'a aucun moyen de
soupçonner ce qu'il ne voit pas, et il prendra une décision — dimensionner une flotte, fixer un
tarif — sur une base que je savais fausse. L'imprécision est un état de la connaissance ; la
malhonnêteté est un choix de communication. **Un rapport n'a pas à être exact, il a à être
auditable** : quiconque le lit doit pouvoir savoir ce qui a été exclu, pourquoi, et combien cela
représente.

### R4 — `explain()` ou profiler ?

**Ce que chacun voit et que l'autre ne voit pas.**

| | `explain()` | Profiler |
|---|---|---|
| Nature | **Prospectif** — j'analyse une requête que je choisis | **Rétrospectif** — j'observe ce qui s'est réellement exécuté |
| Périmètre | Une requête, celle que je lui donne | Toutes les opérations, y compris celles que j'ignore |
| Détail | Le **plan complet** : stages, index candidats, clés et documents examinés | Un **résumé** : `op`, `ns`, `millis`, `planSummary` |
| Coût | Nul en production (n'exécute rien de durable, `executionStats` exécute mais ne renvoie rien au client) | **Non nul** : écrit à chaque opération capturée |
| Angle mort | **Ne voit que ce que je pense à lui montrer** | **Ne dit pas pourquoi** : `COLLSCAN`, mais pas quel index créer |

Concrètement, dans ce TP : **la Q31 (`explain`) m'a donné le *pourquoi*** — `COLLSCAN`, 10 000
documents examinés pour 36 renvoyés, ratio 277,78, et la preuve chiffrée qu'un index sur
`start station id` ramènerait le ratio à 1,00. **La Q32 (profiler) m'a donné le *quoi*** — deux
opérations que je n'avais pas prévu d'analyser, toutes deux en `COLLSCAN`, dont une agrégation
que je n'aurais jamais songé à passer à `explain()`.

**L'un trouve, l'autre explique.** Le profiler est un filet ; `explain()` est un microscope. Un
microscope ne sert à rien si l'on ne sait pas où regarder.

**L'incident : « l'appli est lente depuis 14 h ».**

**1. Les logs et les métriques système, d'abord** (coût : nul, tout est déjà écrit). Je cherche
ce qui a **changé à 14 h** : un déploiement, un import, une saturation disque, un failover de
Replica Set (Jour 3), un shard injoignable. C'est gratuit, immédiat, et cela élimine d'emblée
l'hypothèse la plus fréquente en production — **ce n'est pas la base, c'est autre chose**. Rien
ne serait plus absurde que d'optimiser des requêtes alors que le disque est plein.

**2. `mongostat` / `mongotop`, ensuite** (coût : très faible, un échantillonnage). Ils me disent
**où** ça brûle : le nombre d'opérations par seconde, la file d'attente, le taux de défauts de
cache, et surtout **quelle collection** consomme le temps. Cela élimine l'hypothèse « la charge
a simplement doublé » (auquel cas ce n'est pas un bug mais un dimensionnement) et **réduit le
périmètre** d'une base entière à une ou deux collections.

**3. Le profiler, alors seulement** (coût : réel, il écrit). Je l'active en **niveau 1 avec
`slowms: 50`**, quelques minutes, et je lance la requête de la **Q34** : les `COLLSCAN` de plus
de N ms, groupés par namespace et par forme de filtre. J'obtiens la **liste nommée** des
requêtes coupables, triée par coût. Je ne l'active qu'à ce stade parce qu'il ajoute de la charge
à une base **déjà en souffrance** — l'activer en premier, en niveau 2, aggraverait l'incident
que je cherche à diagnostiquer.

**4. `explain("executionStats")` en dernier** (coût : nul, ciblé). Sur les deux ou trois
requêtes que le profiler a désignées, il me donne le plan exact, le ratio
`totalDocsExamined / nReturned`, et me permet de **valider l'index avant de le créer** — puis de
mesurer le gain après, comme en Q31 (277,78 → 1,00).

**La logique de cet ordre : coût croissant, périmètre décroissant.** Chaque étape est plus chère
que la précédente et s'applique à un périmètre plus étroit ; chacune **élimine une famille
d'hypothèses** avant d'autoriser la suivante. Commencer par `explain()` reviendrait à examiner
au microscope une requête choisie au hasard, en espérant que ce soit la bonne — et à passer à
côté d'un disque plein pendant deux heures.

# TP Jour 2 — Modélisation, Indexation & Drivers

**Mohammed Monsleh** — MIA4 · Conception et intégration d'un SGBD NoSQL — IPSSI Montpellier
Jeu de données : `sample_mflix` — base `mflix`, collections `movies` et `comments`.

---

## Partie 0 — Import

```bash
curl -L -o movies.json   https://raw.githubusercontent.com/neelabalan/mongodb-sample-dataset/main/sample_mflix/movies.json
curl -L -o comments.json https://raw.githubusercontent.com/neelabalan/mongodb-sample-dataset/main/sample_mflix/comments.json
wc -l movies.json comments.json     # 23539 et 50304

docker cp movies.json   mongo-ipssi:/tmp/movies.json
docker cp comments.json mongo-ipssi:/tmp/comments.json

docker exec mongo-ipssi mongoimport -u admin -p ipssi2025 --authenticationDatabase admin \
  --db mflix --collection movies   --drop --file /tmp/movies.json
docker exec mongo-ipssi mongoimport -u admin -p ipssi2025 --authenticationDatabase admin \
  --db mflix --collection comments --drop --file /tmp/comments.json
```

```
23539 document(s) imported successfully. 0 document(s) failed to import.
50304 document(s) imported successfully. 0 document(s) failed to import.
```

**Contrôle P0** — `db.movies.countDocuments({})` = **23539**, `db.comments.countDocuments({})` = **50304** OK

> **Note d'environnement.** Le port 27017 de cette machine est déjà occupé par un `mongod`
> installé nativement (MongoDB 7.0.26, sans authentification) : les connexions depuis l'hôte
> tombaient dessus au lieu du conteneur, d'où un `AuthenticationFailed` en PyMongo. Le
> conteneur est donc publié en plus sur **27019** dans le `docker-compose.yml`, et c'est cette
> URI qu'utilise `patterns.py`. Les commandes `docker exec` ne sont pas concernées.

Structure des documents :

```js
// movies — tableaux : genres, cast, directors ; sous-documents : imdb, tomatoes, awards
[ '_id', 'plot', 'genres', 'runtime', 'cast', 'poster', 'title', 'fullplot',
  'languages', 'released', 'directors', 'rated', 'awards', 'lastupdated',
  'year', 'imdb', 'countries', 'type', 'tomatoes' ]

// comments — movie_id porte la référence vers movies._id
{ _id: ObjectId('5a9427648b0beebeb69579ea'),
  name: 'Cameron Duran', email: 'cameron_duran@fakegmail.com',
  movie_id: ObjectId('573a1390f29313caabcd433d'),   // <-- la référence
  text: 'Ad asperiores mollitia aperiam non incidunt...',
  date: ISODate('1989-01-21T14:20:47.000Z') }
```

---

## Partie 1 — Modélisation & intégrité référentielle

### Q1 — Volumétrie
```js
db.movies.countDocuments({})            // 23539
db.comments.countDocuments({})          // 50304
db.movies.distinct("genres").length     // 25
```
→ **23539** films, **50304** commentaires, **25** genres distincts.

### Q2 — Commentaires orphelins
```js
db.comments.aggregate([
  { $lookup: { from: "movies", localField: "movie_id", foreignField: "_id", as: "film" } },
  { $match: { film: { $size: 0 } } },
  { $count: "orphelins" }
])
// [ { orphelins: 9224 } ]
```
→ **9224** commentaires orphelins.

Le `$lookup` produit un tableau `film` vide quand aucun document de `movies` ne porte cet
`_id` : c'est exactement une jointure externe qui ne trouve rien. **18,34 %** des commentaires
pointent dans le vide, et la base ne s'en est jamais plainte — MongoDB n'a pas de clé
étrangère, `movie_id` n'est qu'un `ObjectId` comme un autre.

### Q3 — Films référencés par au moins un commentaire
```js
db.comments.aggregate([
  { $group: { _id: "$movie_id" } },
  { $count: "films_commentes" }
])
// [ { films_commentes: 14245 } ]
```
→ **14245** `movie_id` distincts. Attention : ce sont les valeurs distinctes présentes dans
`comments`, orphelines comprises — ce n'est donc pas le nombre de films réellement commentés.

### Q4 — Computed Pattern, première question d'écart

**(a)**
```js
db.movies.countDocuments({ num_mflix_comments: { $exists: true } })
```
→ **15740** films sur 23539, soit **66,9 %**. Un tiers du catalogue n'a même pas le champ.

**(b)**
```js
db.movies.findOne({ title: "The Taking of Pelham 1 2 3" }, { title: 1, num_mflix_comments: 1 })
// { _id: ObjectId('573a13bff29313caabd5e91e'), num_mflix_comments: 437 }

db.comments.countDocuments({ movie_id: ObjectId('573a13bff29313caabd5e91e') })
// 161
```
→ compteur stocké **437**, commentaires réels **161**.

**(c)** Écart absolu : **276**. Le compteur **sur-estime de +171,4 %** (437 / 161 = 2,7×) —
il annonce presque trois fois la réalité.

**(d)** L'utilisateur voit « **437 commentaires** » sous l'affiche, clique, et arrive sur une
page qui en affiche **161**. Il ne comprend pas ; au mieux il pense que le site a un bug, au
pire qu'on gonfle les chiffres pour paraître populaire.

Ce que ça révèle en général : **un compteur dénormalisé n'est pas une donnée, c'est un cache**.
Il n'est juste qu'à l'instant où il a été calculé, et rien dans le modèle ne le maintient. Dès
qu'une écriture passe à côté du chemin qui l'incrémente — une suppression en masse, un import,
un script de purge, une modération manuelle — il dérive silencieusement, sans erreur ni
avertissement. On mesure l'ampleur du phénomène sur tout le catalogue en Q16.

### Q5 — `year` en chaîne (type bracketing)
```js
db.movies.countDocuments({ year: { $type: "string" } })
// 37

db.movies.find({ year: { $type: "string" } }, { title: 1, year: 1, _id: 0 }).limit(3)
// [ { title: 'The Hitch Hikers Guide to the Galaxy', year: '1981è' },
//   { title: 'All Passion Spent',                   year: '1986è' },
//   { title: 'The Storyteller',                     year: '1987è' } ]
```
→ **37** films. Les valeurs sont du type `'1981è'` — un caractère parasite a suffi à faire
basculer le champ en chaîne à l'import.

Pourquoi `{ year: { $gte: 2000 } }` les ignore : BSON définit un **ordre entre les types**
(le *type bracketing*). Une comparaison ne s'applique qu'à l'intérieur d'un même type — un
`$gte` avec un opérande numérique ne compare qu'aux valeurs numériques. Les chaînes ne sont
pas « converties puis comparées », elles sont **exclues d'office**. Aucune erreur, aucun
avertissement : la requête renvoie **13721** résultats et l'on ne saura jamais que 37
documents n'ont pas été considérés. C'est le piège type du schéma flexible — en SQL, la
colonne `INT` aurait rejeté `'1981è'` à l'insertion.

### Q6 — `imdb.rating` vide
```js
db.movies.countDocuments({ "imdb.rating": "" })
```
→ **61** films.

Le piège pour une moyenne : `""` est une **chaîne vide, pas une absence**. `$avg` ignore les
valeurs non numériques, donc le résultat ne sera pas faux — mais un `$group` naïf qui
compterait les documents avec `$sum: 1` diviserait par un effectif incluant ces 61 films, et
tout traitement applicatif faisant un `float(rating)` lèverait une exception. D'où le
`$match: { "imdb.rating": { $type: "number" } }` en Q13 : on filtre par **type**, pas par
`$exists` — le champ existe, c'est sa valeur qui n'est pas exploitable.

---

## Partie 2 — Indexation & explain()

> Le détail complet des mesures (stage, `totalDocsExamined`, `totalKeysExamined`, `nReturned`,
> temps) est dans **[`index_bench.md`](index_bench.md)**. Synthèse ci-dessous.

### Q7 — Index multi-clés

**(a)** Avant tout index : stage **`COLLSCAN`**, `totalDocsExamined` = **23 539**,
`nReturned` = **105**.

**(b)**
```js
db.movies.createIndex({ genres: 1 })
```
Après : stage **`FETCH ← IXSCAN`**, `totalDocsExamined` = **105** (10 ms → 1 ms).

`genres` étant un tableau, MongoDB construit automatiquement un **index multi-clés** : une
entrée d'index par élément. Ratio examinés/retournés : 224 → 1.

### Q8 — Index composé & règle ESR

**(a)**
```js
db.movies.countDocuments({ genres: "Drama", year: { $gte: 2000 } })
```
→ **7761** films.

**(b)** Règle **ESR — Equality, Sort, Range** :

| Champ | Rôle dans la requête | Position |
|---|---|---|
| `genres: "Drama"` | **Equality** | 1er |
| `imdb.rating: -1` | **Sort** | 2e |
| `year: { $gte: 2000 }` | **Range** | 3e |

```js
db.movies.createIndex({ genres: 1, "imdb.rating": -1, year: 1 })
```

Justification : l'égalité en tête réduit immédiatement l'index à une plage contiguë de clés.
Dans cette plage, les entrées sont déjà ordonnées par `imdb.rating` — le tri est donc offert
par la structure de l'index. La plage arrive en dernier car, dès qu'un champ de plage
intervient, les champs suivants **ne sont plus globalement ordonnés** : les mettre avant le
champ de tri détruirait l'ordre.

**(c)** Vérification :

| | Stage | totalDocsExamined | nReturned | Temps |
|---|---|---|---|---|
| Avant | `SORT ← FETCH ← IXSCAN` | 13 789 | 7 761 | 26 ms |
| Après | **`FETCH ← IXSCAN`** | **7 761** | 7 761 | 10 ms |

**Le stage `SORT` a disparu** : plus aucun tri en mémoire, l'index livre les documents déjà
classés. (Preuve expérimentale de l'ordre ESR par `.hint()` : voir **R3**.)

### Q9 — Index text — la troisième solution du Jour 1

**(a)**
```js
db.movies.countDocuments({ title: { $regex: /Godfather/ } })
```
→ **5**

**(b)**
```js
db.movies.createIndex({ title: "text", plot: "text" })
db.movies.countDocuments({ $text: { $search: "godfather" } })
```
→ **12**

**(c)** Écart : **7 films**. Trois d'entre eux :

```js
db.movies.find({ $text: { $search: "godfather" }, title: { $not: /Godfather/ } },
               { title: 1, plot: 1, _id: 0 }).limit(3)
```

| Titre | Extrait du `plot` |
|---|---|
| Jane Austen's Mafia! | *Takeoff on the **Godfather** with the son of a mafia king…* |
| The Nutcracker in 3D | *…a little girl, whose **godfather** gives her a special doll…* |
| C(r)ook | *The mafia **godfather** suspects treason.* |

Ils sortent parce que leur **titre ne contient pas le mot** : c'est leur `plot` qui le porte.
L'index text couvre les deux champs déclarés, alors que le `$regex` ne portait que sur `title`.
Il ne s'agit donc pas d'une différence de casse mais de **périmètre indexé**, et c'est
exactement ce qu'attend un usager qui tape « godfather » dans une barre de recherche.

**(d)**
```js
db.movies.countDocuments({ $text: { $search: "godfathers" } })   // 12  <- identique
db.movies.countDocuments({ title: /godfathers/ })                // 0
```

Même résultat au pluriel : **12**. Le **stemming** ramène `godfathers` à la racine `godfather`
avant la recherche. Le `$regex` équivalent renvoie **0** — il compare des caractères, pas des
mots, et ne sait rien de la morphologie. C'est bien la réponse à la question laissée ouverte
au Jour 1 (Q9e) : l'index text règle d'un coup la casse, le stemming et le périmètre
multi-champs, tout en étant réellement indexé.

**(e)** Le `$regex` reste préférable dès qu'on cherche **une sous-chaîne qui n'est pas un mot
entier** : un numéro de série (`/^SN-2024-/`), un fragment de code, un identifiant, un
préfixe. L'index text découpe le texte **en mots** — chercher `2024` dans `SN-2024-8891`
échouera ou donnera un résultat imprévisible, alors qu'un `$regex` ancré (`/^SN-2024/`) est
exact et peut même exploiter un index B-Tree classique, puisqu'un préfixe ancré est une
recherche de plage.

### Q10 — Inventaire des index
```js
db.movies.getIndexes()
```

```
 - _id_                            {"_id":1}
 - genres_1                        {"genres":1}
 - genres_1_imdb.rating_-1_year_1  {"genres":1,"imdb.rating":-1,"year":1}
 - genres_1_year_1_imdb.rating_-1  {"genres":1,"year":1,"imdb.rating":-1}
 - title_text_plot_text            {"_fts":"text","_ftsx":1}
```

Celui que je n'ai pas créé : **`_id_`**. MongoDB le crée automatiquement à la création de
toute collection, il est unique et ne peut pas être supprimé.

```js
db.movies.dropIndex("title_text_plot_text")   // { nIndexesWas: 5, ok: 1 }
```

Pourquoi un index inutilisé est un **coût pur** : il n'accélère aucune lecture — puisque
personne ne l'utilise — mais il continue de payer les trois factures. **À l'écriture** :
chaque `insert`/`update`/`delete` doit mettre à jour *tous* les index de la collection.
**En mémoire** : un index n'est efficace que s'il tient dans le cache WiredTiger, donc il
occupe une RAM qu'il vole aux index utiles. **À l'exploitation** : il ralentit les
sauvegardes, les restaurations et les migrations. On le détecte avec
`db.movies.aggregate([{ $indexStats: {} }])` : un index dont `accesses.ops` reste à 0 est un
candidat à la suppression.

---

## Partie 3 — Agrégation analytique

Pipelines dans **[`analyses.js`](analyses.js)**, exécuté par :

```bash
docker exec -i mongo-ipssi mongosh -u admin -p ipssi2025 \
  --authenticationDatabase admin mflix < analyses.js
```

### Q11 — Top 5 des genres
```js
db.movies.aggregate([
  { $unwind: "$genres" },
  { $group: { _id: "$genres", nb: { $sum: 1 } } },
  { $sort: { nb: -1 } },
  { $limit: 5 }
])
```

| Genre | Films |
|---|---|
| Drama | **13 789** |
| Comedy | 7 024 |
| Romance | 3 665 |
| Crime | 2 678 |
| Thriller | 2 658 |

Le total dépasse 23 539 : un film porte plusieurs genres, `$unwind` le compte une fois par genre.

### Q12 — Films par décennie
```js
db.movies.aggregate([
  { $match: { year: { $type: "int" } } },
  { $project: { decennie: { $subtract: ["$year", { $mod: ["$year", 10] }] } } },
  { $group: { _id: "$decennie", nb: { $sum: 1 } } },
  { $sort: { nb: -1 } }
])
```

**Top 3 : 2000s = 7749 · 2010s = 5972 · 1990s = 3773.**

Suite : 1980s 2081, 1970s 1253, 1960s 1050, 1950s 767, 1940s 418, 1930s 313, 1920s 96,
1910s 23, 1890s 5, 1900s 2.

Le `$match` sur `$type: "int"` n'est pas cosmétique : sans lui, `$mod` sur les 37 `year` en
chaîne (Q5) fait échouer tout le pipeline avec une erreur de type.

### Q13 — Note IMDB moyenne des Drama
```js
db.movies.aggregate([
  { $match: { genres: "Drama", "imdb.rating": { $type: "number" } } },
  { $group: { _id: null, moyenne: { $avg: "$imdb.rating" }, nb: { $sum: 1 } } }
])
```
→ moyenne **6.8305** sur **13 751** films.

13 751 et non 13 789 (Q11) : **38** films Drama ont une note non numérique (cf. les 61 chaînes
vides de la Q6). Filtrer par type est ce qui rend l'effectif honnête.

### Q14 — Top 3 réalisateurs
```js
db.movies.aggregate([
  { $unwind: "$directors" },
  { $group: { _id: "$directors", nb: { $sum: 1 } } },
  { $sort: { nb: -1 } },
  { $limit: 3 }
])
```

| Réalisateur | Films |
|---|---|
| Woody Allen | **40** |
| John Ford | 35 |
| Takashi Miike | 34 |

### Q15 — `$lookup` inversé : top 5 des films les plus commentés
```js
db.comments.aggregate([
  { $group: { _id: "$movie_id", nb: { $sum: 1 } } },
  { $sort: { nb: -1 } },
  { $limit: 5 },
  { $lookup: { from: "movies", localField: "_id", foreignField: "_id", as: "film" } },
  { $unwind: "$film" },
  { $project: { _id: 0, titre: "$film.title", nb: 1, compteur_stocke: "$film.num_mflix_comments" } }
])
```

| Titre | Commentaires réels | `num_mflix_comments` |
|---|---|---|
| The Taking of Pelham 1 2 3 | **161** | 437 |
| Terminator Salvation | 158 | 416 |
| About a Boy | 158 | 441 |
| Ocean's Eleven | 158 | 424 |
| 50 First Dates | 158 | 403 |

On part de `comments` et non de `movies` : c'est la collection qui **porte la référence**, donc
la seule où le regroupement est direct. Le `$lookup` n'intervient qu'à la fin, sur 5 documents
— l'inverse aurait joint 23 539 films pour n'en garder que 5.

Le champ pré-calculé est faux sur **les 5 films du top**, et toujours dans le même sens :
sur-estimation d'un facteur ~2,7.

---

## Partie 4 — PyMongo

Script **[`patterns.py`](patterns.py)** (`pip install "pymongo>=4.6"` — version installée : 4.17.0).

### Q16 — Computed Pattern : réconciliation
```python
pipeline = [{"$group": {"_id": "$movie_id", "nb": {"$sum": 1}}}]
reels = {d["_id"]: d["nb"] for d in db.comments.aggregate(pipeline)}
```
→ **12 244** films ont un compteur incohérent.

Sur les **15 740** films portant le champ (Q4a), **77,8 %** sont faux.

Exemples relevés :

```
- Winsor McCay, the Famous Cartoonist... : 1 vs 0
- Blacksmith Scene                       : 1 vs 0
- The Land Beyond the Sunset             : 2 vs 1
- Traffic in Souls                       : 2 vs 1
- The Perils of Pauline                  : 1 vs 0
```

Note de performance : un `count_documents` par film ferait **23 539 aller-retours réseau**.
Un seul `aggregate` `$group` sur `comments` ramène tout d'un coup, la comparaison se fait
ensuite en mémoire dans un `dict` Python — une requête au lieu de 23 539.

### Q17 — Correction en `bulk_write`
```python
ops = [UpdateOne({"_id": _id}, {"$set": {"num_mflix_comments": reel}}) for ... in ecarts]
db.movies.bulk_write(ops, ordered=False).modified_count
```
→ `modifiedCount` = **12 244**, exactement les incohérences détectées.

Vérification immédiate : Q16 relancée renvoie **0 incohérence**.

`ordered=False` autorise le serveur à paralléliser les opérations et à ne pas s'arrêter à la
première erreur ; les 12 244 `UpdateOne` partent en un seul aller-retour réseau au lieu de
12 244.

### Q18 — Subset Pattern
```python
recents = list(db.comments.find({"movie_id": film["_id"]},
                                {"_id": 0, "name": 1, "text": 1, "date": 1})
                          .sort("date", -1).limit(3))
db.movies.bulk_write([UpdateOne({"_id": film["_id"]},
                                {"$set": {"recent_comments": recents}})])
```
→ **10** films mis à jour. Contrôle sur *The Taking of Pelham 1 2 3* : **3** sous-documents,
clés `['date', 'name', 'text']`.

```
- 2017-06-28 | Robert Baratheon   | Asperiores fugit doloribus ipsum suscipit cupiditate in...
- 2016-12-18 | Shireen Baratheon  | Perspiciatis deserunt saepe id nisi blanditiis. Distinc...
- 2016-09-22 | Deborah Kennedy    | Provident omnis excepturi aliquid quidem. Ratione cumqu...
```

**Pourquoi 3 et pas les 161 ?** Parce qu'on embarque ce que la **page d'accueil** affiche, pas
ce que la base contient. La fiche film montre un aperçu de quelques commentaires ; embarquer
les 161 ferait passer le document de 2 902 octets à environ **49 Ko** (161 × 285 o), soit
**17× plus lourd**, transporté intégralement à chaque affichage pour n'en montrer que trois.
Le Subset Pattern garde la donnée chaude dans le parent et laisse la donnée froide dans
`comments`, où elle reste accessible à la demande. C'est aussi ce qui borne le document : les
commentaires continueront d'affluer, mais `recent_comments` gardera toujours 3 entrées.

---

## Partie 5 — Transaction ACID multi-documents

Les transactions exigent un **replica set** — un `mongod` autonome ne les supporte pas
(pas d'oplog exploitable pour le rollback). Instance dédiée :

```bash
docker run -d --name mongo-rs -p 27018:27017 mongo:7.0 --replSet rs0
docker exec mongo-rs mongosh --port 27017 --eval 'rs.initiate({_id:"rs0",members:[{_id:0,host:"localhost:27017"}]})'
# { ok: 1 }
docker exec mongo-rs mongoimport --db mflix --collection movies   --drop --file /tmp/movies.json
docker exec mongo-rs mongoimport --db mflix --collection comments --drop --file /tmp/comments.json
```

### Q19 — Modération atomique

Script **[`transaction.js`](transaction.js)**, exécuté par
`docker exec -i mongo-rs mongosh --quiet mflix < transaction.js`.

**Transaction 1 — commit :**

```
avant  -> compteur = 437 | commentaires reels = 161
commit OK - commentaire supprime : 5a9427658b0beebeb697721d
apres  -> compteur = 436 | commentaires reels = 160
delta compteur = -1 | delta commentaires = -1
```

Les deux écritures — `deleteOne` sur `comments` et `$inc: -1` sur `movies` — sont passées
ensemble.

**Transaction 2 — abort provoqué au milieu :**

```
avant  -> compteur = 436 | commentaires reels = 160
suppression effectuee DANS la transaction
vue depuis la transaction  -> 159
vue depuis l'exterieur     -> 160   (isolation)
abortTransaction : panne simulee avant la mise a jour du compteur
apres  -> compteur = 436 | commentaires reels = 160
delta compteur = 0 | delta commentaires = 0
```

La ligne la plus intéressante : **159 dedans, 160 dehors** au même instant. La suppression
existe dans la session, elle est invisible pour tout le monde — puis `abortTransaction()` la
fait disparaître. Rien n'a été appliqué.

**Ce que garantit chaque lettre, ici concrètement :**

- **A — Atomicité.** Le `deleteOne` et le `$inc` forment un tout. La panne survient entre les
  deux : sans transaction, on aurait un commentaire supprimé et un compteur resté à 436 —
  une incohérence de plus, exactement du même genre que les 12 244 de la Q16.
- **C — Cohérence.** L'invariant métier « `num_mflix_comments` = nombre de commentaires
  référençant le film » est vrai avant (437/161, faux mais stable) et vrai après (436/160) —
  la transaction ne le dégrade pas. MongoDB ne vérifie pas cet invariant à ma place : c'est le
  périmètre de la transaction qui le préserve.
- **I — Isolation.** Démontré ci-dessus : 159 dans la session, 160 à l'extérieur. Avec
  `readConcern: "snapshot"`, la transaction travaille sur une photographie cohérente de la
  base et ne montre ses écritures qu'au commit.
- **D — Durabilité.** Le `writeConcern: { w: "majority" }` n'acquitte le commit qu'une fois
  l'écriture répliquée sur la majorité des membres. Une fois le commit rendu, un crash du
  primaire ne perd rien : le nouveau primaire élu porte déjà la donnée.

---

## Partie 6 — Réflexion

### R1 — Ce que le SGBD ne fait plus pour vous

La responsabilité qui bascule est **l'intégrité référentielle**. En SQL, une contrainte
`FOREIGN KEY` rend l'orphelin *impossible* : le moteur refuse l'insertion, ou propage la
suppression via `ON DELETE CASCADE`. MongoDB ne connaît pas `movie_id` comme une référence —
c'est un `ObjectId` parmi d'autres. Personne ne vérifie qu'il pointe quelque part.

Le chiffre : **9224 commentaires orphelins (Q2) sur 50 304 (Q1)**, soit **18,34 %** de la
collection qui pointe dans le vide. Près d'un commentaire sur cinq est rattaché à un film
inexistant, et rien dans la base ne le signale — il a fallu un `$lookup` pour le découvrir.

Deux stratégies côté application, et leur facture :

1. **Suppression en cascade applicative dans une transaction.** Supprimer un film déclenche,
   dans la même transaction, la suppression de ses commentaires. **Coût** : une transaction
   par suppression, donc un replica set obligatoire (Partie 5) et une latence supérieure ; et
   surtout une **couverture partielle** — la garantie ne vaut que pour le code qui passe par
   ce chemin. Un `mongoimport`, un script de purge, une correction manuelle en Compass la
   contournent, et c'est très probablement l'origine de nos 9224 orphelins.
2. **Validation de schéma (`$jsonSchema`) + job de réconciliation périodique.** Le schéma
   impose le type et la présence de `movie_id` à l'insertion ; un job nocturne rejoue la
   requête de la Q2 et alerte ou nettoie. **Coût** : le schéma valide le *format*, jamais
   l'*existence* de la cible — il n'aurait bloqué aucun de nos 9224 cas ; et le job travaille
   *a posteriori*, donc il existe toujours une fenêtre pendant laquelle la base est incohérente.

Aucune des deux ne rétablit la garantie du SGBD relationnel. C'est le prix assumé du modèle :
on échange une garantie forte contre la scalabilité horizontale, et **la vérification devient
un travail applicatif explicite**.

### R2 — Embed vs reference : la borne

Le film le plus commenté (Q15) porte **161 commentaires**. Un commentaire pèse en moyenne
**285 octets** (mesuré par `bsonsize()` sur 200 documents, méthode du Jour 1 R3), et le
document film fait **2 902 octets**.

Si l'on imbriquait tout : 2 902 + (161 × 285) = **48 787 octets ≈ 47,6 Ko**.

Face aux **16 Mo** de limite BSON, on est à **0,3 %**. **Ce n'est donc pas la limite des 16 Mo
qui tranche** — elle est hors de portée. Trois autres raisons décident :

1. **La croissance est non bornée.** 161 est un maximum *observé*, pas une contrainte. Rien
   n'empêche un film viral d'en accumuler 50 000 ; le jour où c'est le cas, le document devient
   ingérable et la migration est douloureuse. On modélise pour la trajectoire, pas pour l'état
   actuel.
2. **La lecture paie pour rien.** La fiche affiche 3 commentaires (Q18) ; embarquer les 161
   ferait transporter **17× le volume utile** à chaque affichage.
3. **L'écriture serait pathologique.** Chaque nouveau commentaire réécrirait un document de
   47 Ko au lieu d'en insérer un de 285 octets, avec contention sur le même document — or
   commenter est justement l'écriture la plus fréquente.

Le commentaire a en plus une **existence propre** : on liste les commentaires d'un
utilisateur, on modère, on signale — autant d'accès qui n'ont pas le film pour point d'entrée.
C'est le critère du cours (« l'entité liée existe indépendamment »).

**Dans quel cas imbriquerait-on quand même ?** Quand le nombre est **borné par le métier** et
que la lecture est toujours conjointe : les 3 derniers commentaires du Subset Pattern (Q18),
justement — bornés à 3 par construction. Ou une note de modération unique par commentaire
(1:1), ou les 5 dernières connexions d'un compte. La règle n'est pas « peu de données » mais
**« un maximum garanti par le modèle, pas par les données observées »**.

### R3 — ESR, vérifié par l'expérience

**Avec mes mots.** Un index composé est un annuaire trié par plusieurs colonnes, dans l'ordre
déclaré. Les valeurs du 2e champ ne sont ordonnées qu'**à l'intérieur** d'une valeur du 1er
champ, celles du 3e à l'intérieur d'un couple, etc.

- L'**Equality** vient en tête : elle fixe une valeur, donc l'index se réduit à une plage
  contiguë de clés. On paie une seule descente dans le B-Tree.
- Le **Sort** vient ensuite : à l'intérieur de cette plage, les entrées sont déjà rangées dans
  l'ordre voulu. Il suffit de les parcourir — le tri est gratuit.
- La **Range** vient en dernier, parce qu'elle **casse l'ordre de tout ce qui la suit** : elle
  balaye plusieurs valeurs, et chacune contient sa propre sous-séquence triée. Le moteur devra
  alors retrier en mémoire.

**La preuve.** Second index avec les mêmes champs dans le mauvais ordre, forcé par `.hint()` :

```js
db.movies.createIndex({ genres: 1, year: 1, "imdb.rating": -1 })

db.movies.find({ genres: "Drama", year: { $gte: 2000 } })
         .sort({ "imdb.rating": -1 })
         .hint({ genres: 1, year: 1, "imdb.rating": -1 })
         .explain("executionStats")
```

**(a)**

| Index | Stage `SORT` ? | totalKeysExamined | totalDocsExamined | Temps |
|---|---|---|---|---|
| `{ genres, imdb.rating, year }` — **ESR** | **non** | 7 834 | 7 761 | **11 ms** |
| `{ genres, year, imdb.rating }` — mauvais | **oui** | 7 761 | 7 761 | **34 ms** |

**(b)** Le mauvais ordre examine **73 clés de moins** (7 761 vs 7 834) — le `$gte` placé en 2e
position filtre un peu mieux — et exactement autant de documents. Il est pourtant
**3,1× plus lent : +23 ms, soit +209 %**. Le seul écart est le stage `SORT` sur 7 761
documents. Le plus coûteux est donc l'index « mieux filtrant » : l'économie de 73 clés ne pèse
rien face à un tri en mémoire. C'est précisément ce que la règle ESR encode.

**(c)** Si le tri en mémoire dépasse les **32 Mo** (33 554 432 octets) autorisés par défaut,
MongoDB **abandonne la requête** avec :

> `Sort exceeded memory limit of 33554432 bytes, but did not opt in to external sorting.`

Il faut alors soit passer `allowDiskUse()` sur le curseur (ou `allowDiskUse: true` en
agrégation) pour autoriser un tri sur disque — bien plus lent —, soit relever
`internalQueryMaxBlockingSortMemoryUsageBytes`. Mais le vrai correctif est ailleurs : **un
index qui couvre le tri**. Une requête qui n'a jamais besoin de trier ne rencontre jamais
cette limite — et c'est là que la règle ESR passe du confort à la nécessité, parce que le
problème ne se manifeste qu'en production, quand le volume a grossi.

### R4 — Patterns : le bénéfice et sa facture

**Le bénéfice, chiffré.** Sans le champ `num_mflix_comments`, afficher « N commentaires »
imposerait un `countDocuments` sur `comments` à chaque affichage de fiche. **14 245 films
sont concernés** (Q3), et une page d'accueil listant 20 films déclencherait **20 comptages**
au lieu de zéro. Le compteur pré-calculé transforme une agrégation par affichage en une simple
lecture de champ, déjà présente dans le document ramené : le gain est de **100 % des requêtes
d'agrégation de lecture**. C'est la raison d'être du Computed Pattern — un dashboard lu 100×
plus qu'il n'est écrit.

**Le risque, chiffré.** **12 244 compteurs faux (Q16)** sur les **15 740 films portant le champ
(Q4a)** : **77,8 %** sont incorrects. Ce n'est pas une dérive marginale, c'est la majorité
écrasante. Et l'erreur est massive sur les cas les plus visibles : le film le plus commenté
affiche 437 pour 161 réels (Q4c), soit **+171 %** — les fiches les plus consultées du site
sont les plus fausses. Pire : **rien ne signale l'erreur**. Pas d'exception, pas de log, pas
de contrainte violée. Il a fallu écrire la réconciliation de la Q16 pour la voir.

**Condition d'acceptabilité en production.** Le Computed Pattern est légitime **à condition
d'être traité comme un cache, pas comme une donnée** — c'est-à-dire trois choses réunies :

1. **Toute écriture qui affecte la valeur met le compteur à jour dans la même transaction**
   (Q19) — sinon la dérive est mathématiquement certaine.
2. **Un job de réconciliation périodique** rejoue le calcul et corrige (Q17 : 12 244 documents
   remis d'aplomb en un `bulk_write`, une seule requête réseau) — le filet de sécurité pour
   tout ce qui échappe au point 1 : imports, purges, corrections manuelles.
3. **Une tolérance métier explicite.** Un compteur d'affichage peut être faux quelques minutes
   sans dommage ; un solde bancaire, non. Si l'exactitude est requise à l'instant T, il ne
   faut pas de compteur dénormalisé — il faut compter.

Sans ces garde-fous, on n'a pas optimisé une lecture : on a **transformé une donnée exacte et
lente en une donnée rapide et fausse**, et on ne s'en aperçoit que par une réclamation
utilisateur.

---

## Checklist

- [x] `reponses_jour2.md` — Q1 → Q19 et R1 → R4
- [x] [`analyses.js`](analyses.js) — agrégations Q11 → Q15
- [x] [`patterns.py`](patterns.py) — PyMongo, Q16 → Q18
- [x] [`transaction.js`](transaction.js) — transaction ACID Q19 (commit + abort)
- [x] [`index_bench.md`](index_bench.md) — tableaux `explain()` avant / après
- [x] Bonus B1 (covered query), B2 (index partiel), B3 (TTL) — dans `index_bench.md`

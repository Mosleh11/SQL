# index_bench.md — mesures `explain("executionStats")` avant / après index

Base `mflix` · collection `movies` (23 539 documents) · MongoDB 7.0

Méthode : pour chaque requête, `.explain("executionStats")` est relancé avant et après
création de l'index. On relève le `stage` du `winningPlan`, `totalDocsExamined`,
`totalKeysExamined` et `nReturned`.

---

## Q7 — Index multi-clés sur un tableau

Requête : `db.movies.find({ genres: "Film-Noir" })`

| | Stage | totalDocsExamined | totalKeysExamined | nReturned | Temps |
|---|---|---|---|---|---|
| **Avant** | `COLLSCAN` | **23 539** | 0 | 105 | 10 ms |
| **Après** `createIndex({ genres: 1 })` | `FETCH ← IXSCAN` | **105** | 105 | 105 | 1 ms |

Ratio examinés / retournés : **224 → 1**.
`genres` est un tableau : MongoDB crée automatiquement un **index multi-clés**, avec une
entrée d'index par élément du tableau. Aucune syntaxe particulière n'est nécessaire.

---

## Q8 — Index composé et règle ESR

Requête : `db.movies.find({ genres: "Drama", year: { $gte: 2000 } }).sort({ "imdb.rating": -1 })`
Résultat du filtre seul : **7 761** films.

| | Stage | totalDocsExamined | totalKeysExamined | nReturned | Temps |
|---|---|---|---|---|---|
| **Avant** (index `genres_1` seul) | `SORT ← FETCH ← IXSCAN` | 13 789 | 13 789 | 7 761 | 26 ms |
| **Après** `{ genres: 1, "imdb.rating": -1, year: 1 }` | `FETCH ← IXSCAN` | **7 761** | 7 834 | 7 761 | 10 ms |

Deux gains, et le second est le plus important :

1. `totalDocsExamined` passe de 13 789 à 7 761 — on n'examine plus que les documents retournés.
2. **Le stage `SORT` disparaît.** Avant, le moteur remontait les 13 789 Drama puis triait les
   7 761 survivants **en mémoire**. Après, l'index les livre déjà dans l'ordre de
   `imdb.rating` décroissant : le tri est *couvert par l'index*, coût zéro.

---

## R3 — Preuve de la règle ESR par `.hint()`

Même requête, deux index composés contenant **exactement les mêmes champs**, dans deux
ordres différents, forcés avec `.hint()` :

| Index | Ordre | Stage | totalKeysExamined | totalDocsExamined | Temps |
|---|---|---|---|---|---|
| `genres_1_imdb.rating_-1_year_1` | **E → S → R** (correct) | `FETCH ← IXSCAN` | 7 834 | 7 761 | **11 ms** |
| `genres_1_year_1_imdb.rating_-1` | E → R → S (incorrect) | `FETCH ← SORT ← IXSCAN` | 7 761 | 7 761 | **34 ms** |

- Le mauvais ordre lit **73 clés d'index de moins** (7 761 contre 7 834) — le `$gte` est mieux
  ciblé — mais il paie un **stage `SORT` en mémoire** sur 7 761 documents.
- Résultat : **3,1× plus lent** (34 ms contre 11 ms), soit **+209 %**, à volume de données
  strictement identique. Le coût du tri en mémoire dépasse largement l'économie de 73 clés.

Explication : un index est trié **hiérarchiquement**. Dès qu'un champ de plage (`Range`)
apparaît, les champs suivants ne sont plus globalement ordonnés — ils ne le sont qu'à
l'intérieur de chaque valeur du champ de plage. Placer `year` (Range) avant `imdb.rating`
(Sort) détruit donc l'ordre de tri que l'index aurait pu fournir gratuitement.

---

## Q9 — Index text vs `$regex`

| Recherche | Résultats |
|---|---|
| `{ title: { $regex: /Godfather/ } }` | 5 |
| `$text: { $search: "godfather" }` (index `title_text_plot_text`) | **12** |
| `$text: { $search: "godfathers" }` (pluriel) | **12** — stemming |
| `{ title: /godfathers/ }` (pluriel, regex) | **0** |

---

## Bonus B1 — Covered query

```js
db.movies.createIndex({ year: 1, title: 1 })
db.movies.find({ year: 2000 }, { _id: 0, year: 1, title: 1 }).explain("executionStats")
```

| Stage | totalDocsExamined | totalKeysExamined | nReturned |
|---|---|---|---|
| `PROJECTION_COVERED ← IXSCAN` | **0** | 618 | 618 |

`totalDocsExamined = 0` : la collection n'est **jamais touchée**. Le filtre et la projection
ne portent que sur des champs présents dans l'index, donc le résultat est lu entièrement
dans le B-Tree — pas de stage `FETCH`. Condition indispensable : exclure `_id` de la
projection, sinon il faut aller chercher le document.

## Bonus B2 — Index partiel

```js
db.movies.createIndex({ "imdb.votes": 1 }, { name: "votes_complet" })
db.movies.createIndex({ "imdb.votes": 1 },
  { name: "votes_partiel", partialFilterExpression: { type: "series" } })
```

| Index | Documents indexés | Taille |
|---|---|---|
| `votes_complet` | 23 539 | **184 320 o** (180 Ko) |
| `votes_partiel` | 254 (`type: "series"`) | **20 480 o** (20 Ko) |

**9× plus léger** pour la même utilité sur les séries. Un index doit tenir en RAM pour être
efficace : n'indexer que le sous-ensemble réellement interrogé est un gain direct de mémoire
et d'écritures (les 23 285 films n'ont plus à mettre cet index à jour).

## Bonus B3 — Index TTL

```js
db.sessions.createIndex({ createdAt: 1 }, { expireAfterSeconds: 3600 })
// { v: 2, key: { createdAt: 1 }, name: 'createdAt_1', expireAfterSeconds: 3600 }
```

Un thread de fond passe environ toutes les 60 s et supprime les documents dont `createdAt`
dépasse une heure. Cas d'usage : **sessions utilisateur, tokens, caches, logs à rétention
courte** — la purge devient une propriété du schéma au lieu d'un cron applicatif qu'on
oublie de surveiller. L'expiration n'est donc pas à la seconde près, ce qui interdit de s'en
servir comme d'un mécanisme d'expiration strict (sécurité).

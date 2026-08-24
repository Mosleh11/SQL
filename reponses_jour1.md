# TP Jour 1 — Introduction au NoSQL & MongoDB

**Mohammed Monsleh** — MIA4 · Conception et intégration d'un SGBD NoSQL — IPSSI Montpellier
Jeu de données : `primer-dataset.json` (NYC DOHMH), base `nyc`, collection `restaurants`.

---

## Partie 0 — Environnement

Stack lancée avec le `docker-compose.yml` fourni (MongoDB 7.0 + mongo-express) :

```bash
docker compose up -d
docker compose ps
```

```
NAME                  STATUS
mongo-ipssi           Up
mongo-express-ipssi   Up
```

Récupération et import du jeu de données :

```bash
curl -L -o primer-dataset.json \
  https://raw.githubusercontent.com/mongodb/docs-assets/primer-dataset/primer-dataset.json
wc -l primer-dataset.json          # 25359

docker cp primer-dataset.json mongo-ipssi:/tmp/primer-dataset.json
docker exec mongo-ipssi mongoimport \
  --username admin --password ipssi2025 --authenticationDatabase admin \
  --db nyc --collection restaurants --drop --file /tmp/primer-dataset.json
```

```
25359 document(s) imported successfully. 0 document(s) failed to import.
```

Connexion :

```bash
docker exec -it mongo-ipssi mongosh -u admin -p ipssi2025 --authenticationDatabase admin
```

**Point de contrôle P0** — `use nyc` puis `db.restaurants.countDocuments({})` → **25359** OK
Interface graphique : mongo-express sur http://localhost:8081 (voir `capture_express.png`).

Structure d'un document (`db.restaurants.findOne()`) :

```js
{
  _id: ObjectId('...'),
  address: { building: '1839', coord: [ -73.9482609, 40.6408271 ],
             street: 'Nostrand Avenue', zipcode: '11226' },
  borough: 'Brooklyn',
  cuisine: 'Ice Cream, Gelato, Yogurt, Ices',
  grades: [ { date: ISODate('2014-07-14'), grade: 'A', score: 12 }, ... ],
  name: 'Taste The Tropics Ice Cream',
  restaurant_id: '40356731'
}
```

`address` est un sous-document (avec `coord` en tableau), `grades` un tableau de sous-documents.

---

## Partie 1 — Lecture & opérateurs

### Q1 — Total de restaurants
```js
db.restaurants.countDocuments({})
```
→ **25359**

### Q2 — Types de cuisine distincts
```js
db.restaurants.distinct("cuisine").length
```
→ **85**

### Q3 — Brooklyn
```js
db.restaurants.countDocuments({ borough: "Brooklyn" })
```
→ **6086**

### Q4 — Cuisine French
```js
db.restaurants.countDocuments({ cuisine: "French" })
```
→ **344**

### Q5 — Manhattan ET Italian
```js
db.restaurants.countDocuments({ borough: "Manhattan", cuisine: "Italian" })
```
→ **621**

### Q6 — Bronx ET Chinese
```js
db.restaurants.countDocuments({ borough: "Bronx", cuisine: "Chinese" })
```
→ **323**

### Q7 — Restaurants nommés "Subway"
```js
db.restaurants.countDocuments({ name: "Subway" })
db.restaurants.find({ name: "Subway" }, { name: 1, borough: 1, _id: 0 }).limit(3)
```
→ **421**

```js
[ { borough: 'Manhattan', name: 'Subway' },
  { borough: 'Manhattan', name: 'Subway' },
  { borough: 'Queens',    name: 'Subway' } ]
```

### Q8 — $in sur 4 cuisines asiatiques
```js
db.restaurants.countDocuments({ cuisine: { $in: ["Japanese","Korean","Thai","Indian"] } })
```
→ **1623**

### Q9 — Le champ de recherche qui ment

**(a)** `db.restaurants.countDocuments({ name: /BBQ/ })` → **0**

**(b)** `db.restaurants.countDocuments({ name: /BBQ/i })` → **73**

**(c)** Écart : **73** résultats. Autrement dit la recherche sensible à la casse ne trouve **rien** alors qu'il y a 73 restaurants concernés. Trois exemples que seule la version (b) ramène :

```js
db.restaurants.find({ name: { $regex: /BBQ/i, $not: /BBQ/ } }, { name: 1, _id: 0 }).limit(3)
// [ { name: 'Dallas Bbq' }, { name: 'Dallas Bbq' }, { name: "Virgil'S Bbq" } ]
```

Dans la base, le sigle n'est jamais écrit `BBQ` : l'export a été normalisé en *Title Case*, donc c'est toujours **`Bbq`**. L'usager tape le mot comme dans la vraie vie, la base le stocke autrement — la recherche exacte ne peut structurellement rien trouver.

**(d)** Avec `House` :
```js
db.restaurants.countDocuments({ name: /House/ })   // 387
db.restaurants.countDocuments({ name: /House/i })  // 503
```
Écart de **116**, mais la cause est différente. Ici `House` existe bien avec sa majuscule ; ce que la version insensible ramène en plus, ce sont les noms où `house` est **collé en fin de mot composé** : `Peter Luger Steakhouse`, `Roadhouse Restaurant`, `Keens Steakhouse`, `The Clubhouse`. Ce n'est pas un problème d'orthographe du terme mais de **frontière de mot** : un `$regex` non ancré matche n'importe quelle sous-chaîne, y compris à l'intérieur d'un mot. Les 116 en plus sont d'ailleurs discutables — un usager qui cherche « House » veut-il vraiment tous les *steakhouse* ?

**(e)** Entre (a) et (b) je livre **(b)**, l'insensible : (a) renvoie 0 sur un terme qui concerne 73 établissements, c'est un bug utilisateur immédiat. Mais c'est un pansement : un `$regex` non ancré ne peut pas faire de recherche par préfixe dans un index, et le drapeau `i` interdit en plus d'exploiter un index standard — sur 25359 documents on fait donc un COLLSCAN à chaque frappe (cf. B1 : 25309 documents examinés sans index). La vraie solution en production est un **index texte** (`createIndex({ name: "text" })` + `$text: { $search: "bbq" }`), qui normalise la casse et découpe en mots à l'indexation : il règle d'un coup le cas (b) *et* le faux positif « steakhouse » du cas (d). À construire au Jour 2.

### Q10 — Code postal 10462
```js
db.restaurants.countDocuments({ "address.zipcode": "10462" })
```
→ **150**

### Q11 — restaurant_id "30075445"
```js
db.restaurants.findOne({ restaurant_id: "30075445" }, { name: 1, _id: 0 })
```
→ **Morris Park Bake Shop**

---

## Partie 2 — Tableaux & sous-documents

### Q12 — Au moins une note > 50
```js
db.restaurants.countDocuments({ "grades.score": { $gt: 50 } })
```
→ **349**

### Q13 — « Mal noté » — mais quand ?

**(a)** au moins un `C` dans tout l'historique :
```js
db.restaurants.countDocuments({ "grades.grade": "C" })
```
→ **2708**

**(b)** première entrée du tableau égale à `C` :
```js
db.restaurants.countDocuments({ "grades.0.grade": "C" })
```
→ **220**

**(c)** Écart : **2488** restaurants. En ouvrant le tableau `grades` d'un document, les `date` sont rangées en ordre **décroissant** :

```js
db.restaurants.findOne({ "grades.5": { $exists: true } },
                       { name: 1, "grades.date": 1, "grades.grade": 1, _id: 0 })
// Harriet'S Kitchen : 2014-09-15, 2014-03-04, 2013-07-18, 2013-01-09, 2012-04-10, 2011-11-15
```

L'indice **0 est donc la note la plus récente**, pas la plus ancienne. C'est la requête **(b) = 220** qui répond à « restaurants *actuellement* mal notés », et c'est celle que je publierais. La (a) répond à « a déjà été mal noté au moins une fois », ce qui est presque 12 fois plus large : publier 2708 sous le titre « les restaurants mal notés de New York » mettrait au pilori 2488 établissements qui se sont depuis remis en règle. C'est exactement le genre d'erreur de lecture d'un tableau qui finit en droit de réponse.

### Q14 — Tableau grades vide
```js
db.restaurants.countDocuments({ grades: { $size: 0 } })
```
→ **738**

Un tableau vide n'est pas une anomalie de format : c'est un restaurant **enregistré mais jamais encore inspecté** — nouvel établissement, ouverture récente, ou inspection planifiée non réalisée à la date de l'export. Le document est valide, il lui manque juste l'historique.

### Q15 — Au moins 6 notes
```js
db.restaurants.countDocuments({ "grades.5": { $exists: true } })
```
→ **3864**

L'index positionnel `grades.5` teste l'existence du 6e élément — s'il existe, le tableau en a au moins 6.

### Q16 — Première note = "A"
```js
db.restaurants.countDocuments({ "grades.0.grade": "A" })
```
→ **20687**

### Q17 — Le piège $elemMatch

**(a)** requête naïve :
```js
db.restaurants.countDocuments({ "grades.grade": "B", "grades.score": { $gt: 20 } })
```
→ **4908**

**(b)** requête correcte :
```js
db.restaurants.countDocuments({ grades: { $elemMatch: { grade: "B", score: { $gt: 20 } } } })
```
→ **4280**

**(c)** Écart de **628**. La version naïve teste les deux conditions **indépendamment sur l'ensemble du tableau** : un restaurant ayant un `B` à 15 en 2013 et un `A` à 30 en 2014 la satisfait, alors qu'aucune de ses notes ne réunit les deux critères. `$elemMatch` impose que ce soit **le même élément** qui vérifie tout. C'est **4280** qui répond à la question métier.

### Q18 — Anomalies de qualité

**(a)** scores négatifs :
```js
db.restaurants.countDocuments({ "grades.score": { $lt: 0 } })
```
→ **13** restaurants (et 13 notes concernées, score minimum observé : **-1**).

Non, un score négatif n'a aucun sens métier : le score d'inspection est un **nombre de points de pénalité**, il démarre à 0 et monte quand l'établissement cumule des infractions. Un -1 ne peut être qu'une erreur de saisie ou de conversion à l'export.

**(b)** impact sur la moyenne :
```js
db.restaurants.aggregate([
  { $unwind: "$grades" },
  { $group: { _id: null, moy: { $avg: "$grades.score" }, n: { $sum: 1 } } }
])
// { moy: 11.434842161583735, n: 93463 }

db.restaurants.aggregate([
  { $unwind: "$grades" },
  { $match: { "grades.score": { $gte: 0 } } },
  { $group: { _id: null, moy: { $avg: "$grades.score" }, n: { $sum: 1 } } }
])
// { moy: 11.436572235838051, n: 93437 }
```

| | Moyenne | Notes |
|---|---|---|
| Avec les négatives | 11,4348 | 93 463 |
| Sans les négatives | 11,4366 | 93 437 |

Écart : 0,0017 point, soit **+0,015 %**.

**(c)** Non, pas d'urgence — et je m'appuie sur le chiffre, pas sur une impression. 13 notes sur 93 463 (**0,014 %** du volume) déplacent la moyenne globale de **0,015 %** : sur un indicateur agrégé, l'anomalie est invisible, on est très loin de tout seuil de décision. Ce qui justifierait une correction, ce n'est donc pas la statistique mais **l'usage unitaire** : si ces 13 documents s'affichent en fiche restaurant, un « score : -1 » discrédite la fiche et alimente un signalement. Traitement raisonnable : correction planifiée au prochain cycle qualité (mise à `null` ou re-import de la source), pas de hotfix.

### Q19 — Score maximal du jeu
```js
db.restaurants.find({}, { name: 1, "grades.score": 1, _id: 0 })
  .sort({ "grades.score": -1 }).limit(1)
```
→ **Murals On 54/Randolphs'S**, score maximal **131**

Sur un champ tableau, le tri décroissant classe le document d'après la **valeur maximale** de son tableau : le premier résultat porte donc le plus haut score de tout le jeu. (Vérifié par agrégation : `$max` sur `grades.score` = 131.)

---

## Partie 3 — Création & mise à jour

> À partir d'ici la base est modifiée : les comptages ne correspondent plus à ceux de la Partie 1. Le détail des écarts est reconstitué en Q27.

### Q20 — CREATE
```js
db.restaurants.insertOne({
  name: "Chez MM Bistrot",
  borough: "Montpellier",
  cuisine: "French",
  address: { building: "12", street: "Rue de la Loge", zipcode: "34000",
             coord: [3.8767, 43.6108] },
  grades: [ { date: new Date(), grade: "A", score: 7 } ],
  restaurant_id: "99999999"
})
// { acknowledged: true, insertedId: ObjectId('6a8c47e12d304a3db6a015c8') }

db.restaurants.findOne({ name: "Chez MM Bistrot" })
```
Document retrouvé, avec `borough: 'Montpellier'` et une note `{ grade: 'A', score: 7 }`. **+1 document** (25360).

### Q21 — UPDATE ciblé ($push)
```js
db.restaurants.updateOne(
  { restaurant_id: "30075445" },
  { $push: { grades: { date: new Date(), grade: "A", score: 3 } } }
)
// { matchedCount: 1, modifiedCount: 1 }

db.restaurants.findOne({ restaurant_id: "30075445" }).grades.length
```
→ **6 notes** (il en avait 5). La nouvelle note est ajoutée **en fin de tableau** — donc, vu l'ordre anti-chronologique constaté en Q13, elle se retrouve à la position de la plus *ancienne*. Pour respecter la convention du jeu il aurait fallu `$push: { grades: { $each: [...], $position: 0 } }`.

### Q22 — UPDATE de masse ($set)
```js
db.restaurants.updateMany({ "grades.score": { $gt: 50 } }, { $set: { risque: "eleve" } })
```
→ `matchedCount: 349`, `modifiedCount: 349`

Cohérent avec la Q12 (349). Les deux nombres sont égaux car aucun document ne portait déjà le champ `risque` : MongoDB ne compte dans `modifiedCount` que les documents réellement changés.

### Q23 — UPDATE conditionnel
```js
db.restaurants.updateMany({ cuisine: "French" }, { $set: { label_qualite: true } })
```
→ `matchedCount: 345`, `modifiedCount: 345`

345 et non 344 (Q4) : mon restaurant de la Q20 est lui aussi en `cuisine: "French"`.

---

## Partie 4 — Suppression & qualité de données

### Q24 — Documents borough "Missing"
```js
db.restaurants.countDocuments({ borough: "Missing" })
```
→ **51**

### Q25 — Suppression
```js
db.restaurants.deleteMany({ borough: "Missing" })
// { acknowledged: true, deletedCount: 51 }

db.restaurants.countDocuments({})
```
→ **25309** documents restants.

### Q26 — Décision de gouvernance

**(a)** Les tableaux `grades` vides après la Q25 :
```js
db.restaurants.countDocuments({ grades: { $size: 0 } })
```
→ **737** (738 en Q14, moins 1 qui faisait partie des 51 supprimés)

737 / 25309 = **2,91 %** de la collection.

**(b)** Les deux anomalies n'ont pas la même nature. Un `borough: "Missing"` est une **donnée perdue et irrécupérable** : la valeur existait à la source, l'export l'a détruite, et rien dans le document ne permet de la reconstituer — le document ment sur lui-même et fausserait toute agrégation par arrondissement. Un `grades: []` ne ment sur rien : c'est un **état légitime et temporaire**, celui d'un restaurant pas encore inspecté, et la prochaine inspection le remplira. On supprime ce qui est faux et non réparable, on garde ce qui est vrai et incomplet.

---

## Partie 5 — Automatisation

### Q27 — rapport.js

Fichier `rapport.js` (voir le livrable), exécuté par :

```bash
docker exec -i mongo-ipssi mongosh -u admin -p ipssi2025 \
  --authenticationDatabase admin nyc < rapport.js
```

Sortie :

```
=========================================
  RAPPORT NYC RESTAURANTS
=========================================

1) Total restaurants : 25309

2) Top 5 des cuisines
   1. American : 6173 (24.4 %)
   2. Chinese : 2412 (9.5 %)
   3. Café/Coffee/Tea : 1210 (4.8 %)
   4. Pizza : 1162 (4.6 %)
   5. Italian : 1069 (4.2 %)

3) Restaurants par arrondissement
   - Bronx : 2338
   - Brooklyn : 6086
   - Manhattan : 10259
   - Montpellier : 1
   - Queens : 5656
   - Staten Island : 969

Nombre de cuisines distinctes : 85
=========================================
```

**Reconstitution de l'écart avec la Q1**

| Opération | Effet | Total |
|---|---|---|
| Import initial (Q1) | — | 25359 |
| Q20 — `insertOne` de *Chez MM Bistrot* | **+1** | 25360 |
| Q21 / Q22 / Q23 — updates (`$push`, `$set`) | **0** (modifient, n'ajoutent pas) | 25360 |
| Q25 — `deleteMany({ borough: "Missing" })` | **−51** | 25309 |

Écart net : **−50 documents** (25359 → 25309).

Et l'arrondissement **`Montpellier`**, qui n'existait pas au départ, vient de mon insertion en Q20 : `distinct("borough")` ne lit aucun schéma, il retourne simplement les valeurs présentes. C'est l'illustration directe du schéma flexible — un seul document suffit à créer une nouvelle modalité dans un rapport, sans erreur ni avertissement. En SQL une contrainte d'intégrité l'aurait refusé.

### Q28 — Export Staten Island
```bash
docker exec mongo-ipssi mongoexport \
  --username admin --password ipssi2025 --authenticationDatabase admin \
  --db nyc --collection restaurants \
  --query '{"borough":"Staten Island"}' --out /tmp/staten_island.json
# exported 969 records

wc -l staten_island.json   # 969
```

→ **969 lignes** (format JSON Lines : une ligne = un document), cohérent avec le rapport Q27.

---

## Partie 6 — Réflexion

### R1 — Les 5 V, chiffrés

**Volume.** 25 359 restaurants (Q1) et 93 463 notes d'inspection après `$unwind` (Q18b) : ce n'est pas encore du Big Data, mais l'ordre de grandeur se voit déjà à l'exécution — une recherche `cuisine: "French"` sans index examine **25 309 documents** en COLLSCAN (B1), contre 345 avec index. Le volume ne devient un problème que quand la structure d'accès ne suit pas.

**Variété.** 85 cuisines distinctes (Q2), dont des valeurs qui ne sont pas des catégories mais des phrases : `"Latin (Cuban, Dominican, Puerto Rican, South & Central American)"`, `"Bottled beverages, including water, sodas, juices, etc."`, ou encore `"CafÃ©/Coffee/Tea"` (2 documents) qui côtoie `"Café/Coffee/Tea"` (1210) — un problème d'encodage à la source. Aucune table de référence n'encadre ce champ : c'est la contrepartie exacte du schéma flexible.

**Véracité.** **13** documents portent une note à score négatif (Q18a), ce qui déplace le score moyen de **+0,015 %** seulement (Q18b) — l'anomalie est réelle mais statistiquement nulle. Bien plus lourds : les **51** documents à `borough: "Missing"` (Q24), irrécupérables, et les **737** tableaux `grades` vides (Q26a), soit **2,91 %** de la collection. Trois anomalies, trois traitements différents (corriger, supprimer, garder) : la véracité n'est pas un pourcentage global, c'est une décision par type d'erreur.

**Valeur.** Le même jeu répond « 2708 » ou « 220 » à la question « combien de restaurants mal notés ? » (Q13a / Q13b) — un écart de **2488**. La donnée brute ne vaut rien ; c'est la compréhension de sa structure (l'indice 0 du tableau `grades` est la note la plus récente) qui la transforme en information publiable. Une valeur mal extraite ne vaut pas zéro, elle vaut moins que zéro : elle induit en erreur avec l'autorité du chiffre.

### R2 — CAP & BASE appliqués à ce service

MongoDB est **CP** : en cas de partition réseau, le nœud isolé refuse les écritures et, selon la `readConcern`, peut refuser de servir la lecture — il sacrifie la disponibilité pour ne jamais renvoyer de donnée périmée.

Scénario : **Morris Park Bake Shop** (Q11, `restaurant_id: "30075445"`), qui vient d'être fermé pour insalubrité. L'inspecteur pousse la fermeture sur le primaire ; à cet instant une partition coupe le réplica qui sert l'application publique.

**(a) Si on privilégie C** — l'usager qui consulte la fiche reçoit une **erreur ou un délai** : « service temporairement indisponible ». Il n'apprend rien, mais il n'apprend rien de faux. Il ira au restaurant sans information, ou consultera ailleurs.

**(b) Si on privilégie A** — la fiche s'affiche instantanément, avec l'**ancien état** : « Grade A, score 3 » (Q21). L'usager y va en confiance, sur la foi d'une donnée que le service sait obsolète. C'est un risque sanitaire, et une responsabilité juridique pour la Ville.

**Je tranche pour C.** Sur un service d'inspection sanitaire, une donnée fausse est plus dangereuse qu'une donnée absente : l'absence pousse l'usager à la prudence, l'erreur le pousse à l'imprudence. Le dommage que j'accepte est réel — indisponibilité pendant la partition, dégradation de l'expérience, appels au support, et un service public qui ne répond pas. Je l'accepte parce qu'il est **visible et réversible**, là où une intoxication liée à une fiche périmée ne l'est pas. Nuance pratique : je resterais AP sur les données froides (nom, adresse, cuisine) et CP uniquement sur `grades` — CAP se choisit par usage, pas par base.

### R3 — Embarqué vs référencé, le calcul

**(a)** Mesure sur le document de la Q21 (*Morris Park Bake Shop*, **6 notes** après le `$push`) :

```js
var d = db.restaurants.findOne({ restaurant_id: "30075445" });
bsonsize(d)                                      // 524 octets
bsonsize(Object.assign({}, d, { grades: [] }))   // 248 octets
```

(524 − 248) / 6 = **46 octets par note** (date 8 o + grade 1 o + score 4 o, plus les clés BSON et leur overhead).

Et ce n'est pas marginal : sur ce document les notes pèsent 276 octets sur 524, soit **53 % du document**. Les **3864** restaurants ayant au moins 6 notes (Q15) sont dans ce régime où l'historique pèse plus lourd que l'identité du restaurant.

**(b)** Inspection hebdomadaire pendant 10 ans → 520 notes :

248 + (520 × 46) = **24 168 octets ≈ 23,6 Ko**

Limite d'un document BSON : **16 Mo (16 777 216 octets)**. On est à **0,14 %** de la limite — le modèle embarqué tient très largement. Pour la saturer il faudrait environ **364 000 notes**, soit près de **7 000 ans** d'inspections hebdomadaires.

**(c)** **Avantage** : une seule lecture ramène le restaurant et tout son historique, sans jointure — c'est exactement l'accès dont l'application a besoin (afficher une fiche), et c'est ce qui rend une requête comme la Q17 (`$elemMatch`) possible en un seul passage.

**Limite** : le tableau croît sans borne alors que le reste du document est fixe. Bien avant les 16 Mo, on paie sur trois plans : chaque lecture de fiche transporte 100 % de l'historique même pour n'afficher que la dernière note ; chaque `$push` réécrit un document qui grossit, avec un risque de déplacement sur disque ; et la donnée chaude (le grade courant) se dilue dans la donnée froide.

**Seuil de bascule** : je passerais en référencé (collection `inspections` séparée, avec `restaurant_id` indexé, et le dernier grade dénormalisé dans le restaurant) à partir d'environ **quelques centaines de notes ou ~100 Ko par document** — pas parce que la limite BSON approche, mais parce que le ratio utile/transporté devient mauvais. Ici, avec un maximum observé bien en deçà, **l'embarqué est le bon choix** : la règle est « embarquer quand le tableau est borné et lu avec son parent », et c'est le cas.

---

## Pour aller plus loin

### B1 — Index sur cuisine

```js
db.restaurants.find({ cuisine: "French" }).explain("executionStats")
```

| | Stage | totalDocsExamined | totalKeysExamined | Temps |
|---|---|---|---|---|
| **Avant** index | `COLLSCAN` | **25 309** | 0 | 8 ms |
| **Après** `createIndex({ cuisine: 1 })` | `IXSCAN` (+ FETCH) | **345** | 345 | 1 ms |

Le stage passe de **COLLSCAN à IXSCAN** et `totalDocsExamined` tombe de **25 309 à 345** — soit exactement le nombre de résultats : le moteur ne lit plus que les documents qu'il va effectivement renvoyer, au lieu de parcourir toute la collection. Ratio examinés/retournés : 73 → 1.

### B2 — Index géospatial

```js
db.restaurants.createIndex({ "address.coord": "2dsphere" })

db.restaurants.find({
  "address.coord": {
    $near: {
      $geometry: { type: "Point", coordinates: [-73.9857, 40.7484] },  // Empire State Building
      $maxDistance: 500
    }
  }
}, { name: 1, cuisine: 1, _id: 0 })
```

→ **413** restaurants à moins de 500 m. Les 3 plus proches :

```js
[ { cuisine: 'American', name: 'Legends Nyc' },
  { cuisine: 'Irish',    name: "Foley'S N.Y. Pub And Restaurant" },
  { cuisine: 'American', name: 'Smash Burger' } ]
```

À noter : `$near` trie par distance croissante et ne peut donc pas s'utiliser dans `countDocuments()` (erreur `Location5626500`) — il faut compter côté curseur, ou passer par `$geoWithin` si le tri n'est pas nécessaire.

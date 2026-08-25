# TP MongoDB — Module MIA4 (IPSSI)

Module **MIA4 · Conception et intégration d'un SGBD NoSQL** — IPSSI
Mohammed Monsleh

Travaux pratiques sur MongoDB, réalisés sur des jeux de données réels dans un
environnement Docker reproductible.

---

## Jour 1 — Introduction au NoSQL & MongoDB

Inspections d'hygiène de la Ville de New York (NYC DOHMH) — **25 359 restaurants**.
Import, CRUD, opérateurs, tableaux de sous-documents, qualité de données, script `mongosh`.

| Fichier | Description |
|---|---|
| [`jour1/reponses_jour1.md`](jour1/reponses_jour1.md) | Le rendu : Q1 → Q28, réflexion R1 → R3, bonus B1/B2 |
| [`jour1/rapport.js`](jour1/rapport.js) | Script `mongosh` : total, top 5 cuisines, répartition par arrondissement |
| `jour1/primer-dataset.json` | Jeu de données source (25 359 lignes) |
| `jour1/staten_island.json` | Export `mongoexport` de Staten Island (969 documents) |
| `jour1/capture_express.png` | Capture de mongo-express sur la collection `restaurants` |

**Quelques résultats** — 85 cuisines distinctes · `/BBQ/` → 0 résultat contre `/BBQ/i` → 73
(la base stocke `Bbq`) · « mal notés » : 2708 contre 220 selon la lecture du tableau `grades`
· `$elemMatch` : 4280 contre 4908 pour la requête naïve · index sur `cuisine` :
`totalDocsExamined` de 25 309 à 345.

## Jour 2 — Modélisation, Indexation & Drivers

Jeu `sample_mflix` — **23 539 films** et **50 304 commentaires** liés par référence.
Embed vs reference, patterns de modélisation, index et `explain()`, agrégation, PyMongo,
transaction ACID.

| Fichier | Description |
|---|---|
| [`jour2/reponses_jour2.md`](jour2/reponses_jour2.md) | Le rendu : Q1 → Q19, réflexion R1 → R4 |
| [`jour2/index_bench.md`](jour2/index_bench.md) | Tableaux `explain()` avant / après index, + bonus B1/B2/B3 |
| [`jour2/analyses.js`](jour2/analyses.js) | Agrégations Q11 → Q15 |
| [`jour2/patterns.py`](jour2/patterns.py) | PyMongo — Computed Pattern et Subset Pattern |
| [`jour2/transaction.js`](jour2/transaction.js) | Transaction ACID multi-documents (commit et abort) |
| `jour2/movies.json`, `jour2/comments.json` | Jeux de données source |

**Quelques résultats** — **9224** commentaires orphelins (18,3 %), que rien dans la base ne
signale · le compteur `num_mflix_comments` est faux sur **77,8 %** des films qui le portent ·
règle ESR prouvée au `.hint()` : le mauvais ordre est **3,1× plus lent** à volume identique ·
covered query à `totalDocsExamined = 0` · index partiel 9× plus léger.

---

## Environnement

```bash
# MongoDB 7.0 + mongo-express
docker compose up -d
docker compose ps
```

Le conteneur est publié sur **27017** et **27019**. Le second port existe parce qu'un `mongod`
installé nativement occupe déjà 27017 sur la machine de développement : les connexions depuis
l'hôte (PyMongo) doivent passer par 27019.

### Jour 1 — import

```bash
cd jour1
curl -L -o primer-dataset.json \
  https://raw.githubusercontent.com/mongodb/docs-assets/primer-dataset/primer-dataset.json

docker cp primer-dataset.json mongo-ipssi:/tmp/primer-dataset.json
docker exec mongo-ipssi mongoimport \
  --username admin --password ipssi2025 --authenticationDatabase admin \
  --db nyc --collection restaurants --drop --file /tmp/primer-dataset.json
```

Contrôle : `db.restaurants.countDocuments({})` = **25359**.

### Jour 2 — import

```bash
cd jour2
curl -L -o movies.json   https://raw.githubusercontent.com/neelabalan/mongodb-sample-dataset/main/sample_mflix/movies.json
curl -L -o comments.json https://raw.githubusercontent.com/neelabalan/mongodb-sample-dataset/main/sample_mflix/comments.json

docker cp movies.json   mongo-ipssi:/tmp/movies.json
docker cp comments.json mongo-ipssi:/tmp/comments.json
docker exec mongo-ipssi mongoimport -u admin -p ipssi2025 --authenticationDatabase admin \
  --db mflix --collection movies   --drop --file /tmp/movies.json
docker exec mongo-ipssi mongoimport -u admin -p ipssi2025 --authenticationDatabase admin \
  --db mflix --collection comments --drop --file /tmp/comments.json
```

Contrôle : **23539** films et **50304** commentaires.

### Replica set (transactions du Jour 2)

```bash
docker run -d --name mongo-rs -p 27018:27017 mongo:7.0 --replSet rs0
docker exec mongo-rs mongosh --port 27017 \
  --eval 'rs.initiate({_id:"rs0",members:[{_id:0,host:"localhost:27017"}]})'
```

## Exécuter les scripts

```bash
# Jour 1
docker exec -i mongo-ipssi mongosh -u admin -p ipssi2025 \
  --authenticationDatabase admin nyc < jour1/rapport.js

# Jour 2
docker exec -i mongo-ipssi mongosh -u admin -p ipssi2025 \
  --authenticationDatabase admin mflix < jour2/analyses.js

pip install "pymongo>=4.6"
python jour2/patterns.py

docker exec -i mongo-rs mongosh --quiet mflix < jour2/transaction.js
```

Interfaces : mongo-express sur http://localhost:8081 · Compass avec
`mongodb://admin:ipssi2025@localhost:27019/?authSource=admin`

Les PDF du cours et des sujets ne sont pas versionnés.

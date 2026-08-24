# TP Jour 1 — Introduction au NoSQL & MongoDB

Module **MIA4 · Conception et intégration d'un SGBD NoSQL** — IPSSI Montpellier
Mohammed Monsleh

Manipulation du jeu de données réel des inspections d'hygiène de la Ville de New York
(NYC DOHMH, 25 359 restaurants) : import, requêtes CRUD, opérateurs, tableaux de
sous-documents, qualité de données et automatisation par script `mongosh`.

## Contenu du dépôt

| Fichier | Description |
|---|---|
| `reponses_jour1.md` | Le rendu : Q1 → Q28, réflexion R1 → R3, bonus B1/B2 — commande + résultat exact |
| `rapport.js` | Script `mongosh` : total, top 5 des cuisines, répartition par arrondissement |
| `docker-compose.yml` | Environnement reproductible — MongoDB 7.0 + mongo-express |
| `primer-dataset.json` | Jeu de données source (25 359 lignes) |
| `staten_island.json` | Export `mongoexport` de l'arrondissement Staten Island (969 documents) |
| `capture_express.png` | Capture de mongo-express sur la collection `restaurants` |

Les PDF du cours et du sujet ne sont pas versionnés.

## Reproduire l'environnement

```bash
# 1. Lancer MongoDB + mongo-express
docker compose up -d
docker compose ps

# 2. (optionnel) Retélécharger le jeu de données
curl -L -o primer-dataset.json \
  https://raw.githubusercontent.com/mongodb/docs-assets/primer-dataset/primer-dataset.json

# 3. Importer dans la base nyc
docker cp primer-dataset.json mongo-ipssi:/tmp/primer-dataset.json
docker exec mongo-ipssi mongoimport \
  --username admin --password ipssi2025 --authenticationDatabase admin \
  --db nyc --collection restaurants --drop --file /tmp/primer-dataset.json
```

Vérification : `db.restaurants.countDocuments({})` doit renvoyer **25359**.

## Se connecter

```bash
# Shell
docker exec -it mongo-ipssi mongosh -u admin -p ipssi2025 --authenticationDatabase admin

# Script de rapport
docker exec -i mongo-ipssi mongosh -u admin -p ipssi2025 \
  --authenticationDatabase admin nyc < rapport.js
```

Interface graphique : http://localhost:8081 → base `nyc` → collection `restaurants`.
Compass : `mongodb://admin:ipssi2025@localhost:27017/?authSource=admin`

## Quelques résultats

- **25359** restaurants, **85** cuisines distinctes, **93 463** notes d'inspection
- `/BBQ/` → **0** résultat, `/BBQ/i` → **73** : la base stocke `Bbq` (Title Case)
- « Mal notés » : **2708** (au moins un C dans l'historique) vs **220** (C en cours) —
  l'indice 0 du tableau `grades` est la note la plus **récente**
- `$elemMatch` : **4280** contre **4908** pour la requête naïve
- Qualité : **51** `borough: "Missing"` supprimés, **737** tableaux `grades` vides conservés,
  **13** scores négatifs (impact sur la moyenne : **0,015 %**)
- Index sur `cuisine` : `COLLSCAN` → `IXSCAN`, `totalDocsExamined` de **25 309** à **345**

Le détail et le raisonnement sont dans [`reponses_jour1.md`](reponses_jour1.md).

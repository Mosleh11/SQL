# TP Jour 3 — Réplication & haute disponibilité

**Mohammed Monsleh** — MIA4 · Conception et intégration d'un SGBD NoSQL — IPSSI
Replica Set `rs0` (3 nœuds Docker) · base `census`, collection `zips` — 29 470 codes postaux US.

> Toutes les sorties ci-dessous sont copiées telles quelles depuis mon poste. Les délais mesurés
> sont les miens : ils dépendent de la machine et de l'instant.
> Les mesures de bascule détaillées sont dans **[`failover.md`](failover.md)**, celles de la
> résilience applicative dans **[`resilience.md`](resilience.md)**.

---

## Partie 0 — Monter le Replica Set

### 0.1 Libérer le port 27017

```bash
docker ps                     # mongo-ipssi, mongo-express-ipssi, mongo-rs (Jours 1 et 2)
docker stop mongo-ipssi mongo-express-ipssi mongo-rs
```

### 0.2 Démarrer les trois nœuds

```bash
docker compose -f docker-compose.rs.yml up -d
docker compose -f docker-compose.rs.yml ps
```

```
NAME      STATUS
mongo1    Up
mongo2    Up
mongo3    Up
```

### Q1 — Un `mongod --replSet` non initialisé

```bash
docker exec mongo1 mongosh --quiet --eval 'printjson(db.hello())'
```

```
isWritablePrimary: false
primary present:   false
info:              Does not have a valid replica set config
secondary:         false
```

```bash
docker exec mongo1 mongosh --quiet --eval 'db.test.insertOne({ a: 1 })'
```

```
codeName: NotWritablePrimary
code:     10107
message:  not primary
```

- `isWritablePrimary` vaut **`false`**.
- Le champ **`primary` est absent** — le nœud ne connaît aucun primary, pas même lui-même.
- `info` : **« Does not have a valid replica set config »**.
- `codeName` de l'erreur d'écriture : **`NotWritablePrimary`** (code 10107).

**Conclusion : il n'est ni primary, ni secondary — il n'est rien.** `secondary` est aussi à
`false`. Le processus tourne, écoute sur le port, accepte les connexions, mais il est dans
l'état `STARTUP` : il attend une configuration. C'est un état bien réel en production —
un nœud fraîchement provisionné et jamais ajouté au set ressemble à un serveur en bonne santé
vu de l'extérieur, alors qu'il ne sert strictement à rien.

### 0.3 Initialiser le set

```bash
docker exec -i mongo1 mongosh < init-rs.js     # { ok: 1 }
docker exec mongo1 mongosh --quiet --eval 'rs.status().members.map(m => m.name + " " + m.stateStr).join(" | ")'
```

### Q2 — Qui est PRIMARY et pourquoi

```
mongo1:27017 PRIMARY | mongo2:27017 SECONDARY | mongo3:27017 SECONDARY
```

**`mongo1` est PRIMARY.** Le champ qui l'explique est **`priority`**, dans `init-rs.js` :

```js
{ _id: 0, host: "mongo1:27017", priority: 2 },   // <-- valeur 2
{ _id: 1, host: "mongo2:27017", priority: 1 },
{ _id: 2, host: "mongo3:27017", priority: 1 }
```

`mongo1` porte **`priority: 2`**, les deux autres `priority: 1`. À état de réplication égal,
le membre de plus forte priorité est élu — et, s'il perd le rôle, il le reprend dès qu'il est
à jour (*priority takeover*, cf. Q19).

### 0.4 Charger les données — Point de contrôle P0

```bash
curl -L -o zips.json https://raw.githubusercontent.com/neelabalan/mongodb-sample-dataset/main/sample_training/zips.json
wc -l zips.json                                  # 29470
docker cp zips.json mongo1:/tmp/zips.json
docker exec mongo1 mongoimport --db census --collection zips --drop --file /tmp/zips.json
```

```
2026-08-26T12:53:30.082+0000	29470 document(s) imported successfully. 0 document(s) failed to import.
```

**P0 validé.** L'import s'adresse à `mongo1`, le primary : c'est la règle absolue, toutes les
écritures passent par le primary.

### Q3 — Contenu vérifié depuis le primary

```js
db.zips.countDocuments({})                                        // 29470
db.zips.distinct("state").length                                  // 51
db.zips.aggregate([{ $group: { _id: null, pop: { $sum: "$pop" } } }])   // 248709873
```

| Mesure | Valeur |
|---|---|
| Documents | **29 470** |
| États distincts | **51** |
| Population totale | **248 709 873** |

**Le nombre d'États surprend au premier regard — il ne devrait pas.** Les États-Unis comptent
50 États, mais le recensement traite le **District of Columbia** comme une entité à part
entière : `DC` figure bien dans la liste (`AK, AL, ..., DC, DE, ...`). 50 + 1 = 51. Aucun
territoire (Porto Rico `PR`, Guam `GU`) n'est présent, ce qui confirme qu'on est sur le
périmètre « 50 États + DC » du recensement de 1990 — la population totale de 248,7 millions
correspond d'ailleurs au recensement **de 1990**, pas à la population actuelle.

### Q4 — `zip` est-il une clé naturelle ?

```js
db.zips.distinct("zip").length      // 29467
```

**29 467 valeurs distinctes pour 29 470 documents** : la clé naturelle est **réfutée**, il y a
3 doublons.

```js
db.zips.aggregate([
  { $group: { _id: "$zip", n: { $sum: 1 } } },
  { $match: { n: { $gt: 1 } } },
  { $sort: { n: -1 } }
])
// [ { _id: '63673', n: 2 }, { _id: '42223', n: 2 }, { _id: '32350', n: 2 } ]
```

Les trois codes en doublon : **`63673`, `42223`, `32350`**. En regardant les documents, la
raison est limpide — ce sont des codes postaux **à cheval sur deux États** :

| zip | Ville | État | Population |
|---|---|---|---|
| 32350 | PINETTA | FL | 642 |
| 32350 | PINETTA | GA | 0 |
| 63673 | SAINT MARY | IL | 130 |
| 63673 | SAINT MARY | MO | 2 730 |
| 42223 | FORT CAMPBELL | KY | 18 861 |
| 42223 | FORT CAMPBELL | TN | 728 |

Fort Campbell est une base militaire qui chevauche la frontière Kentucky / Tennessee : un seul
code postal, deux États, donc deux lignes de recensement. Ce n'est **pas une erreur de
données**, c'est la réalité géographique.

Tentative d'index unique :

```js
db.zips.createIndex({ zip: 1 }, { unique: true })
```

```
codeName: DuplicateKey  code: 11000
Index build failed: ... :: caused by :: E11000 duplicate key error collection: census.zips
index: zip_1 dup key: { zip: "32350" }
```

**Non, on ne peut pas créer d'index unique sur `zip`.** La vraie clé métier est le couple
**`{ zip, state }`** — et c'est un enseignement qui dépasse le TP : une clé qui « ressemble »
à un identifiant ne l'est que si les données le confirment. Ici, trois documents sur 29 470
(0,01 %) suffisent à faire échouer la contrainte, et à faire planter en production un import
qu'on croyait sûr.

### Q5 — Population nulle

```js
db.zips.countDocuments({ pop: 0 })      // 67
```

**67 documents.** Exemples : `ALLEN (AL)`, `CHEVAK (AK)`, `EMMONAK (AK)`, `GRAYLING (AK)`,
`RUSSIAN MISSION (AK)`.

**C'est une réalité métier, pas une erreur de saisie** : un code postal peut desservir une zone
sans résident permanent recensé — boîtes postales, zone administrative, base militaire, village
d'Alaska dont les habitants sont rattachés à un autre code — et l'écrasante concentration de
ces cas en Alaska le confirme. Le contraste avec les scores négatifs du Jour 1 est net : là,
`-1` était impossible par construction ; ici, `0` est une valeur parfaitement légitime qu'il
faut se garder de « nettoyer ».

---

## Partie 1 — Anatomie du Replica Set et de l'oplog

### Q6 — Les deux curseurs de l'élection

```js
rs.conf().settings
```

| Paramètre | Valeur |
|---|---|
| `electionTimeoutMillis` | **10 000** |
| `heartbeatIntervalMillis` | **2 000** |
| `heartbeatTimeoutSecs` | 10 |

**En français : « un secondary déclare le primary mort au bout de 10 secondes sans nouvelle,
alors qu'il l'interroge toutes les 2 secondes. »**

Il tolère donc jusqu'à **5 heartbeats manqués** avant de déclencher une élection. Ces deux
valeurs sont confrontées au chronomètre en **Q21** et modifiées en **R3**.

### Q7 — Lire `rs.status()`

```
  mongo1:27017 | stateStr=PRIMARY   | health=1 | lastHeartbeat=undefined
  mongo2:27017 | stateStr=SECONDARY | health=1 | lastHeartbeat=Wed Aug 26 2026 12:53:58 GMT+0000
  mongo3:27017 | stateStr=SECONDARY | health=1 | lastHeartbeat=Wed Aug 26 2026 12:53:58 GMT+0000
```

`lastHeartbeat` est `undefined` pour `mongo1` : c'est le nœud sur lequel je suis connecté, il
ne s'envoie pas de heartbeat à lui-même.

**Le champ qui dit qu'un nœud est injoignable, c'est `health`** (1 = joignable, 0 = non), à
croiser avec **`lastHeartbeat`** — un `health: 1` accompagné d'un `lastHeartbeat` vieux de
plusieurs minutes signale une supervision figée, pas un nœud sain. J'ai vérifié pendant le
failover (Q18) que `stateStr` seul est trompeur : `mongo1` s'affiche encore `SECONDARY` avec
`health: 1` pendant sa phase de retrait propre, et ne passe à `(not reachable/healthy)` /
`health: 0` qu'une fois réellement mort.

### Q8 — Taille de l'oplog

```js
db.getSiblingDB("local").oplog.rs.stats().maxSize    // 134217728
```

**134 217 728 octets = exactement 128 Mio.** Cette valeur vient de la ligne `command:` du
`docker-compose.rs.yml` :

```yaml
command: mongod --replSet rs0 --bind_ip_all --port 27017 --oplogSize 128
```

`--oplogSize` s'exprime en Mo : 128 × 1024 × 1024 = 134 217 728.

**Si on ne la fixait pas**, MongoDB appliquerait sa valeur par défaut : **5 % de l'espace disque
libre**, avec un plancher de 990 Mo et un plafond de 50 Go. Sur un poste de développement avec
un gros disque, chacun des trois conteneurs réserverait plusieurs gigaoctets d'oplog pour un
TP — d'où le bridage explicite. En production, l'effet inverse guette : sur un disque plein,
5 % peut donner un oplog ridicule et une fenêtre de réplication de quelques minutes.

### Q9 — Granularité de la réplication

```js
db.getSiblingDB("local").oplog.rs.countDocuments({ op: "i", ns: "census.zips" })
```

→ **29 470**, soit **exactement** le nombre de documents importés.

`mongoimport` envoie pourtant des lots de plusieurs milliers de documents. **L'oplog ne contient
donc pas de lots, mais des opérations unitaires** : un `insertMany` de 10 000 documents produit
10 000 entrées d'oplog, une par document.

C'est un choix délibéré et lourd de conséquences. Il rend chaque entrée **indépendante et
rejouable isolément** — un secondary peut s'arrêter au milieu d'un lot et reprendre à l'entrée
suivante sans rien réappliquer en trop. Le prix : le volume d'oplog est proportionnel au nombre
de **documents** écrits, pas au nombre de **requêtes**, ce qui explique le dimensionnement
serré de la Q12.

### Q10 — Anatomie d'une entrée d'insertion

```js
db.getSiblingDB("local").oplog.rs.findOne({ op: "i", ns: "census.zips" })
```

```js
{
  lsid: { id: UUID('e03e1db2-eda1-405e-9157-1a1d8187d521'), uid: Binary(...) },
  txnNumber: Long('1'),
  op: 'i',
  ns: 'census.zips',
  ui: UUID('b4b4e701-ebb2-4d55-a691-3293390aa869'),
  o: { _id: ObjectId('5c8eccc1caa187d17ca6ed29'), city: 'CLEVELAND', zip: '35049',
       loc: { y: 33.992106, x: 86.559355 }, pop: 2369, state: 'AL' },
  o2: { _id: ObjectId('5c8eccc1caa187d17ca6ed29') },
  stmtId: 0,
  ts: Timestamp({ t: 1787748809, i: 2 }),
  t: Long('1'),
  v: Long('2'),
  wall: ISODate('2026-08-26T12:53:29.469Z')
}
```

| Champ | Rôle |
|---|---|
| `op` | type d'opération — `i` insert, `u` update, `d` delete, `c` commande, `n` no-op |
| `ns` | namespace `base.collection` visé — ici `census.zips` |
| `o` | la charge utile : **le document complet à insérer** |
| `ts` | l'estampille logique `Timestamp(secondes, ordinal)` — l'ordre total des opérations |
| `wall` | l'heure murale réelle, lisible par un humain (à ne pas utiliser pour ordonner) |

**Pourquoi `o` rend l'opération idempotente :** il contient le **document entier, `_id`
compris** — et non pas « insère un document ». Rejouer l'entrée revient à insérer un document
d'`_id` déjà connu. Comme `_id` porte un index unique, la seconde application est simplement
sans effet au lieu de créer un doublon. **L'état final est le même que l'opération soit
appliquée une ou dix fois** : c'est la définition de l'idempotence, et c'est ce qui permet à un
secondary de rejouer un bout d'oplog sans savoir où il s'était arrêté exactement.

Les champs `lsid`, `txnNumber` et `stmtId` reviendront en **Q32(d)** : ce sont eux qui rendent
`retryWrites` sûr.

### Q11 — Preuve par l'expérience : ce que devient un `$inc`

```js
db.zips.updateMany({ state: "TX" }, { $inc: { pop: 1 } })
// { matchedCount: 1676, modifiedCount: 1676 }

db.getSiblingDB("local").oplog.rs.findOne({ op: "u", ns: "census.zips" })
```

```js
{
  op: 'u',
  ns: 'census.zips',
  o: { '$v': 2, diff: { u: { pop: 4380 } } },     // <-- pas de $inc
  o2: { _id: ObjectId('5c8eccc1caa187d17ca74cfd') },
  ts: Timestamp({ t: 1787748854, i: 1 }),
  wall: ISODate('2026-08-26T12:54:14.293Z')
}
```

**Non, il n'y a aucun `$inc` dans l'oplog.** À la place on trouve un **diff contenant la valeur
absolue résultante** : `pop: 4380`. Et un seul `updateMany` sur 1 676 documents a produit
**1 676 entrées d'oplog** (`countDocuments({op:"u", ns:"census.zips"})` = 1676), une par
document — ce qui reconfirme la Q9.

**Pourquoi MongoDB procède ainsi :** parce que `$inc` n'est **pas idempotent**. Rejouer
« ajoute 1 » deux fois donne +2 — le secondary divergerait silencieusement du primary, et la
divergence serait invisible (aucune erreur, juste un chiffre faux). En convertissant
l'opération **relative** en une affectation **absolue** au moment de l'écrire dans l'oplog,
MongoDB garantit que le rejeu converge toujours vers le même état.

C'est le prolongement direct de la Q10 : dans les deux cas, **l'oplog ne stocke pas l'intention
de l'opération, il stocke son résultat**. C'est cette transformation qui rend toute la
réplication rejouable.

### Q12 — Dimensionnement de l'oplog

```js
db.getSiblingDB("local").oplog.rs.stats()
// size: 12019586   count: 31179   maxSize: 134217728
```

**(a) Taille moyenne d'une opération**

```
12 019 586 / 31 179 = 385,50 octets par opération
```

**(b) Capacité de l'oplog**

```
134 217 728 / 385,50 ≈ 348 190 opérations
```

L'oplog de 128 Mio mémorise donc **environ 348 000 opérations** avant d'écraser les plus
anciennes (c'est une collection *capped*, circulaire).

**(c) Fenêtre de réplication à 300 écritures/seconde**

```
348 190 / 300 = 1 161 s = 19,4 minutes = 0,32 heure
```

**La fenêtre de réplication est de ~19 minutes.**

Un secondary qui tombe le **vendredi à 18 h** et revient le **lundi à 9 h** a été absent
**63 heures**, soit **195 fois** la fenêtre disponible. **Il ne peut absolument pas rattraper
par l'oplog** : les opérations qu'il lui manque ont été écrasées depuis longtemps.

Que se passe-t-il alors ? Le nœud constate que son dernier point de synchronisation n'existe
plus dans l'oplog du primary, il passe en état **`RECOVERING`** et devient inutilisable. Il faut
une **resynchronisation complète** (*initial sync*) : recopier l'intégralité des données depuis
un autre membre. Sur une base volumineuse c'est long, et surtout cela **charge lourdement le
nœud source** — on dégrade la production pour réparer un nœud, un lundi matin, aux heures de
pointe.

La leçon de dimensionnement : **19 minutes est une fenêtre indéfendable en production**. Pour
tolérer un week-end (63 h) à 300 écritures/s, il faudrait
`63 × 3600 × 300 × 385,5 ≈ 26,2 To` d'oplog — c'est absurde. La vraie réponse n'est donc pas
« un plus gros oplog » mais **une supervision qui alerte sur le retard de réplication** : un
secondary en retard doit être traité en minutes, pas en jours. C'est précisément ce que mesure
`rs.printSecondaryReplicationInfo()` (Q15).

---

## Partie 2 — Lire et écrire dans un Replica Set

### Q13 — Lire sur un secondary

```bash
docker exec mongo2 mongosh --quiet census --eval 'db.zips.countDocuments({})'
```

```
29470
```

**Oui, j'obtiens les données**, sans avoir eu à taper quoi que ce soit de particulier.

L'ancienne commande `rs.secondaryOk()` (autrefois `rs.slaveOk()`) n'est plus nécessaire parce
que **`mongosh` positionne automatiquement la read preference sur `secondaryPreferred` lorsqu'on
se connecte directement à un membre** d'un Replica Set. Le shell détecte qu'il est en connexion
directe (et non via l'URI du set) et en déduit que l'intention de l'utilisateur est de lire *ce
nœud-là* — sinon, se connecter à un secondary pour se voir refuser toute lecture n'aurait aucun
sens pratique. L'ancienne commande existait à l'époque où le shell refusait par défaut, ce qui
obligeait tout le monde à la taper systématiquement : le comportement par défaut a simplement
été aligné sur l'usage réel.

### Q14 — Écrire sur un secondary

```bash
docker exec mongo2 mongosh --quiet census --eval 'db.zips.insertOne({ test: 1 })'
```

```
codeName: NotWritablePrimary
code:     10107
message:  not primary
```

**Pourquoi refuser l'écriture alors que la lecture est permise :** parce que la réplication
MongoDB est **à primary unique**. Toutes les écritures passent par un seul nœud, qui les
sérialise dans l'oplog et donne ainsi **un ordre total** aux opérations. Si deux secondaries
acceptaient des écritures concurrentes, il n'existerait plus d'ordre unique, plus de source de
vérité, et il faudrait résoudre des conflits à la fusion — le modèle multi-maître, que MongoDB
n'implémente pas.

Une lecture, elle, ne crée aucun conflit : au pire elle est **légèrement en retard**. Le risque
est de nature complètement différente, d'où l'asymétrie. C'est exactement la traduction du
« CP » du théorème CAP vu au Jour 1 : cohérence d'abord.

### Q15 — Le retard de réplication

Avant toute charge :

```
source: mongo2:27017   replLag: '0 secs (0 hrs) behind the primary'
source: mongo3:27017   replLag: '0 secs (0 hrs) behind the primary'
```

Puis 1 000 documents d'un coup :

```js
db.charge.insertMany(docs)      // 1000 documents en 73 ms
rs.printSecondaryReplicationInfo()
```

```
source: mongo2:27017   syncedTo: Wed Aug 26 2026 12:54:30   replLag: '9 secs (0 hrs) behind the primary'
source: mongo3:27017   syncedTo: Wed Aug 26 2026 12:54:30   replLag: '9 secs (0 hrs) behind the primary'
```

**Oui, le retard bouge : il passe de 0 à 9 secondes.** Vingt secondes plus tard, il est
retombé à 0 et les 1 000 documents sont bien présents sur `mongo2` :

```
source: mongo2:27017   replLag: '0 secs (0 hrs) behind the primary'
charge sur mongo2 : 1000
```

**Conclusion sur le caractère asynchrone.** Le primary a rendu la main en **73 ms** —
`insertMany` était terminé et acquitté côté client — alors que les secondaries n'avaient pas
encore tout appliqué. La réplication est donc bien **asynchrone** : *acquitté par le primary*
et *répliqué* sont deux instants différents, et l'écart peut atteindre plusieurs secondes sous
charge.

Toute la Partie 4 découle de ce constat : c'est parce que cet écart existe qu'il faut un
**write concern** pour choisir explicitement lequel des deux instants doit déclencher la
réponse au client.

### Q16 — Read Preference

```js
db.getMongo().setReadPref("primary");   db.zips.countDocuments({ state: "NY" })   // 1596
db.getMongo().setReadPref("secondary"); db.zips.countDocuments({ state: "NY" })   // 1596
```

**Résultat identique : 1596 dans les deux cas.** Normal — le set était au repos, `replLag` à 0.
L'égalité observée ici ne prouve donc rien de général : elle prouve seulement que **quand il n'y
a pas de retard, il n'y a pas d'écart**. Sous la charge de la Q15, la lecture secondary aurait
renvoyé un résultat en retard de 9 secondes.

**Cas où lire sur un secondary est acceptable** : un tableau de bord analytique, un export de
statistiques, une carte de densité de population par État. Ces lectures sont lourdes, elles
soulagent utilement le primary, et une donnée vieille de quelques secondes n'a **aucune
conséquence** sur la décision prise.

**Cas où c'est dangereux** : le classique « lecture après écriture ». Un utilisateur modifie son
adresse, l'application le redirige vers sa fiche, la lecture part sur un secondary **stale** —
il voit son ancienne adresse et croit que l'enregistrement a échoué. Il recommence, et on se
retrouve avec des doublons ou un ticket de support. Le mot **stale** est la clé : la donnée
n'est pas fausse, elle est *périmée* — et une donnée périmée présentée comme actuelle est
indistinguable d'un bug pour l'utilisateur.

---

## Partie 3 — Failover

> **Toutes les mesures chronométrées sont détaillées dans [`failover.md`](failover.md).**
> Résumé ci-dessous.

### Q17 — Arrêt propre

```
14:56:20.275 [  0.000s] primary = mongo1:27017
14:56:25.116 [  4.873s] primary = mongo2:27017      <- docker stop a 14:56:24.832
```

**Délai : 0,284 s. Nœud élu : `mongo2`.** `docker stop` envoie un SIGTERM, `mongod` prévient le
set qu'il se retire : aucun timeout n'est attendu, seulement le temps du vote.

### Q18 — État pendant la bascule

```
  mongo1:27017 | SECONDARY | health=1        <- juste apres le stop, retrait propre
  mongo2:27017 | PRIMARY   | health=1
  mongo3:27017 | SECONDARY | health=1
```

puis, une fois le processus réellement mort :

```
  mongo1:27017 | (not reachable/healthy) | health=0
```

### Q19 — Retour du nœud et reprise de rôle

```
14:56:47.209  docker start mongo1
14:56:59.632  primary = mongo1:27017        -> 12,423 s
```

`mongo1` revient d'abord `health: 0`, puis `SECONDARY` le temps de rattraper l'oplog. Une fois
à jour, sa `priority: 2` déclenche un **priority takeover** et il reprend le rôle.

**Le cluster a subi 2 bascules pour une seule panne** : une au départ, une au retour. C'est
l'argument contre les priorités asymétriques — le service tournait très bien sur `mongo2`, et
on lui inflige une seconde interruption d'écriture sans aucun bénéfice. Sauf raison
d'infrastructure documentée (matériel supérieur, datacenter principal), on laisse toutes les
priorités égales.

### Q20 — Comment `mongo1` récupère ce qu'il a manqué

Écriture sur le nouveau primary pendant l'absence de `mongo1` :

```js
db.absence.insertMany([{k:"pendant_panne",n:1}, {k:"pendant_panne",n:2}, {k:"pendant_panne",n:3}])
// inseres sur le nouveau primary : 3
```

Puis `docker start mongo1`, et **lecture en connexion directe sur `mongo1`** :

```
absence sur mongo1 : 3
[ { k: 'pendant_panne', n: 1 }, { k: 'pendant_panne', n: 2 }, { k: 'pendant_panne', n: 3 } ]
```

**Les 3 documents sont là.** Le mécanisme est celui de la Partie 1 : **l'oplog**. Au démarrage,
`mongo1` compare son dernier `ts` appliqué à l'oplog d'un membre à jour, y trouve les opérations
postérieures et les **rejoue dans l'ordre**. C'est possible sans risque de doublon précisément
grâce à l'idempotence démontrée en Q10 et Q11.

Et c'est là que la Q12 prend tout son sens : ce rattrapage ne fonctionne que si les opérations
manquées **sont encore dans l'oplog**. Au-delà de la fenêtre de 19 minutes calculée, le nœud
serait passé en `RECOVERING` et il aurait fallu une resynchronisation complète.

### Q21 — Panne brutale : la question centrale

```
14:57:43.494 [  0.000s] primary = mongo1:27017
14:57:48.337 [  4.851s] primary = AUCUN PRIMARY       <- docker kill a 14:57:48.026
14:57:57.722 [ 14.237s] primary = mongo3:27017
```

| | Délai | Nœud élu |
|---|---|---|
| Arrêt propre (`docker stop`) | **0,284 s** | mongo2 |
| Panne brutale (`docker kill`) | **9,696 s** | mongo3 |
| **Rapport** | **34×** | |

**Mon délai (9,696 s) est légèrement inférieur à `electionTimeoutMillis` (10 000 ms).**

L'explication tient au **moment où le compte à rebours démarre** : pas au `kill`, mais au
**dernier heartbeat reçu avec succès**. Avec `heartbeatIntervalMillis = 2000`, ce dernier
heartbeat date d'au plus 2 s avant la mort du nœud. Vu de l'extérieur, le délai attendu est donc
compris entre **8 s** (dernier heartbeat juste avant le kill) et **10 s** (heartbeat au moment
même du kill), auxquels s'ajoute le temps du vote (~200-700 ms). Mes 9,696 s tombent dans cet
intervalle : le dernier heartbeat était à environ 0,5 s avant le kill.

Le log montre aussi une phase explicite de **`AUCUN PRIMARY` pendant ~5 s** : le cluster est
vivant à 2 nœuds sur 3, mais **n'accepte aucune écriture**. C'est ce que subit l'application
(Q31), et c'est ce que `retryWrites` ne peut pas corriger (Q32).

### Q22 — Synthèse

Le tableau complet et le message à la DSI sont dans **[`failover.md`](failover.md)**.

| Scénario | Commande | Délai mesuré | Nœud élu | Écritures perdues ? |
|---|---|---|---|---|
| Arrêt propre | `docker stop mongo1` | **0,284 s** | mongo2 | non |
| Panne brutale | `docker kill mongo1` | **9,696 s** | mongo3 | 1 (Q31) |
| Retour du nœud | `docker start mongo1` | **12,423 s** | mongo1 | non |

### Q23 — Le quorum

`docker stop mongo2 mongo3`, puis interrogation du survivant `mongo1` :

**(a) Les deux relevés**

| Instant | `isWritablePrimary` | `myState` | `stateStr` |
|---|---|---|---|
| Immédiatement | **`true`** | 1 (PRIMARY) | PRIMARY |
| À +15 s | **`false`** | 2 (SECONDARY) | SECONDARY |

**Ce qui s'est passé entre les deux :** `mongo1` était encore primary et **l'ignorait**. Il n'a
constaté l'absence des deux autres qu'après `electionTimeoutMillis` (10 s), au terme des
heartbeats manqués. À ce moment, il a vérifié qu'il ne disposait plus que d'**une voix sur
trois** — pas la majorité — et il a **rétrogradé tout seul en SECONDARY**.

C'est le point le plus important de la journée : **pendant ces ~10 secondes, un nœud isolé se
croit encore primary**. C'est la fenêtre exacte pendant laquelle des écritures acceptées en
`w: 1` peuvent être perdues au rollback (cf. Q24 et B4).

**(b) Écriture et lecture sur le survivant**

```js
db.quorum.insertOne({ x: 1 })
// codeName: NotWritablePrimary | code: 10107 | message: not primary
```

```js
db.zips.countDocuments({})     // 29470  -> lecture OK
db.zips.find().readConcern("majority").limit(1)   // fonctionne aussi
```

**L'écriture est refusée, la lecture fonctionne.** Le nœud est devenu un secondary ordinaire :
il sert ses données locales (potentiellement périmées, `readConcern: "local"`), mais il ne peut
plus rien accepter en écriture. **Le service est en lecture seule** — dégradé, pas mort.

**(c) La majorité, expliquée**

La règle est qu'un primary doit être élu et maintenu par une **majorité stricte des membres
votants**, c'est-à-dire **plus de la moitié** — et cette majorité se calcule sur le **nombre
total de membres configurés**, pas sur le nombre de membres survivants.

| Membres configurés | Majorité requise | Pannes tolérées |
|---|---|---|
| 3 | 2 | **1** |
| 4 | 3 | **1** |
| 5 | 3 | 2 |

Un set de 3 tolère 1 panne : il reste 2 nœuds, soit la majorité de 3. Il ne tolère pas 2
pannes : il ne reste qu'1 nœud sur 3, ce que j'ai constaté ci-dessus.

Un set de **4** ne tolère pas mieux qu'un set de 3 : la majorité de 4 est **3**, donc perdre
2 nœuds sur 4 laisse 2 survivants — **pas la majorité**, plus de primary. On a ajouté une
machine, un coût de licence, un point de panne supplémentaire et un membre de plus à répliquer,
**pour exactement la même tolérance**. Vérifié expérimentalement en **R1**.

La raison profonde de cette exigence : elle rend le **split-brain** impossible. Si une partition
réseau coupe le set en deux, une seule des deux moitiés peut contenir une majorité — donc au
plus un primary existe à un instant donné. Avec un nombre pair, on autorise deux moitiés
égales : aucune n'a la majorité, personne n'est élu, tout le monde perd. C'est pourquoi **on
déploie toujours un nombre impair de membres votants**.

---

## Partie 4 — Write Concern & Read Concern

### Q24 — `w: 1` contre `w: "majority"`

```js
db.demo.insertOne({ wc: "w1" },       { writeConcern: { w: 1 } })          // acknowledged: true
db.demo.insertOne({ wc: "majority" }, { writeConcern: { w: "majority" } }) // acknowledged: true
```

**Les deux réussissent, mais ne garantissent pas la même chose.**

- **`w: 1`** : le **primary seul** a écrit. La réponse part avant toute réplication. Rapide, et
  **révocable**.
- **`w: "majority"`** : la **majorité des membres** (ici 2 sur 3) a confirmé. Plus lent, mais
  **définitif**.

**Le scénario précis de la Partie 3 où `w: 1` aurait perdu l'écriture, c'est la Q23(a).**
Pendant les ~10 secondes où `mongo1`, isolé, se croyait encore primary, il aurait accepté une
écriture en `w: 1` et l'aurait confirmée à l'utilisateur. Or les deux autres nœuds, s'ils
avaient été vivants et séparés de lui par une partition réseau, auraient élu leur propre
primary. Au retour de `mongo1`, celui-ci découvre un historique divergent : il **annule** ses
écritures non répliquées (elles partent dans un fichier de rollback) et se réaligne sur le
nouveau primary. **L'écriture confirmée à l'utilisateur disparaît de la base.**

Avec `w: "majority"`, cette écriture n'aurait jamais été confirmée : `mongo1` isolé n'aurait
jamais pu réunir 2 confirmations sur 3. L'utilisateur aurait vu une erreur — désagréable, mais
**vrai**.

### Q25 — `w: 4` sur un set de 3

```js
db.demo.insertOne({ a: 1 }, { writeConcern: { w: 4, wtimeout: 3000 } })
```

```
duree:    26 ms
codeName: UnsatisfiableWriteConcern
code:     100
message:  Not enough data-bearing nodes
```

**26 millisecondes, pas 3 secondes.**

MongoDB refuse **immédiatement** parce que la demande est **structurellement impossible**, et
non pas lente à satisfaire. Le serveur connaît la composition de son set : 3 membres porteurs
de données. Demander 4 confirmations ne pourra jamais aboutir, quel que soit le temps
d'attente — attendre les 3 secondes de `wtimeout` ne ferait que retarder une erreur certaine.

La distinction est fine mais essentielle : `wtimeout` borne une attente sur quelque chose de
**possible mais éventuellement lent** (un secondary à la traîne). Il ne s'applique pas à une
demande **absurde**. D'où deux codes d'erreur différents — `UnsatisfiableWriteConcern` (100)
ici, `WriteConcernFailed` (64) en Q26.

### Q26 — La question d'écart de la journée

`docker stop mongo3` (2 nœuds vivants sur 3), puis depuis le primary :

**(a) L'une passe, l'autre échoue**

```js
db.demo.insertOne({ b: 1 }, { writeConcern: { w: "majority", wtimeout: 3000 } })
// OK en 46 ms  -> { acknowledged: true, insertedId: ObjectId('...') }

db.demo.insertOne({ c: 1 }, { writeConcern: { w: 3, wtimeout: 3000 } })
// duree:    3038 ms
// codeName: WriteConcernFailed   code: 64
// message:  waiting for replication timed out
```

**`w: "majority"` passe** (2 confirmations sur 3 suffisent, la majorité de 3 est 2).
**`w: 3` échoue** avec **`WriteConcernFailed` (64)**, après avoir consommé les 3 secondes de
`wtimeout` — cette fois l'attente a bien eu lieu, car la demande était possible en théorie.

**(b) Le comptage**

```js
db.demo.countDocuments({})
// 2

db.demo.find({}, { _id: 0 })
// [ { b: 1 }, { c: 1 } ]
```

**J'en trouve 2.** Si un échec signifiait « rien n'a été écrit », on en attendrait **1** (le
seul `b`). **Écart : +1 document — celui de l'insertion qui a renvoyé une erreur.**

**(c) L'explication**

**L'échec d'un write concern n'est pas l'échec de l'écriture.** Ce sont deux choses
indépendantes, et elles se déroulent dans cet ordre :

1. Le primary **écrit le document** dans sa collection et dans son oplog. Cette étape a
   **réussi** — le document existe, il est visible, il sera répliqué dès que `mongo3` reviendra.
2. Le primary **attend les confirmations** demandées par le write concern. Cette étape a
   **échoué**, faute d'un troisième nœud.

L'erreur `WriteConcernFailed` ne rapporte que l'échec de l'étape 2. **Elle ne rembobine rien** :
il n'y a pas de rollback, l'écriture reste en place.

**La conséquence pour une application qui rejouerait après l'erreur est directe : elle crée un
doublon.** Elle reçoit une exception, en conclut « ça n'est pas passé », relance l'insertion —
et se retrouve avec deux documents. C'est un bug redoutable parce qu'il ne se déclenche que
lorsqu'un nœud est en panne : jamais en développement, uniquement en production un jour
d'incident, au pire moment.

La bonne pratique qui en découle : sur un `WriteConcernFailed`, **ne pas rejouer à l'aveugle**.
Soit on relit pour vérifier l'état réel, soit on rend l'écriture idempotente par construction
(un `_id` déterministe, un `upsert` sur une clé métier) — exactement le mécanisme que MongoDB
lui-même applique avec `lsid` / `txnNumber` pour `retryWrites` (Q32d).

### Q27 — `j: true`

```js
db.demo.insertOne({ j: true },  { writeConcern: { w: "majority", j: true  } })   // 21 ms
db.demo.insertOne({ j: false }, { writeConcern: { w: "majority", j: false } })   //  6 ms
```

**Ce que `j: true` garantit de plus :** que l'écriture est inscrite dans le **journal
(write-ahead log) sur disque**, et non seulement dans la mémoire du serveur. Sans lui, un nœud
peut avoir accusé réception d'une écriture qui n'est encore que dans son cache WiredTiger.

**Le coût, mesuré : 21 ms contre 6 ms**, soit **3,5× plus lent** sur cette machine — parce qu'il
faut attendre un vrai `fsync` sur le disque, et non un simple accusé mémoire. Sur un disque
mécanique, l'écart serait bien plus violent.

**« Que se passe-t-il si les 3 machines perdent le courant en même temps ? »** — c'est
précisément le scénario que `j: true` couvre et que `w: "majority"` seul ne couvre pas.
`w: "majority"` prouve que la majorité des nœuds a **reçu** l'écriture ; si tous ne l'ont qu'en
mémoire et que le courant saute simultanément, **elle est perdue partout à la fois**. Avec
`j: true`, chaque nœud confirmant l'a d'abord posée sur son disque : au redémarrage, le journal
est rejoué et l'écriture est là.

C'est un risque corrélé, et c'est ce qui le rend sérieux : trois machines dans **la même baie,
sur la même alimentation** tombent ensemble. La parade réelle combine les deux —
`w: "majority", j: true` pour les écritures critiques (paiement, commande, dossier médical) —
et une répartition des nœuds sur des alimentations, voire des datacenters, distincts.

### Q28 — Read Concern

**`readConcern: "local"`** (défaut) renvoie ce que le nœud interrogé a dans ses fichiers, **sans
aucune garantie que ce soit confirmé par les autres**. **`readConcern: "majority"`** ne renvoie
que les données dont la majorité du set a accusé réception — donc des données qui **ne peuvent
plus disparaître** par rollback.

La différence est exactement celle qu'a rendue visible ma **Q26** : le document `{ c: 1 }`
existe bel et bien sur le primary alors que son write concern a échoué. Une lecture en `"local"`
le voit — et pourrait le montrer à un utilisateur — alors qu'il n'est **confirmé nulle part
ailleurs** ; si le primary tombait avant réplication, ce document serait annulé et
« disparaîtrait » de l'écran de l'utilisateur.

Du point de vue de l'utilisateur final, `"majority"` est donc la garantie que **ce qu'il voit
est définitif** : rien de ce qui lui a été affiché ne pourra être révoqué plus tard. Le prix est
une lecture légèrement plus ancienne et un peu plus lente. `"local"` montre plus tôt, au risque
de montrer quelque chose qui n'existera plus dans dix secondes — inacceptable pour un solde ou
une confirmation de commande, sans importance pour un compteur de vues.

---

## Partie 5 — Résilience applicative

> **Sorties brutes complètes et décomptes dans [`resilience.md`](resilience.md).** Synthèse ici.

### Q29 — Le piège de l'URI

```bash
python writer.py "mongodb://localhost:27017,localhost:27018,localhost:27019/?replicaSet=rs0"
```

```
ServerSelectionTimeoutError: mongo2:27017: [Errno 11001] getaddrinfo failed,
mongo1:27017: [Errno 11001] getaddrinfo failed,
mongo3:27017: [Errno 11001] getaddrinfo failed,
Timeout: 5.0s, Topology Description: <TopologyDescription id: 6a8ee38e4c83e3a80b01c41a,
topology_type: ReplicaSetNoPrimary, servers: [
  <ServerDescription ('mongo1', 27017) server_type: Unknown, rtt: None,
     error=AutoReconnect('mongo1:27017: [Errno 11001] getaddrinfo failed ...')>,
  <ServerDescription ('mongo2', 27017) server_type: Unknown, ...>,
  <ServerDescription ('mongo3', 27017) server_type: Unknown, ...>]>
```

**(a)** Le driver dit avoir essayé de joindre **`mongo1:27017`, `mongo2:27017` et
`mongo3:27017`**.

**(b)** J'avais pourtant écrit `localhost` trois fois. Ces noms sortent de **`rs.conf()`** :
`init-rs.js` a enregistré les membres sous leurs noms d'hôtes Docker.

```js
rs.initiate({ _id: "rs0", members: [
  { _id: 0, host: "mongo1:27017", priority: 2 }, ... ] })
```

Le driver ne se contente pas de la liste de l'URI : il l'utilise comme **liste d'amorçage
(seed list)**, contacte un nœud, lui demande la composition réelle du set, puis **remplace
intégralement sa liste** par celle que le cluster lui annonce. Depuis l'hôte Windows, les noms
`mongo1/2/3` n'existent pas dans le DNS — d'où `getaddrinfo failed`.

**(c)** Ce que le nœud annonce de lui-même :

```bash
docker exec mongo1 mongosh --quiet --eval 'const h = db.hello(); print(h.setName); printjson(h.hosts)'
```

```
setName: rs0
[ 'mongo1:27017', 'mongo2:27017', 'mongo3:27017' ]
```

`db.hello()` expose `setName` **et** la liste `hosts` : c'est cette réponse qui déclenche le
remplacement, indépendamment de tout paramètre d'URI. **Ce n'est donc pas `?replicaSet=` qui
provoque la substitution, c'est la découverte du set elle-même**, que le driver entreprend dès
qu'un nœud se déclare membre d'un Replica Set.

> **Écart avec l'énoncé, assumé et vérifié.** Le TP annonce que la relance sur
> `mongodb://localhost:27017` seul « échoue encore ». **Sur mon poste, elle réussit** :
>
> ```
> 15:01:23.773 | n=1 | primary=None | OK (0.10s)
> 15:01:24.773 | n=2 | primary=None | OK (0.00s)
> ```
>
> La raison est une évolution de PyMongo : **depuis la version 4.0, une URI à un seul hôte sans
> `replicaSet=` bascule automatiquement en `directConnection=true`**. J'ai vérifié la topologie
> obtenue pour chaque URI (PyMongo 4.17.0) :
>
> | URI | `topology_type_name` | `client.primary` |
> |---|---|---|
> | `mongodb://localhost:27017` | **`Single`** | `None` |
> | `mongodb://localhost:27017/?directConnection=true` | `Single` | `None` |
> | `mongodb://localhost:27017,localhost:27018/?replicaSet=rs0` | échec | — |
>
> Les deux premières lignes sont **identiques** : le comportement de (d) est déjà celui de (c).
> Le raisonnement pédagogique de l'énoncé reste exact — il décrit PyMongo 3.x, où le seul seed
> déclenchait bien la découverte.

**(d)** L'option d'URI qui désactive la découverte est **`directConnection=true`**.

```python
client = MongoClient("mongodb://localhost:27017/?directConnection=true")
print(client.topology_description.topology_type_name)   # Single
print(client.primary)                                   # None
print(client.secondaries)                               # set()
```

**Ce que j'ai perdu au passage : tout le Replica Set.** `topology_type_name` vaut **`Single`**
et non `ReplicaSetWithPrimary` ; `client.primary` vaut **`None`** — le driver ne sait même plus
qui est le primary, il ne voit plus qu'**une machine isolée**. Concrètement : plus de bascule
automatique (si ce nœud tombe, l'application tombe avec lui), plus de read preference, plus de
`retryWrites` utile. `directConnection=true` est un outil d'**administration** — inspecter un
nœud précis — et **jamais** une configuration applicative.

### Q30 — Lancer l'application dans le réseau du cluster

```bash
docker run --rm --network rslab_default -v "$PWD:/app" -w /app python:3.12-slim \
  sh -c "pip install -q 'pymongo>=4.6' && python writer.py \
    'mongodb://mongo1:27017,mongo2:27017,mongo3:27017/?replicaSet=rs0&retryWrites=true' 45"
```

```
13:02:15.188 | n=  1 | primary=None                   | OK     ( 0.02s)
13:02:16.188 | n=  2 | primary=('mongo1', 27017)      | OK     ( 0.00s)
13:02:17.188 | n=  3 | primary=('mongo1', 27017)      | OK     ( 0.00s)
13:02:18.188 | n=  4 | primary=('mongo1', 27017)      | OK     ( 0.00s)
13:02:19.189 | n=  5 | primary=('mongo1', 27017)      | OK     ( 0.00s)
```

Le primary vu est **`mongo1:27017`**.

### Q31 — La mesure qui compte

`docker kill mongo1` à 13:02:50.499 (heure du conteneur, UTC).

| | Valeur |
|---|---|
| Dernière écriture réussie | 13:02:50.195 |
| Première ligne en échec | 13:02:51.195 (a attendu 5,04 s) |
| Première ligne redevenue OK | 13:02:56.233 (a mis 4,79 s → aboutit vers 13:03:01) |
| **Indisponibilité vue de l'application** | **≈ 10,8 s** |
| Écritures réussies / en échec | **37 / 1** |
| Reconnexion automatique | **oui**, sans intervention |

**(d) Comparaison avec la Q21 :** 9,696 s côté cluster contre ≈ 10,8 s côté application, soit
**≈ 1,1 s de plus**. Elles ne sont pas égales, et **l'application perd toujours davantage** :
le driver doit refaire sa propre découverte de topologie après l'élection, et la cadence du
script quantifie la mesure. **Le chiffre à annoncer est celui de la Q31**, pas celui de la Q21.

### Q32 — `retryWrites`

| Expérience | `retryWrites=true` | `retryWrites=false` | Écart |
|---|---|---|---|
| `docker kill` du primary | 1 échec | 1 échec | **nul** |
| `rs.stepDown()`, cadence 1 s | 0 échec | 0 échec | nul |
| `rs.stepDown()`, cadence 20 ms | — | 0 échec / 1 981 écritures | nul |
| `rs.stepDown()` ×3, cadence continue | — | 0 échec / 139 733 écritures | nul |

**(a) et (b)** Même exception dans les deux cas : **`ServerSelectionTimeoutError`**, avec une
durée de **5,04 s** égale au `serverSelectionTimeoutMS` du script. Le driver **attend**, il
n'échoue pas immédiatement — et il échoue sur la **sélection du serveur**, pas sur l'écriture :
il n'a jamais rien envoyé. Pendant les ~9,7 s sans primary (Q21), `retryWrites` ne peut rien,
puisque rejouer suppose un primary à qui reparler. **Écart nul, résultat attendu.**

**(c)** Avec `rs.stepDown()` et `retryWrites=true`, la bascule est **totalement transparente** —
`mongo1 → mongo2` d'une ligne à l'autre, sans une seule erreur :

```
13:07:47.970 | n= 12 | primary=('mongo1', 27017)      | OK     ( 0.00s)
13:07:48.970 | n= 13 | primary=('mongo2', 27017)      | OK     ( 0.00s)
13:07:49.971 | n= 14 | primary=('mongo2', 27017)      | OK     ( 0.00s)
```

**Je n'ai cependant pas obtenu l'écart net annoncé** : quatre exécutions, jusqu'à 139 733
écritures en cadence continue avec trois `stepDown`, donnent **0 échec dans les deux
configurations**. Explication : PyMongo effectue la **sélection du serveur avant d'envoyer**
chaque écriture ; pour qu'un `stepDown` produise une erreur non rejouée, il faut qu'une écriture
soit **déjà partie** vers l'ancien primary à l'instant précis où il rétrograde. À ~0,3 ms par
écriture depuis un client séquentiel, cette fenêtre est trop étroite pour être touchée de façon
fiable — il faudrait plusieurs dizaines de threads concurrents. Le détail des quatre runs est
dans [`resilience.md`](resilience.md).

**Conclusion en une phrase :** `retryWrites` protège contre les pannes **transitoires où un
primary existe encore ou réapparaît immédiatement** (rétrogradation, coupure réseau brève,
timeout isolé — les erreurs marquées *retryable* par le serveur), et ne peut **rien** contre une
fenêtre où le cluster n'a **aucun primary**, puisque l'échec porte alors sur la sélection de
serveur et non sur l'écriture.

**(d) Pourquoi rejouer ne crée pas de doublon.** Les champs responsables sont ceux repérés en
Q10 : **`lsid` + `txnNumber` + `stmtId`**. Le serveur mémorise le résultat des écritures déjà
appliquées pour ce triplet ; si le driver rejoue la même opération, le primary **reconnaît**
qu'il l'a déjà exécutée et renvoie le résultat mémorisé au lieu de l'appliquer deux fois.
L'idempotence est ici obtenue **par identité**, pas par nature de l'opération.

`updateMany` et `deleteMany` ne sont **jamais** rejoués automatiquement parce qu'ils portent sur
un nombre indéterminé de documents. Si le lien casse au milieu, le driver ignore combien ont
déjà été traités : un rejeu réappliquerait l'opération à une partie d'entre eux — catastrophique
pour un `$inc`. MongoDB refuse de deviner et limite les écritures rejouables à celles qui visent
**un seul document**.

### Q33 — Le décompte final

**(a)**

```
Ecritures reussies (vues par le script) : 37
count_documents reel dans la collection : 37
Ecart (reel - reussies)                 : 0
```

**Les deux nombres coïncident, écart nul.**

**(b)** Même scénario en `w: "majority"` :

| | `w: 1` | `w: "majority"` |
|---|---|---|
| Réussies | 37 | 40 |
| Échecs | 1 | **2** |
| **Écart réel / cru** | **0** | **0** |

**L'écart ne change pas, mais le nombre d'échecs double.** `w: "majority"` ne raccourcit pas la
bascule : il rend l'application **plus honnête**. Elle attend une confirmation solide, voit donc
plus d'erreurs, mais chaque écriture qu'elle croit réussie est répliquée sur la majorité et
**ne peut plus être annulée par un rollback**. Avec `w: 1` l'écart est nul ici seulement parce
qu'aucun rollback ne s'est produit — rien ne le garantissait.

**(c) Le chiffre annoncé à la DSI**

> « Lors d'une panne serveur brutale, notre service est indisponible en écriture pendant
> **environ 11 secondes** et perd **au plus 1 écriture** — celle en cours au moment de la
> panne —, **à condition** que l'application écrive en `w: "majority"`, utilise l'URI complète
> du Replica Set, et sache retenter une écriture rejetée. »

---

## Partie 6 — Réflexion

### R1 — Le collègue qui veut un 4ᵉ nœud

**Vérifié avant de répondre.**

```bash
docker run -d --name mongo4 --network rslab_default mongo:7.0 \
  mongod --replSet rs0 --bind_ip_all --port 27017 --oplogSize 128
docker exec mongo1 mongosh --quiet --eval 'rs.add("mongo4:27017")'     # ok: 1
```

```
mongo1:27017 PRIMARY | mongo2:27017 SECONDARY | mongo3:27017 SECONDARY | mongo4:27017 SECONDARY
```

**Test 1 — 4 membres, 2 pannes** (`docker stop mongo3 mongo4`) :

```
isWritablePrimary=false  myState=2
ecriture REFUSEE : NotWritablePrimary - not primary
```

**Test 2 — 4 membres, 1 panne** (on relance `mongo3`) :

```
isWritablePrimary=true
ecriture ACCEPTEE
```

**Rappel Q23 — 3 membres, 2 pannes :** écriture refusée, `NotWritablePrimary`.
**Q23 — 3 membres, 1 panne :** écriture acceptée.

| Configuration | 1 panne | 2 pannes |
|---|---|---|
| 3 membres (Q23) | ✅ écritures acceptées | ❌ refusées |
| 4 membres (R1) | ✅ écritures acceptées | ❌ **refusées** |

**Réponse au collègue, en une phrase :** un 4ᵉ nœud **ne change strictement rien à la tolérance
aux pannes** — j'ai vérifié que 4 membres avec 2 pannes refusent les écritures exactement comme
3 membres avec 2 pannes, parce que la majorité passe de 2 à 3 et absorbe entièrement le nœud
ajouté ; on paie une machine, une licence et un point de panne de plus pour zéro gain de
disponibilité.

**Ce que je propose à la place, avec un budget de 4 machines :**

1. **Le meilleur choix — répartir les 3 nœuds sur 3 zones de disponibilité distinctes**, et
   consacrer la 4ᵉ machine à autre chose : sauvegardes, supervision, ou environnement de
   pré-production. La vraie fragilité d'un set de 3 n'est pas le nombre de nœuds, c'est leur
   concentration : trois nœuds dans la même baie tombent ensemble (cf. Q27).
2. **Si l'objectif est vraiment de tolérer 2 pannes**, il faut **5 membres votants** (majorité
   de 3) — pas 4. Avec 4 machines, une alternative est un membre **`priority: 0`** en
   quatrième : il ne vote pas pour lui-même mais sert de copie de secours ou de nœud de lecture
   analytique, sans dégrader le quorum.
3. **Ne surtout pas** ajouter un arbitre en 4ᵉ pour « faire nombre » — voir B1, c'est le
   contraire d'une sécurité.

### R2 — Deux problèmes, deux réponses

**Le problème que résout la réplication** : *comment un service survit-il à la perte d'une
machine ?* — c'est un problème de **disponibilité et de durabilité**. Réponse : N copies
complètes de la même donnée, une seule acceptant les écritures. Mesuré aujourd'hui : ~10 s
d'interruption au lieu d'une panne totale (Q21, Q31).

**Le problème que résout le sharding** : *comment servir un volume de données ou un débit
d'écriture qu'une seule machine ne peut plus encaisser ?* — c'est un problème de **capacité et
de passage à l'échelle**. Réponse : découper la donnée en fragments répartis sur plusieurs
machines, chacune n'en portant qu'une part.

Ils sont **orthogonaux** : la réplication duplique la même donnée, le sharding la divise. Répondre
à l'un ne résout jamais l'autre.

**Nombre de machines d'un cluster de production à 3 shards**, en appliquant la règle de majorité
de la Q23(c) — tout composant portant de la donnée doit être un Replica Set de **3 membres**
(impair, majorité de 2, tolère 1 panne) :

| Composant | Détail | Machines |
|---|---|---|
| Shards | 3 shards × 3 nœuds répliqués | **9** |
| Config servers | 1 Replica Set de config (`configsvr`) | **3** |
| Routeurs `mongos` | 2 minimum, pour ne pas avoir un point de panne unique | **2** |
| **Total** | | **14** |

On passe donc de 3 machines (simple Replica Set) à **14** — pour 3 shards seulement. C'est le
coût réel du sharding, et la raison pour laquelle on ne shard que lorsqu'on y est contraint.

**Pourquoi un cluster shardé sans réplication serait plus fragile qu'un simple Replica Set :**
parce que les modes de panne **s'additionnent au lieu de se compenser**. Avec 3 shards non
répliqués, chaque machine détient **le seul exemplaire** d'un tiers des données. La perte d'une
seule machine rend ce tiers **définitivement inaccessible** — et, comme les requêtes non ciblées
sont diffusées à tous les shards, une part importante des requêtes échoue, y compris celles qui
portent sur les deux tiers survivants. On a **multiplié par 3 la probabilité qu'une panne
survienne** (trois machines au lieu d'une) tout en **supprimant toute capacité à y survivre**.

D'où la règle : **chaque shard est lui-même un Replica Set**, et le Replica Set de config aussi
— sinon perdre les config servers rend le cluster entier inutilisable, quelle que soit la santé
des shards. Sharding et réplication ne s'opposent pas : **le sharding présuppose la
réplication**.

### R3 — Régler le curseur (expérience refaite)

```js
cfg = rs.conf(); cfg.settings.electionTimeoutMillis = 2000; rs.reconfig(cfg)
// nouvelle valeur : 2000
```

Nouveau `docker kill` du primary, `watch_primary.py` en marche :

```
15:19:37.346 [  0.000s] primary = mongo1:27017
15:19:44.004 [  6.674s] primary = mongo3:27017      <- kill a 15:19:41.835
```

**(a) Les deux délais**

| `electionTimeoutMillis` | Délai mesuré |
|---|---|
| 10 000 ms | **9,696 s** |
| 2 000 ms | **2,169 s** |
| **Rapport** | **4,47×** |

**Non, la bascule n'est pas 5 fois plus rapide : elle l'est 4,47 fois.** Diviser le paramètre
par 5 ne divise pas le délai total par 5, parce qu'une partie du temps **ne dépend pas de ce
paramètre** :

- le **temps du vote lui-même** : demande de candidature, réponses des autres membres,
  proclamation — de l'ordre de 200 à 700 ms, incompressible ;
- la **granularité des heartbeats** (`heartbeatIntervalMillis = 2000`) : la détection ne peut
  pas être plus fine que l'intervalle entre deux battements ;
- le **temps de rattrapage** (*catch-up*) du candidat, qui doit avoir appliqué l'oplog avant de
  prendre le rôle.

Ces ~170 à 700 ms de plancher sont négligeables face à 10 s, mais représentent près de 10 % du
délai à 2 s. **Plus on baisse le timeout, moins on gagne proportionnellement** — les rendements
sont décroissants.

**(b) Le risque à descendre trop bas**

Un réseau qui a un **hoquet de 3 secondes** — GC, saturation temporaire, reconfiguration de
switch, snapshot de VM. Avec `electionTimeoutMillis = 2000`, les secondaries déclarent le
primary mort **alors qu'il est parfaitement vivant** et déclenchent une élection. Ce qu'elle
coûte n'est pas anodin :

- pendant l'élection, **aucune écriture n'est acceptée** — on s'inflige l'interruption qu'on
  cherchait à réduire ;
- les écritures acceptées en `w: 1` sur l'ancien primary et non répliquées sont candidates au
  **rollback** (Q24) — on transforme un incident réseau sans conséquence en **perte de données** ;
- au retour du nœud, une **seconde bascule** survient s'il a une priorité supérieure (Q19).

Le scénario dégénère : sur un réseau qui hoquette régulièrement, on entre en **oscillation** —
élections en boucle, aucune stabilité. **Un timeout trop bas transforme des micro-incidents
invisibles en pannes réelles.** C'est très exactement pour cela que la valeur par défaut est
généreuse.

**(c) Ce que je recommande à la DSI**

Valeur d'origine remise :

```js
cfg = rs.conf(); cfg.settings.electionTimeoutMillis = 10000; rs.reconfig(cfg)
// electionTimeoutMillis retabli : 10000
```

**Je recommande de conserver 10 000 ms**, et l'argument est chiffré. Le SLA de 99,9 % autorise
**43 minutes d'indisponibilité par mois**. À **9,7 s par panne brutale**, ce budget couvre
**266 pannes serveur mensuelles** — soit près de 9 par jour. **La réplication n'est pas le
facteur limitant du SLA**, elle en est très loin. Descendre à 2 000 ms ferait gagner 7,5 s par
incident, c'est-à-dire **0,03 % du budget mensuel**, en échange d'un risque d'élections
intempestives et de rollbacks à chaque hoquet réseau. **Le gain est dérisoire, le risque ne
l'est pas.**

Un réglage a en revanche un vrai retour sur investissement : **aligner les priorités des trois
membres**. Il supprime la seconde bascule de **12,4 s** au retour du nœud (Q19), soit
**davantage que ce que ferait gagner le passage à 2 000 ms** — sans aucun risque ajouté.

### R4 — Le chiffre honnête

**La phrase livrée à la DSI :**

> « Lors d'une panne serveur brutale, notre service reste disponible en lecture et redevient
> disponible en écriture en **environ 11 secondes** — 9,7 s mesurées côté cluster, 10,8 s
> réellement subies par l'application — en perdant **au plus une écriture**, celle en cours au
> moment de la panne ; cette garantie de non-perte n'est acquise **qu'en `w: "majority"`**, et
> le coût réel d'un incident est aujourd'hui de **22 secondes** parce que le retour du serveur
> provoque une seconde bascule de 12,4 s, que l'on peut supprimer en alignant les priorités des
> nœuds. »

**Pourquoi n'annoncer que le chiffre de la Q21 serait malhonnête**, en trois points.

D'abord, **9,7 s est une mesure de laboratoire** : c'est le temps que met le *cluster* à élire
un nouveau primary, observé par un outil de supervision branché en direct. L'application, elle,
a subi **10,8 s** (Q31) parce qu'elle doit encore refaire sa propre découverte de topologie.
Annoncer 9,7 s, c'est présenter comme mesure de service ce qui n'est qu'une mesure interne, et
sous-estimer d'emblée l'indisponibilité réelle.

Ensuite, **ce chiffre ne dit rien de la perte de données**, qui est la question qui intéresse
vraiment la DSI. Ma Q26 a montré qu'**une écriture peut exister sur le primary sans être
confirmée par la majorité** — et une telle écriture est annulable par rollback lors de la
bascule. Un délai de reprise court avec des écritures perdues est un moins bon résultat qu'un
délai plus long sans perte : **le chiffre de disponibilité seul cache l'arbitrage qui compte**.

Enfin, il **ne couvre qu'un seul scénario de panne, le plus favorable**. Il ne dit rien de la
perte de deux nœuds sur trois (Q23 : service en lecture seule jusqu'à intervention humaine),
rien de la seconde bascule au retour du nœud (Q19 : +12,4 s, soit le double du coût annoncé),
rien d'une partition réseau qui laisse les nœuds à moitié joignables. **Un chiffre unique
présenté sans son périmètre n'est pas une mesure, c'est un argument commercial** — et il se
retournera contre nous au premier incident qui sortira du scénario testé.

---

## Nettoyage de fin de séance

```bash
docker compose -f docker-compose.rs.yml down -v
```

Le port 27017 est libéré pour le Jour 4.

---

## Checklist

- [x] `reponses_jour3.md` — Q1 → Q33 avec commande et sortie observée, R1 → R4 citant mes chiffres
- [x] [`failover.md`](failover.md) — tableau des 3 scénarios avec délais mesurés
- [x] [`resilience.md`](resilience.md) — sortie brute horodatée, décompte, comparaison avec/sans `retryWrites`
- [x] [`writer.py`](writer.py) complété, [`watch_primary.py`](watch_primary.py)
- [x] [`docker-compose.rs.yml`](docker-compose.rs.yml) et [`init-rs.js`](init-rs.js) réellement exécutés

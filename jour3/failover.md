# failover.md — mesures de bascule

Replica Set `rs0` — 3 nœuds `mongo1` (priority 2), `mongo2`, `mongo3` (priority 1).
`electionTimeoutMillis = 10000`, `heartbeatIntervalMillis = 2000`.
Mesures prises avec `watch_primary.py` (sondage toutes les 300 ms, connexion directe sur un
observateur qui n'est pas la victime).

---

## Q22 — Tableau de synthèse

| Scénario | Commande | Instant de la commande | Nouveau primary vu à | **Délai mesuré** | Nœud élu | Écritures perdues ? |
|---|---|---|---|---|---|---|
| Arrêt propre | `docker stop mongo1` | 14:56:24.832 | 14:56:25.116 | **0,284 s** | `mongo2` | non |
| Panne brutale | `docker kill mongo1` | 14:57:48.026 | 14:57:57.722 | **9,696 s** | `mongo3` | 1 (mesurée en Q31) |
| Retour du nœud | `docker start mongo1` | 14:56:47.209 | 14:56:59.632 | **12,423 s** | `mongo1` (reprise) | non |
| Panne brutale, `electionTimeoutMillis = 2000` (R3) | `docker kill mongo1` | 15:19:41.835 | 15:19:44.004 | **2,169 s** | `mongo3` | — |

**Rapport arrêt propre / panne brutale : 9,696 / 0,284 = 34×.**

---

## Détail des observations

### Arrêt propre — `docker stop` (Q17)

```
14:56:20.275 [  0.000s] primary = mongo1:27017
14:56:25.116 [  4.873s] primary = mongo2:27017
```

`docker stop` envoie un **SIGTERM** : `mongod` a le temps de prévenir le set qu'il se retire.
Le set n'attend donc aucun timeout, il élit immédiatement. 284 ms, c'est le temps du vote,
pas celui d'une détection.

### État pendant la bascule (Q18)

Relevé sur `mongo2` juste après le `docker stop` :

```
  mongo1:27017 | SECONDARY | health=1
  mongo2:27017 | PRIMARY   | health=1
  mongo3:27017 | SECONDARY | health=1
```

Instant intéressant : `mongo1` est encore vu **SECONDARY avec `health = 1`** — il a rétrogradé
proprement avant de mourir. Quelques secondes plus tard, une fois le processus réellement
arrêté :

```
  mongo1:27017 | (not reachable/healthy) | health=0
```

C'est `health` qui bascule à 0, et c'est donc **`health`**, croisé avec `lastHeartbeat`, qu'on
surveille en production pour dire qu'un nœud est injoignable — `stateStr` seul ne suffit pas,
il reste à `SECONDARY` pendant la phase de retrait propre.

### Retour du nœud et reprise de rôle (Q19)

```
14:56:47.209  docker start mongo1
14:56:59.632  primary = mongo1:27017      -> 12,423 s
```

`mongo1` revient d'abord en `(not reachable/healthy)` (health = 0) le temps que `mongod`
démarre, puis `STARTUP2`, puis `SECONDARY`. Il ne reprend pas la main immédiatement : il doit
d'abord rattraper l'oplog. Une fois à jour, comme `rs.conf().members[0].priority = 2` est
strictement supérieure à celle des deux autres, il déclenche un **priority takeover** et force
une nouvelle élection pour redevenir `PRIMARY`.

**Bilan : 2 bascules pour une seule panne** — une à l'arrêt (mongo1 → mongo2), une au retour
(mongo2 → mongo1). C'est l'argument contre les priorités asymétriques en production : chaque
retour de nœud provoque une seconde interruption d'écriture, alors que le service tournait
très bien sur `mongo2`. On paie deux fois pour un seul incident. Sauf contrainte
d'infrastructure réelle (un nœud sur du matériel nettement supérieur, ou dans le datacenter
principal), on laisse toutes les priorités égales et on laisse le primary là où il est.

### Panne brutale — `docker kill` (Q21)

```
14:57:43.494 [  0.000s] primary = mongo1:27017
14:57:48.337 [  4.851s] primary = AUCUN PRIMARY      <- kill a 14:57:48.026
14:57:57.722 [ 14.237s] primary = mongo3:27017
```

**9,696 s**, soit **34× le délai de l'arrêt propre**. `docker kill` envoie un **SIGKILL** :
aucun préavis, comme une alimentation débranchée. Le set ne peut que constater l'absence.

**Pourquoi 9,696 s et pas exactement 10 000 ms ?** Le compte à rebours ne démarre pas au
moment du `kill`, mais au **dernier heartbeat reçu avec succès**. Avec
`heartbeatIntervalMillis = 2000`, ce dernier heartbeat date d'au plus 2 s *avant* la mort du
nœud. La fenêtre observée depuis l'extérieur est donc comprise entre
`10 000 − 2 000 = 8 s` et `10 000 ms`, plus le temps du vote (~200 à 700 ms). Mes 9,696 s
tombent bien dans cet intervalle : le dernier heartbeat était à ~0,5 s avant le kill.

On note aussi une phase intermédiaire explicite de ~5 s dans le log : **`AUCUN PRIMARY`**.
Pendant tout ce temps, le cluster est vivant à 2 nœuds sur 3 mais **n'accepte aucune écriture**.
C'est exactement ce que l'application subit (Q31).

---

## Ce que j'annonce à la DSI

Une panne serveur brutale coûte **environ 10 secondes d'indisponibilité en écriture** (9,7 s
mesurées côté cluster, ~10 s côté application), et **aucune perte de donnée** dès lors que les
écritures sont confirmées en `w: "majority"`. Le SLA de 99,9 % autorise 43 minutes par mois :
à 10 secondes par incident, le budget couvre **plus de 250 pannes serveur mensuelles** — la
réplication n'est pas le facteur limitant du SLA, et de très loin.

Deux réserves à énoncer en même temps que le chiffre, sinon il est trompeur. D'abord, ces
10 secondes ne valent que pour une panne **franche et isolée** ; une partition réseau qui
laisse les nœuds à moitié joignables, ou la perte de deux nœuds sur trois (Q23), coûte
l'indisponibilité totale en écriture jusqu'à intervention humaine — et là le budget de 43 min
part en quelques minutes. Ensuite, le retour du nœud provoque une **seconde bascule** de
12,4 s à cause de la priorité asymétrique : le coût réel d'un incident est aujourd'hui de
**22 secondes, pas 10**. Aligner les priorités supprime la moitié de la facture sans rien
coûter.

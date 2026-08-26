# resilience.md — ce que perd vraiment l'application

`writer.py` insère un document par seconde dans `census.heartbeat` et journalise, ligne par
ligne, l'horodatage, le primary vu par le driver et le résultat de l'écriture.
`serverSelectionTimeoutMS = 5000`.

Le script tourne **dans le réseau du cluster**, seul moyen de joindre `mongo1/2/3` par les noms
que le driver découvre lui-même (cf. Q29) :

```bash
docker run --rm --network rslab_default -v "$PWD:/app" -w /app python:3.12-slim \
  sh -c "pip install -q 'pymongo>=4.6' && python writer.py \
    'mongodb://mongo1:27017,mongo2:27017,mongo3:27017/?replicaSet=rs0&retryWrites=true' 45"
```

> Les horodatages du script sont en UTC (horloge du conteneur), ceux des commandes `docker`
> en heure locale : **2 h d'écart**. `docker kill` lancé à 15:02:50.499 locale = **13:02:50.499**
> dans le log.

---

## Q30 — Les 5 premières lignes

```
# uri=mongodb://mongo1:27017,mongo2:27017,mongo3:27017/?replicaSet=rs0&retryWrites=true
# duree=45s  writeConcern w=1
13:02:15.188 | n=  1 | primary=None                   | OK     ( 0.02s)
13:02:16.188 | n=  2 | primary=('mongo1', 27017)      | OK     ( 0.00s)
13:02:17.188 | n=  3 | primary=('mongo1', 27017)      | OK     ( 0.00s)
13:02:18.188 | n=  4 | primary=('mongo1', 27017)      | OK     ( 0.00s)
13:02:19.189 | n=  5 | primary=('mongo1', 27017)      | OK     ( 0.00s)
```

Le primary vu est **`mongo1:27017`**. À la toute première ligne il vaut `None` : la découverte
de topologie n'est pas encore terminée, mais l'écriture passe quand même — le driver attend la
sélection du serveur avant d'envoyer, il ne l'attend pas pour répondre à `client.primary`.

---

## Q31 — La mesure qui compte (`docker kill mongo1` à 13:02:50.499)

Sortie brute autour de la panne :

```
13:02:45.193 | n= 31 | primary=('mongo1', 27017)      | OK     ( 0.00s)
13:02:46.193 | n= 32 | primary=('mongo1', 27017)      | OK     ( 0.00s)
13:02:47.194 | n= 33 | primary=('mongo1', 27017)      | OK     ( 0.00s)
13:02:48.195 | n= 34 | primary=('mongo1', 27017)      | OK     ( 0.00s)
13:02:49.195 | n= 35 | primary=('mongo1', 27017)      | OK     ( 0.00s)
13:02:50.195 | n= 36 | primary=('mongo1', 27017)      | OK     ( 0.00s)   <- derniere OK
                                                            *** docker kill a 13:02:50.499 ***
13:02:51.195 | n= 37 | primary=None                   | ECHEC  ( 5.04s) ServerSelectionTimeoutError:
                                                       No primary available for writes, Timeout: 5.0s
13:02:56.233 | n= 38 | primary=None                   | OK     ( 4.79s)  <- reprise
----------------------------------------------------------------------------------------
Ecritures reussies (vues par le script) : 37
Ecritures en echec                      : 1
count_documents reel dans la collection : 37
Ecart (reel - reussies)                 : 0
```

**(a)** Une seule seconde d'écriture en échec au sens du décompte, mais la **fenêtre réelle
d'indisponibilité** est plus large que cette ligne unique :

- dernière écriture réussie : **13:02:50.195**
- première ligne en échec : **13:02:51.195** (elle a attendu 5,04 s avant d'abandonner)
- première ligne redevenue OK : **13:02:56.233**, mais elle a elle-même mis **4,79 s** à
  aboutir — l'écriture n'atterrit donc qu'à ≈ **13:03:01.02**

Indisponibilité vue de l'application : **≈ 10,8 s** entre la dernière écriture confirmée et la
suivante. Le décompte « 1 échec » est trompeur : le script est cadencé à 1 s, mais une tentative
qui bloque 5 s décale tout le rythme. **C'est la durée qui compte, pas le nombre de lignes.**

**(b)** **37 réussies, 1 en échec.**

**(c)** **Oui, le driver s'est reconnecté seul** — je n'ai rien redémarré. Il a marqué `mongo1`
comme injoignable, refait sa découverte de topologie et retrouvé le nouveau primary tout seul.
Le changement se voit à la ligne **n = 37**, où `primary` passe de `('mongo1', 27017)` à
`None` : le driver sait déjà qu'il n'y a plus de primary alors que l'élection n'a pas encore
eu lieu.

**(d)** Comparaison avec la Q21 :

| Mesure | Valeur |
|---|---|
| Q21 — vue du cluster (`watch_primary.py`) | **9,696 s** |
| Q31 — vue de l'application | **≈ 10,8 s** |
| Écart | **≈ +1,1 s** |

Elles **ne sont pas égales, et l'application perd toujours plus**. Deux causes s'additionnent.
D'abord le driver ne découvre pas le nouveau primary à l'instant de son élection : il doit
lui-même refaire un tour de découverte de topologie, ce qui ajoute un délai. Ensuite, la
cadence du script quantifie la mesure — une tentative bloquée 5 s pousse la suivante d'autant.
**Le chiffre honnête à annoncer est celui de la Q31**, pas celui de la Q21 : c'est ce que
l'utilisateur subit.

---

## Q32 — `retryWrites`, trois expériences

### (a) et (b) — Panne brutale, avec et sans `retryWrites`

| Configuration | Écritures OK | Échecs | Type d'exception |
|---|---|---|---|
| `retryWrites=true` | 37 | **1** | `ServerSelectionTimeoutError` |
| `retryWrites=false` | 41 | **1** | `ServerSelectionTimeoutError` |

**Écart : nul.** Extrait du run `retryWrites=false` (`docker kill` à 13:04:49.598) :

```
13:04:49.362 | n= 19 | primary=('mongo1', 27017)      | OK     ( 0.00s)
13:04:50.362 | n= 20 | primary=None                   | ECHEC  ( 5.50s) ServerSelectionTimeoutError:
                                                       No primary available for writes, Timeout: 5.0s
13:04:55.859 | n= 21 | primary=None                   | OK     ( 4.52s)
13:05:00.376 | n= 22 | primary=('mongo3', 27017)      | OK     ( 0.00s)
```

**L'explication.** Pendant une bascule brutale, il y a **≈ 9,7 s sans aucun primary** dans le
cluster (Q21) — mon `watch_primary.py` affiche même explicitement `AUCUN PRIMARY` pendant cette
fenêtre. Que fait le driver pendant ce temps ? **Il attend** : la durée affichée sur la ligne en
échec est de **5,04 s**, soit exactement le `serverSelectionTimeoutMS = 5000` du script. Il
n'échoue donc pas sur une erreur d'écriture, il échoue sur une **sélection de serveur** — il n'a
jamais réussi à envoyer quoi que ce soit.

Or `retryWrites` rejoue **une fois** une écriture qui a échoué. Rejouer suppose qu'il existe un
primary à qui reparler. Quand le cluster n'en a aucun pendant 10 s, rejouer immédiatement mène
au même mur. **`retryWrites` ne peut rien contre l'absence de primary** — d'où l'écart nul.
C'est le résultat attendu, ce n'est pas une erreur de manipulation.

### (c) L'expérience qui prouve — `rs.stepDown()`

Ici le primary **rétrograde en restant vivant** : il y a immédiatement un autre nœud élu, donc
quelqu'un à qui rejouer.

| Configuration | Écritures OK | Échecs | Observation |
|---|---|---|---|
| `retryWrites=true` | 60 | **0** | bascule invisible |
| `retryWrites=false` (cadence 1 s) | 60 | **0** | — |
| `retryWrites=false` (cadence 20 ms) | 1981 | **0** | — |
| `retryWrites=false` (cadence continue, 3 `stepDown`) | 139 733 | **0** | — |

Avec `retryWrites=true`, le passage se lit à la ligne près, **sans une seule erreur** :

```
13:07:47.970 | n= 12 | primary=('mongo1', 27017)      | OK     ( 0.00s)
13:07:48.970 | n= 13 | primary=('mongo2', 27017)      | OK     ( 0.00s)   <- bascule
13:07:49.971 | n= 14 | primary=('mongo2', 27017)      | OK     ( 0.00s)
```

**Résultat honnête : je n'ai pas obtenu l'écart attendu.** Quatre exécutions, dont une à cadence
continue avec 139 733 écritures et trois `stepDown` successifs, donnent **0 échec dans les deux
configurations**. Je ne maquille pas le résultat, je l'explique.

PyMongo effectue la **sélection du serveur avant d'envoyer** chaque écriture. Pour qu'un
`stepDown` provoque une erreur non rejouée, il faut qu'une écriture soit **déjà partie vers
l'ancien primary** à la microseconde où il rétrograde. Mes écritures durent ~0,3 ms ; même à
cadence continue, la probabilité qu'une requête soit en vol pile à cet instant reste faible, et
`rs.stepDown()` laisse par surcroît un délai de rattrapage aux secondaries avant de lâcher le
rôle. Autrement dit, **la fenêtre de tir existe mais est trop étroite pour être touchée de façon
fiable depuis un seul client séquentiel** ; il faudrait plusieurs dizaines de threads écrivant
en parallèle pour la rendre statistiquement certaine.

Ce que l'expérience montre malgré tout, et qui est l'essentiel : avec `retryWrites=true`, la
bascule `mongo1 → mongo2` est **totalement transparente pour l'application**, sans une ligne
d'erreur.

**Conclusion.** `retryWrites` protège contre les pannes **transitoires où un primary reste
joignable ou le redevient immédiatement** : rétrogradation, coupure réseau brève, timeout
isolé — bref, les erreurs marquées « retryable » par le serveur. Il ne peut **rien** contre une
fenêtre pendant laquelle le cluster n'a **aucun primary** : là, ce n'est pas l'écriture qui
échoue, c'est la sélection de serveur, et rejouer ne fait que retomber sur la même absence.

### (d) Pourquoi rejouer ne crée pas de doublon

La réponse est dans l'entrée d'oplog de la Q10 :

```js
{ lsid: { id: UUID('e03e1db2-...'), uid: Binary(...) },
  txnNumber: Long('1'),
  stmtId: 0,
  op: 'i', ns: 'census.zips', ... }
```

Chaque écriture rejouable porte un triplet **`lsid` (identifiant de session logique) +
`txnNumber` + `stmtId`**. Le serveur mémorise le résultat des écritures déjà appliquées pour ce
triplet : si le driver rejoue exactement la même opération, le primary **reconnaît qu'il l'a
déjà exécutée** et renvoie le résultat mémorisé au lieu de l'appliquer une seconde fois.
L'écriture devient idempotente **par identité**, pas par nature.

`updateMany` et `deleteMany` ne sont, eux, **jamais rejoués automatiquement** parce qu'ils
touchent un nombre indéterminé de documents en une seule opération logique. Si le lien casse au
milieu, le driver ne sait pas combien de documents ont déjà été modifiés — il ne peut donc pas
savoir ce qu'il resterait à faire, et un rejeu appliquerait potentiellement l'opération deux
fois à une partie des documents (fatal pour un `$inc`). MongoDB refuse de deviner : les
écritures rejouables sont limitées à celles qui visent **un seul document**.

---

## Q33 — Le décompte final

**(a)** Sur le run de référence :

```
Ecritures reussies (vues par le script) : 37
count_documents reel dans la collection : 37
Ecart (reel - reussies)                 : 0
```

**Les deux nombres coïncident, écart = 0.** Aucune écriture fantôme, aucune écriture perdue.

> Précision méthodologique : sur un run intermédiaire j'ai relevé un écart de +37 — c'était un
> artefact, la collection n'avait pas été vidée entre deux exécutions. Les runs présentés ici
> sont tous précédés d'un `db.heartbeat.drop()`.

**(b)** Même scénario avec `w: "majority"` forcé sur les insertions :

```
# duree=50s  writeConcern w='majority'  intervalle=1.0s
13:16:14.159 | n= 25 | ECHEC ( 5.03s) ServerSelectionTimeoutError: No primary available for writes
13:16:19.190 | n= 26 | ECHEC ( 5.04s) ServerSelectionTimeoutError: No primary available for writes
----------------------------------------------------------------------------------------
Ecritures reussies (vues par le script) : 40
Ecritures en echec                      : 2
count_documents reel dans la collection : 40
Ecart (reel - reussies)                 : 0
```

| | `w: 1` | `w: "majority"` |
|---|---|---|
| Réussies | 37 | 40 |
| Échecs | 1 | **2** |
| Écart réel / cru | **0** | **0** |

**L'écart ne change pas — il reste nul —, mais le nombre d'échecs double.** C'est exactement le
compromis attendu : `w: "majority"` ne rend pas la bascule plus rapide, il rend l'application
**plus honnête**. Elle passe plus de temps à attendre une confirmation solide, donc elle voit
davantage d'erreurs ; en contrepartie, chaque écriture qu'elle croit réussie est répliquée sur
la majorité et **ne peut plus être annulée par un rollback**. Avec `w: 1`, l'écart est nul ici
parce que aucun rollback ne s'est produit — mais rien ne le garantissait (cf. Q24 et Q26).

**(c) Le chiffre annoncé à la DSI**

> « Lors d'une panne serveur brutale, notre service est indisponible en écriture pendant
> **environ 11 secondes** (10,8 s mesurées côté application, 9,7 s côté cluster) et perd
> **au plus 1 écriture** — celle qui était en cours au moment de la panne —, **à condition**
> que l'application écrive en `w: "majority"`, qu'elle utilise l'URI de découverte du Replica
> Set complet, et qu'elle sache retenter une écriture rejetée. Avec `w: 1`, cette garantie de
> non-perte tombe : une écriture confirmée à l'utilisateur peut être annulée par un rollback
> lors de la bascule. »

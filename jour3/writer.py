"""Ecrit un document par seconde dans census.heartbeat et journalise le resultat.

Sert a mesurer ce que PERD une application pendant une bascule de primary :
une ligne par seconde, horodatee, avec le primary courant et le statut de l'ecriture.

Usage : python writer.py "<uri>" [duree_s] [w] [intervalle_s]

L'intervalle par defaut est de 1 s. Le descendre (ex. 0.02) permet d'avoir une
ecriture en vol au moment precis d'un rs.stepDown() : c'est la seule facon de
voir la difference que fait retryWrites (cf. Q32c).
        python writer.py "mongodb://mongo1:27017,mongo2:27017,mongo3:27017/?replicaSet=rs0"
"""

import sys
import time
from datetime import datetime

from pymongo import MongoClient
from pymongo.errors import PyMongoError
from pymongo.write_concern import WriteConcern

URI = sys.argv[1]
DUREE = int(sys.argv[2]) if len(sys.argv) > 2 else 60
W = sys.argv[3] if len(sys.argv) > 3 else 1          # write concern : 1 ou "majority"
try:
    W = int(W)
except ValueError:
    pass
INTERVALLE = float(sys.argv[4]) if len(sys.argv) > 4 else 1.0

# serverSelectionTimeoutMS volontairement court : on veut voir l'echec, pas l'attendre
client = MongoClient(URI, serverSelectionTimeoutMS=5000)
col = client["census"]["heartbeat"]
cible = col.with_options(write_concern=WriteConcern(w=W))

ok, ko, n = 0, 0, 0
print(f"# uri={URI}")
print(f"# duree={DUREE}s  writeConcern w={W!r}  intervalle={INTERVALLE}s")

t0 = time.time()
while time.time() - t0 < DUREE:
    n += 1
    horodatage = datetime.now().strftime("%H:%M:%S.%f")[:-3]
    debut = time.time()
    try:
        primaire = client.primary
    except PyMongoError:
        primaire = None

    try:
        cible.insert_one({"n": n, "ts": datetime.now()})
        ok += 1
        statut = "OK    "
        detail = ""
    except PyMongoError as e:
        ko += 1
        statut = "ECHEC "
        detail = f"{type(e).__name__}: {str(e).splitlines()[0][:110]}"

    duree = time.time() - debut
    if INTERVALLE >= 0.5 or statut.startswith("ECHEC") or n % 50 == 0:
        print(f"{horodatage} | n={n:4d} | primary={str(primaire):22s} | {statut} "
              f"({duree:5.2f}s) {detail}", flush=True)

    reste = INTERVALLE - (time.time() - debut)
    if reste > 0:
        time.sleep(reste)

print("-" * 100)
print(f"Ecritures reussies (vues par le script) : {ok}")
print(f"Ecritures en echec                      : {ko}")
try:
    reel = col.count_documents({})
    print(f"count_documents reel dans la collection : {reel}")
    print(f"Ecart (reel - reussies)                 : {reel - ok}")
except PyMongoError as e:
    print(f"count_documents impossible : {e}")

"""Surveille le cluster et horodate chaque changement de primary.

Interroge un noeud toutes les 300 ms via une connexion directe (directConnection),
pour ne pas dependre de la decouverte de topologie pendant la bascule.

Usage : python watch_primary.py [mongo2|mongo3|...]
"""

import sys
import time
from datetime import datetime

from pymongo import MongoClient
from pymongo.errors import PyMongoError

OBSERVATEUR = sys.argv[1] if len(sys.argv) > 1 else "mongo2"
PORTS = {"mongo1": 27017, "mongo2": 27018, "mongo3": 27019, "mongo4": 27020}
DUREE = int(sys.argv[2]) if len(sys.argv) > 2 else 60

client = MongoClient(
    f"mongodb://localhost:{PORTS[OBSERVATEUR]}/?directConnection=true",
    serverSelectionTimeoutMS=800,
)

print(f"# observation via {OBSERVATEUR} - {DUREE}s - une ligne par changement d'etat")
t0 = time.time()
precedent = "<init>"

while time.time() - t0 < DUREE:
    ecoule = time.time() - t0
    try:
        hello = client.admin.command("hello")
        courant = hello.get("primary", "AUCUN PRIMARY")
    except PyMongoError as e:
        courant = f"INJOIGNABLE ({type(e).__name__})"

    if courant != precedent:
        horloge = datetime.now().strftime("%H:%M:%S.%f")[:-3]
        print(f"{horloge} [{ecoule:7.3f}s] primary = {courant}", flush=True)
        precedent = courant

    time.sleep(0.3)

print(f"[{time.time() - t0:7.3f}s] fin d'observation")

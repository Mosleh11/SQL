"""
Patterns de modelisation appliques a la base mflix.
Mohammed Monsleh - MIA4 / IPSSI

Q16 : reconciliation du Computed Pattern (num_mflix_comments)
Q17 : correction du compteur en bulk_write
Q18 : Subset Pattern (3 commentaires recents embarques)

Lancement : python patterns.py
"""

from pymongo import MongoClient, UpdateOne

# une seule connexion pour tout le script
client = MongoClient("mongodb://admin:ipssi2025@localhost:27019/?authSource=admin")
db = client["mflix"]


def vrais_compteurs():
    """Nombre reel de commentaires par film, en un seul aggregate.

    Boucler avec un count_documents par film ferait 23 539 aller-retours
    reseau ; ici on ramene tout d'un coup et on compare en memoire.
    """
    pipeline = [{"$group": {"_id": "$movie_id", "nb": {"$sum": 1}}}]
    return {d["_id"]: d["nb"] for d in db.comments.aggregate(pipeline)}


def q16_incoherences(reels):
    """Compare num_mflix_comments au comptage reel. Renvoie la liste des ecarts."""
    ecarts = []
    for film in db.movies.find({}, {"_id": 1, "title": 1, "num_mflix_comments": 1}):
        stocke = film.get("num_mflix_comments")
        reel = reels.get(film["_id"], 0)
        if stocke is None:
            # le champ n'existe pas : incoherent seulement s'il y a des commentaires
            if reel > 0:
                ecarts.append((film["_id"], film.get("title"), None, reel))
        elif stocke != reel:
            ecarts.append((film["_id"], film.get("title"), stocke, reel))
    return ecarts


def q17_corriger(ecarts):
    """Remet num_mflix_comments a la vraie valeur, en une seule requete reseau.

    On ne corrige que les films detectes en Q16 : inutile de poser le champ
    sur les films qui ne l'ont jamais eu et n'ont aucun commentaire.
    """
    ops = [
        UpdateOne({"_id": _id}, {"$set": {"num_mflix_comments": reel}})
        for _id, _titre, _stocke, reel in ecarts
    ]
    if not ops:
        return 0
    return db.movies.bulk_write(ops, ordered=False).modified_count


def q18_subset(n_films=10, n_commentaires=3):
    """Subset Pattern : embarque les 3 derniers commentaires des films les plus commentes."""
    top = db.comments.aggregate([
        {"$group": {"_id": "$movie_id", "nb": {"$sum": 1}}},
        {"$sort": {"nb": -1}},
        {"$limit": n_films},
    ])

    ops = []
    for film in top:
        recents = list(
            db.comments.find(
                {"movie_id": film["_id"]},
                {"_id": 0, "name": 1, "text": 1, "date": 1},
            ).sort("date", -1).limit(n_commentaires)
        )
        ops.append(UpdateOne({"_id": film["_id"]}, {"$set": {"recent_comments": recents}}))

    modifies = db.movies.bulk_write(ops, ordered=False).modified_count if ops else 0
    return modifies, [op._filter["_id"] for op in ops]


if __name__ == "__main__":
    print("=" * 60)
    print("  PATTERNS DE MODELISATION - base mflix")
    print("=" * 60)

    total_films = db.movies.count_documents({})
    avec_champ = db.movies.count_documents({"num_mflix_comments": {"$exists": True}})
    print(f"\nFilms : {total_films} | portant num_mflix_comments : {avec_champ} "
          f"({avec_champ / total_films * 100:.1f} %)")

    # --- Q16 -------------------------------------------------------------
    reels = vrais_compteurs()
    ecarts = q16_incoherences(reels)
    print(f"\n[Q16] Compteurs incoherents : {len(ecarts)}")
    print("      Exemples (titre / stocke / reel) :")
    for _, titre, stocke, reel in ecarts[:5]:
        print(f"        - {titre} : {stocke} vs {reel}")

    # --- Q17 -------------------------------------------------------------
    modifies = q17_corriger(ecarts)
    print(f"\n[Q17] modifiedCount : {modifies}")
    restants = q16_incoherences(vrais_compteurs())
    print(f"      Verification apres correction : {len(restants)} incoherence(s)")

    # --- Q18 -------------------------------------------------------------
    modifies, ids = q18_subset()
    print(f"\n[Q18] Subset Pattern applique a {modifies} films")
    controle = db.movies.find_one({"_id": ids[0]}, {"title": 1, "recent_comments": 1})
    print(f"      Controle sur « {controle['title']} » : "
          f"{len(controle['recent_comments'])} sous-documents embarques")
    for c in controle["recent_comments"]:
        print(f"        - {c['date']:%Y-%m-%d} | {c['name']} | {c['text'][:55]}...")
    print(f"      Cles conservees : {sorted(controle['recent_comments'][0].keys())}")

    client.close()

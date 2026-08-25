// Transaction ACID multi-documents - moderation d'un commentaire
// Mohammed Monsleh - MIA4 / IPSSI
//
// Scenario : on supprime un commentaire ET on decremente num_mflix_comments
// du film. Les deux operations doivent etre atomiques : soit les deux, soit
// aucune. Necessite un replica set (conteneur mongo-rs, port 27018).
//
// Lancement : docker exec -i mongo-rs mongosh --quiet mflix < transaction.js

const dbm = db.getSiblingDB("mflix");

// --- film de travail : le plus commente (cf. Q15) -------------------------
const cible = dbm.comments.aggregate([
  { $group: { _id: "$movie_id", nb: { $sum: 1 } } },
  { $sort: { nb: -1 } },
  { $limit: 1 }
]).toArray()[0];

const filmId = cible._id;

function etat(titre) {
  const film = dbm.movies.findOne({ _id: filmId }, { title: 1, num_mflix_comments: 1 });
  const reel = dbm.comments.countDocuments({ movie_id: filmId });
  print(`  ${titre} -> compteur = ${film.num_mflix_comments} | commentaires reels = ${reel}`);
  return { compteur: film.num_mflix_comments, reel: reel };
}

print("=".repeat(62));
print("  TRANSACTION 1 - commit (moderation reussie)");
print("=".repeat(62));
const avant = etat("avant     ");

const victime = dbm.comments.findOne({ movie_id: filmId });

const session = db.getMongo().startSession();
const cdb = session.getDatabase("mflix");

session.startTransaction({ readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } });
try {
  cdb.comments.deleteOne({ _id: victime._id });
  cdb.movies.updateOne({ _id: filmId }, { $inc: { num_mflix_comments: -1 } });
  session.commitTransaction();
  print("  commit OK - commentaire supprime : " + victime._id);
} catch (e) {
  session.abortTransaction();
  print("  ROLLBACK : " + e);
}
const apres = etat("apres     ");
print(`  delta compteur = ${apres.compteur - avant.compteur} | delta commentaires = ${apres.reel - avant.reel}`);

// --- 2e transaction : on annule volontairement au milieu ------------------
print("");
print("=".repeat(62));
print("  TRANSACTION 2 - abort (erreur au milieu)");
print("=".repeat(62));
const avant2 = etat("avant     ");

const victime2 = dbm.comments.findOne({ movie_id: filmId });

session.startTransaction({ readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } });
try {
  cdb.comments.deleteOne({ _id: victime2._id });
  print("  suppression effectuee DANS la transaction");
  print("  vue depuis la transaction  -> " + cdb.comments.countDocuments({ movie_id: filmId }));
  print("  vue depuis l'exterieur     -> " + dbm.comments.countDocuments({ movie_id: filmId }) + "  (isolation)");

  throw new Error("panne simulee avant la mise a jour du compteur");
} catch (e) {
  session.abortTransaction();
  print("  abortTransaction : " + e.message);
}
const apres2 = etat("apres     ");
print(`  delta compteur = ${apres2.compteur - avant2.compteur} | delta commentaires = ${apres2.reel - avant2.reel}`);
print("  -> rien n'a ete applique, la base est revenue a son etat initial");

session.endSession();

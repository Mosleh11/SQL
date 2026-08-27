// Pipelines d'agregation - base citibike, collection trips
// Mohammed Monsleh - MIA4 / IPSSI
//
// Lancement : docker exec -i mongo-j4 mongosh -u admin -p ipssi2025 \
//               --authenticationDatabase admin citibike < pipelines.js
//
// Attention : les noms de champs contiennent des espaces ("start station id"),
// ils doivent donc toujours etre entre guillemets.

const trait = (t) => { print(""); print("===== " + t + " ====="); };

// ---------------------------------------------------------------- Q11
trait("Q11 - plage temporelle du jeu");
db.trips.aggregate([
  { $group: { _id: null,
              debut: { $min: "$start time" },
              fin:   { $max: "$stop time" } } }
]).forEach(r => { print("  premier depart : " + r.debut.toISOString());
                  print("  dernier retour : " + r.fin.toISOString()); });

// ---------------------------------------------------------------- Q12
trait("Q12 - top 5 des stations de depart");
db.trips.aggregate([
  { $group: { _id: "$start station name", n: { $sum: 1 } } },
  { $sort: { n: -1 } },
  { $limit: 5 }
]).forEach(s => print("  " + s.n + "  " + s._id));

// ---------------------------------------------------------------- Q13
trait("Q13 - par type d'abonnement");
db.trips.aggregate([
  { $group: { _id: "$usertype",
              trajets: { $sum: 1 },
              duree_moy: { $avg: "$tripduration" } } },
  { $sort: { trajets: -1 } }
]).forEach(u => print("  " + (u._id || "(absent)").padEnd(12) + " trajets=" + String(u.trajets).padStart(5)
                      + "  duree moyenne=" + u.duree_moy.toFixed(1) + " s ("
                      + (u.duree_moy / 60).toFixed(1) + " min)"));

// ---------------------------------------------------------------- Q14
trait("Q14 - trajets par jour");
db.trips.aggregate([
  { $group: { _id: { $dateTrunc: { date: "$start time", unit: "day" } }, n: { $sum: 1 } } },
  { $sort: { _id: 1 } }
]).forEach(j => print("  " + j._id.toISOString().slice(0, 10) + " : " + j.n));

// ---------------------------------------------------------------- Q15
trait("Q15 - heure de pointe (top 5)");
db.trips.aggregate([
  { $group: { _id: { $hour: "$start time" }, n: { $sum: 1 } } },
  { $sort: { n: -1 } },
  { $limit: 5 }
]).forEach(h => print("  " + String(h._id).padStart(2, "0") + "h : " + h.n + " trajets"));

// ---------------------------------------------------------------- Q16
trait("Q16 - distribution des durees ($bucket)");
db.trips.aggregate([
  { $bucket: { groupBy: "$tripduration",
               boundaries: [0, 300, 600, 1800, 3600, 1000000],
               default: "hors bornes",
               output: { n: { $sum: 1 } } } }
]).forEach(b => print("  a partir de " + String(b._id).padStart(7) + " s : " + b.n));

// ---------------------------------------------------------------- Q17
trait("Q17 - boucles (depart = arrivee)");
db.trips.aggregate([
  { $match: { $expr: { $eq: ["$start station id", "$end station id"] } } },
  { $count: "boucles" }
]).forEach(r => print("  " + r.boucles + " trajets bouclent sur leur station de depart"));

// ---------------------------------------------------------------- Q18
trait("Q18 - le champ piege : birth year");
db.trips.aggregate([
  { $group: { _id: { type: { $type: "$birth year" }, usertype: "$usertype" }, n: { $sum: 1 } } },
  { $sort: { n: -1 } }
]).forEach(r => print("  type=" + String(r._id.type).padEnd(8) + " usertype=" + String(r._id.usertype).padEnd(12)
                      + " : " + r.n));

// ---------------------------------------------------------------- Q19
trait("Q19 - age moyen en 2016 (annees numeriques seulement)");
db.trips.aggregate([
  { $match: { "birth year": { $type: "number" } } },
  { $project: { age: { $subtract: [2016, "$birth year"] } } },
  { $group: { _id: null, age_moy: { $avg: "$age" }, n: { $sum: 1 }, age_max: { $max: "$age" } } }
]).forEach(r => print("  age moyen = " + r.age_moy.toFixed(1) + " ans sur " + r.n
                      + " trajets | plus vieil usager : " + r.age_max + " ans"));

// ---------------------------------------------------------------- Q20
trait("Q20 - valeurs aberrantes");
print("  > 3 h  : " + db.trips.countDocuments({ tripduration: { $gt: 10800 } }));
print("  > 24 h : " + db.trips.countDocuments({ tripduration: { $gt: 86400 } }));
// une seule expression : sinon le REPL evalue le curseur avant le .forEach
const plusLongs = db.trips.find({}, { tripduration: 1, usertype: 1, _id: 0 }).sort({ tripduration: -1 }).limit(3).toArray();
plusLongs.forEach(t => print("    " + t.tripduration + " s (" + (t.tripduration / 3600).toFixed(1) + " h) - " + t.usertype));

// ---------------------------------------------------------------- Q21
trait("Q21 - durees moyennes hors trajets de plus de 3 h");
db.trips.aggregate([
  { $match: { tripduration: { $lte: 10800 } } },
  { $group: { _id: "$usertype", trajets: { $sum: 1 }, duree_moy: { $avg: "$tripduration" } } },
  { $sort: { trajets: -1 } }
]).forEach(u => print("  " + u._id.padEnd(12) + " trajets=" + String(u.trajets).padStart(5)
                      + "  duree moyenne=" + u.duree_moy.toFixed(1) + " s ("
                      + (u.duree_moy / 60).toFixed(1) + " min)"));

// ---------------------------------------------------------------- Q24
trait("Q24 - materialisation de la collection stations ($merge)");
db.trips.aggregate([
  { $group: { _id: "$start station id",
              nom:      { $first: "$start station name" },
              position: { $first: "$start station location" },
              departs:  { $sum: 1 } } },
  { $merge: { into: "stations", whenMatched: "replace" } }
]);
print("  stations creees : " + db.stations.countDocuments({}));
const top3 = db.stations.find().sort({ departs: -1 }).limit(3).toArray();
top3.forEach(s => print("    " + s.departs + " departs - " + s.nom + " (id " + s._id + ")"));

// ---------------------------------------------------------------- Q26
trait("Q26 - top 5 des stations d'arrivee ($lookup)");
db.trips.aggregate([
  { $group: { _id: "$end station id", arrivees: { $sum: 1 } } },
  { $sort: { arrivees: -1 } },
  { $limit: 5 },
  { $lookup: { from: "stations", localField: "_id", foreignField: "_id", as: "st" } },
  { $unwind: { path: "$st", preserveNullAndEmptyArrays: true } },
  { $project: { _id: 0, id: "$_id", arrivees: 1,
                nom: { $ifNull: ["$st.nom", "(station jamais utilisee au depart)"] },
                departs: { $ifNull: ["$st.departs", 0] } } }
]).forEach(s => print("  " + String(s.arrivees).padStart(3) + " arrivees / "
                      + String(s.departs).padStart(3) + " departs  -  " + s.nom));

// ---------------------------------------------------------------- R3(b)
trait("R3(b) - mediane des durees ($median, MongoDB 7.0+)");
db.trips.aggregate([
  { $group: { _id: null,
              mediane: { $median: { input: "$tripduration", method: "approximate" } },
              moyenne: { $avg: "$tripduration" } } }
]).forEach(r => print("  mediane = " + r.mediane.toFixed(1) + " s (" + (r.mediane / 60).toFixed(1)
                      + " min) | moyenne brute = " + r.moyenne.toFixed(1) + " s"));

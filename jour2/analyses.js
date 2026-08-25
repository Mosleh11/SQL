// Analyses agregees - base mflix
// Mohammed Monsleh - MIA4 / IPSSI Montpellier
// Lancement : docker exec -i mongo-ipssi mongosh -u admin -p ipssi2025 \
//               --authenticationDatabase admin mflix < analyses.js

print("===== Q11 - Top 5 des genres =====");
db.movies.aggregate([
  { $unwind: "$genres" },
  { $group: { _id: "$genres", nb: { $sum: 1 } } },
  { $sort: { nb: -1 } },
  { $limit: 5 }
]).forEach(g => print("  " + g._id + " : " + g.nb));

print("");
print("===== Q12 - Films par decennie =====");
// on ecarte les year stockes en chaine (cf. Q5), sinon $subtract echoue
db.movies.aggregate([
  { $match: { year: { $type: "int" } } },
  { $project: { decennie: { $subtract: ["$year", { $mod: ["$year", 10] }] } } },
  { $group: { _id: "$decennie", nb: { $sum: 1 } } },
  { $sort: { nb: -1 } }
]).forEach(d => print("  " + d._id + "s : " + d.nb));

print("");
print("===== Q13 - Note IMDB moyenne des Drama =====");
db.movies.aggregate([
  { $match: { genres: "Drama", "imdb.rating": { $type: "number" } } },
  { $group: { _id: null, moyenne: { $avg: "$imdb.rating" }, nb: { $sum: 1 } } }
]).forEach(r => print("  moyenne = " + r.moyenne.toFixed(4) + " sur " + r.nb + " films"));

print("");
print("===== Q14 - Top 3 realisateurs =====");
db.movies.aggregate([
  { $unwind: "$directors" },
  { $group: { _id: "$directors", nb: { $sum: 1 } } },
  { $sort: { nb: -1 } },
  { $limit: 3 }
]).forEach(d => print("  " + d._id + " : " + d.nb + " films"));

print("");
print("===== Q15 - Top 5 des films les plus commentes =====");
// on part de comments : c'est la collection qui porte la reference
db.comments.aggregate([
  { $group: { _id: "$movie_id", nb: { $sum: 1 } } },
  { $sort: { nb: -1 } },
  { $limit: 5 },
  { $lookup: { from: "movies", localField: "_id", foreignField: "_id", as: "film" } },
  { $unwind: "$film" },
  { $project: { _id: 0, titre: "$film.title", nb: 1, compteur_stocke: "$film.num_mflix_comments" } }
]).forEach(f => print("  " + f.titre + " : " + f.nb + " commentaires (champ num_mflix_comments = " + f.compteur_stocke + ")"));

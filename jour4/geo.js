// Requetes geospatiales 2dsphere - base citibike
// Mohammed Monsleh - MIA4 / IPSSI
//
// Point de reference : Times Square [-73.9855, 40.7580] (longitude, latitude)
// Lancement : docker exec -i mongo-j4 mongosh -u admin -p ipssi2025 \
//               --authenticationDatabase admin citibike < geo.js

const TIMES_SQUARE = [-73.9855, 40.7580];
const RAYON_TERRE_KM = 6378.1;                 // pour convertir des km en radians
const trait = (t) => { print(""); print("===== " + t + " ====="); };

// ---------------------------------------------------------------- Q27
trait("Q27 - $near SANS index");
db.trips.dropIndex("start station location_2dsphere");   // au cas ou il existe deja
try {
  db.trips.find({ "start station location": { $near: {
    $geometry: { type: "Point", coordinates: TIMES_SQUARE }, $maxDistance: 500 } } }).toArray();
  print("  (aucune erreur : l'index existait encore)");
} catch (e) {
  print("  codeName : " + e.codeName + "  code : " + e.code);
  print("  message  : " + e.message.split("\n")[0]);
}

// ---------------------------------------------------------------- Q28
trait("Q28 - creation de l'index puis $near");
print("  index : " + db.trips.createIndex({ "start station location": "2dsphere" }));
const proches = db.trips.find({ "start station location": { $near: {
  $geometry: { type: "Point", coordinates: TIMES_SQUARE }, $maxDistance: 500 } } }).toArray();
print("  trajets a moins de 500 m : " + proches.length);
print("  les 5 premiers (ordre rendu par $near) :");
proches.slice(0, 5).forEach((t, i) => print("    " + (i + 1) + ". " + t["start station name"]));

// ---------------------------------------------------------------- Q29
trait("Q29 - compter : $near interdit, $geoWithin + $centerSphere");
try {
  db.trips.countDocuments({ "start station location": { $near: {
    $geometry: { type: "Point", coordinates: TIMES_SQUARE }, $maxDistance: 500 } } });
} catch (e) {
  print("  codeName : " + e.codeName + "  code : " + e.code);
  print("  message  : " + e.message.split("\n")[0].slice(0, 220));
}

[0.5, 1].forEach(km => {
  const n = db.trips.countDocuments({ "start station location": {
    $geoWithin: { $centerSphere: [TIMES_SQUARE, km / RAYON_TERRE_KM] } } });
  print("  a moins de " + (km * 1000) + " m : " + n + " trajets");
});

// ---------------------------------------------------------------- Q30
trait("Q30 - $geoNear sur la collection stations");
print("  index : " + db.stations.createIndex({ position: "2dsphere" }));
const stations = db.stations.aggregate([
  { $geoNear: {                                  // doit etre le tout premier stage
      near: { type: "Point", coordinates: TIMES_SQUARE },
      distanceField: "distance_m",                // en metres pour du GeoJSON
      maxDistance: 1000,
      spherical: true } },
  { $project: { _id: 0, nom: 1, departs: 1, distance_m: { $round: ["$distance_m", 0] } } }
]).toArray();
print("  stations a moins de 1 km : " + stations.length);
stations.forEach(s => print("    " + String(s.distance_m).padStart(4) + " m  "
                            + String(s.departs).padStart(3) + " departs  " + s.nom));

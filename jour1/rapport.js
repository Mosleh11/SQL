// Rapport Jour 1 - collection nyc.restaurants
// Mohammed Monsleh - MIA4 / IPSSI Montpellier

const total = db.restaurants.countDocuments({});
print("=========================================");
print("  RAPPORT NYC RESTAURANTS");
print("=========================================");
print("");
print("1) Total restaurants : " + total);
print("");

// Top 5 cuisines : on compte chaque cuisine puis on trie
print("2) Top 5 des cuisines");
const cuisines = db.restaurants.distinct("cuisine");
const compteur = cuisines.map(c => ({
  cuisine: c,
  n: db.restaurants.countDocuments({ cuisine: c })
}));
void compteur.sort((a, b) => b.n - a.n);
compteur.slice(0, 5).forEach((c, i) => {
  const part = ((c.n / total) * 100).toFixed(1);
  print("   " + (i + 1) + ". " + c.cuisine + " : " + c.n + " (" + part + " %)");
});
print("");

// Repartition par arrondissement
print("3) Restaurants par arrondissement");
const boroughs = db.restaurants.distinct("borough");
boroughs.forEach(b => {
  const n = db.restaurants.countDocuments({ borough: b });
  print("   - " + b + " : " + n);
});
print("");
print("Nombre de cuisines distinctes : " + cuisines.length);
print("=========================================");

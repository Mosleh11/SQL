#!/bin/sh
# Monte un cluster sharde minimal : 1 config server, 2 shards, 1 routeur.
set -e

echo "[1/5] demarrage des 4 conteneurs"
docker compose -f docker-compose.shard.yml up -d
sleep 15

echo "[2/5] initialisation du replica set de config"
docker exec cfg1 mongosh --quiet --eval \
  "rs.initiate({_id:'cfgRS',configsvr:true,members:[{_id:0,host:'cfg1:27017'}]})"

echo "[3/5] initialisation des deux shards"
docker exec shardA mongosh --quiet --eval \
  "rs.initiate({_id:'shardA',members:[{_id:0,host:'shardA:27017'}]})"
docker exec shardB mongosh --quiet --eval \
  "rs.initiate({_id:'shardB',members:[{_id:0,host:'shardB:27017'}]})"
sleep 15

echo "[4/5] enregistrement des shards aupres du routeur"
docker exec mongos mongosh --quiet --eval \
  "sh.addShard('shardA/shardA:27017'); sh.addShard('shardB/shardB:27017')"

echo "[5/5] taille de chunk reduite a 1 Mo (pour voir des splits sur un petit jeu)"
docker exec mongos mongosh --quiet config --eval \
  "db.settings.updateOne({_id:'chunksize'},{\$set:{value:1}},{upsert:true})"

echo "cluster pret :"
docker exec mongos mongosh --quiet --eval "sh.status()" | head -30

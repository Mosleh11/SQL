#!/bin/sh
# $1 = uri, $2 = duree, $3 = w
docker run --rm --network rslab_default -v "C:/Users/mosle/Desktop/SQL/jour3:/app" -w /app python:3.12-slim \
  sh -c "pip install -q 'pymongo>=4.6' && python writer.py '$1' ${2:-45} ${3:-1} ${4:-1}"

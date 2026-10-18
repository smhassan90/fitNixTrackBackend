#!/bin/sh
set -e
cd /app
# Production data is imported from the existing MySQL dump.
# Do not run prisma db push here: it would drop tables that exist in that dump
# but are not modeled in schema.prisma.
exec node dist/server.js

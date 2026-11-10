#!/bin/bash
# Merge attendance_rows from legacy dbfitnixtrack into FitNix Docker MySQL.
# Safe to re-run: upserts by primary key and (gymId, memberId, date).
#
# Requires: /opt/apps/fitnixtrack/data/src-client.cnf (legacy MySQL client creds)
# Run on VPS: bash /opt/apps/fitnixtrack/deploy/scripts/sync-attendance-from-legacy.sh
# (copy from scripts/sync-attendance-from-legacy.sh in this repo)

set -euo pipefail

ROOT="${FITNIX_DEPLOY_ROOT:-/opt/apps/fitnixtrack}"
LEGACY_CNF="${ROOT}/data/src-client.cnf"
WORKDIR="${ROOT}/data/attendance-sync"
DOCKER_MYSQL="fitnixtrack-mysql-1"
LEGACY_DB="dbfitnixtrack"
LOCAL_DB="fitnixtrack"

if [[ ! -f "$LEGACY_CNF" ]]; then
  echo "Missing legacy client config: $LEGACY_CNF" >&2
  echo "Create it with host=66.135.60.203 port=3308 user=... password=..." >&2
  exit 1
fi

mkdir -p "$WORKDIR"

echo "=== counts before ==="
docker exec "$DOCKER_MYSQL" sh -c 'mysql -ufitnix -p"$MYSQL_PASSWORD" -N '"$LOCAL_DB"' -e "
SELECT \"local_attendance\", COUNT(*), MAX(id), MAX(updatedAt) FROM attendance_records;
SELECT \"local_pending\", COUNT(*) FROM pending_attendance_logs;
"'
docker run --rm --network host -v "$LEGACY_CNF:/src.cnf:ro" mysql:8.0 \
  mysql --defaults-extra-file=/src.cnf -N -e "
SELECT 'legacy_attendance', COUNT(*), MAX(id), MAX(updatedAt) FROM attendance_records;
SELECT 'legacy_pending', COUNT(*) FROM pending_attendance_logs;
" "$LEGACY_DB" 2>/dev/null || { echo "Cannot reach legacy MySQL" >&2; exit 1; }

echo "=== export legacy tables ==="
for tbl in attendance_records pending_attendance_logs; do
  docker run --rm --network host -v "$LEGACY_CNF:/src.cnf:ro" mysql:8.0 \
    mysqldump --defaults-extra-file=/src.cnf --no-create-info --skip-triggers --complete-insert --single-transaction --no-tablespaces \
    "$LEGACY_DB" "$tbl" >"$WORKDIR/${tbl}.sql"
  echo "exported $tbl ($(wc -c <"$WORKDIR/${tbl}.sql") bytes)"
done

echo "=== import into staging (FitNix MySQL) ==="
docker exec -i "$DOCKER_MYSQL" sh -c 'mysql -ufitnix -p"$MYSQL_PASSWORD" '"$LOCAL_DB"' -e "
DROP TABLE IF EXISTS _stg_attendance_records;
DROP TABLE IF EXISTS _stg_pending_attendance_logs;
CREATE TABLE _stg_attendance_records LIKE attendance_records;
CREATE TABLE _stg_pending_attendance_logs LIKE pending_attendance_logs;
"'

sed 's/`attendance_records`/`_stg_attendance_records`/g' "$WORKDIR/attendance_records.sql" \
  | docker exec -i "$DOCKER_MYSQL" sh -c 'mysql -ufitnix -p"$MYSQL_PASSWORD" '"$LOCAL_DB"
sed 's/`pending_attendance_logs`/`_stg_pending_attendance_logs`/g' "$WORKDIR/pending_attendance_logs.sql" \
  | docker exec -i "$DOCKER_MYSQL" sh -c 'mysql -ufitnix -p"$MYSQL_PASSWORD" '"$LOCAL_DB"

echo "=== merge attendance_records ==="
docker exec "$DOCKER_MYSQL" sh -c 'mysql -ufitnix -p"$MYSQL_PASSWORD" '"$LOCAL_DB"' -e "
INSERT INTO attendance_records (
  id, gymId, memberId, date, status, checkInTime, checkOutTime,
  deviceUserId, deviceSerialNumber, createdAt, updatedAt
)
SELECT
  id, gymId, memberId, date, status, checkInTime, checkOutTime,
  deviceUserId, deviceSerialNumber, createdAt, updatedAt
FROM _stg_attendance_records
ON DUPLICATE KEY UPDATE
  status = IF(VALUES(updatedAt) >= attendance_records.updatedAt, VALUES(status), attendance_records.status),
  checkInTime = CASE
    WHEN VALUES(updatedAt) > attendance_records.updatedAt THEN VALUES(checkInTime)
    WHEN attendance_records.checkInTime IS NULL THEN VALUES(checkInTime)
    ELSE attendance_records.checkInTime
  END,
  checkOutTime = CASE
    WHEN VALUES(updatedAt) > attendance_records.updatedAt THEN VALUES(checkOutTime)
    WHEN attendance_records.checkOutTime IS NULL THEN VALUES(checkOutTime)
    ELSE attendance_records.checkOutTime
  END,
  deviceUserId = IF(VALUES(updatedAt) >= attendance_records.updatedAt, VALUES(deviceUserId), attendance_records.deviceUserId),
  deviceSerialNumber = IF(VALUES(updatedAt) >= attendance_records.updatedAt, VALUES(deviceSerialNumber), attendance_records.deviceSerialNumber),
  attendance_records.updatedAt = GREATEST(attendance_records.updatedAt, VALUES(updatedAt));
"'

echo "=== merge pending_attendance_logs ==="
docker exec "$DOCKER_MYSQL" sh -c 'mysql -ufitnix -p"$MYSQL_PASSWORD" '"$LOCAL_DB"' -e "
INSERT INTO pending_attendance_logs (
  id, gymId, deviceConfigId, deviceUserId, recordTime, type, state,
  deviceSerialNumber, createdAt
)
SELECT
  id, gymId, deviceConfigId, deviceUserId, recordTime, type, state,
  deviceSerialNumber, createdAt
FROM _stg_pending_attendance_logs
ON DUPLICATE KEY UPDATE
  type = VALUES(type),
  state = VALUES(state),
  deviceSerialNumber = VALUES(deviceSerialNumber);
"'

docker exec "$DOCKER_MYSQL" sh -c 'mysql -ufitnix -p"$MYSQL_PASSWORD" '"$LOCAL_DB"' -e "
DROP TABLE IF EXISTS _stg_attendance_records;
DROP TABLE IF EXISTS _stg_pending_attendance_logs;
"'

echo "=== counts after ==="
docker exec "$DOCKER_MYSQL" sh -c 'mysql -ufitnix -p"$MYSQL_PASSWORD" -N '"$LOCAL_DB"' -e "
SELECT \"local_attendance\", COUNT(*), MAX(id), MAX(updatedAt) FROM attendance_records;
SELECT \"local_pending\", COUNT(*) FROM pending_attendance_logs;
"'

echo "done"

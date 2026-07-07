-- Fix badge-keyed ghost rows in device_users (attendance used userSn/badge; user sync used uid).
-- Run ONCE in MySQL Workbench against production.
-- Replace @device_id if you only want one device (e.g. SET @device_id = 1).

SET @device_id = NULL;  -- NULL = all devices

-- 1) Preview ghosts (nameless row where deviceUserId = another user's badge)
SELECT
  ghost.deviceConfigId,
  ghost.deviceUserId AS ghost_badge_id,
  named.deviceUserId AS canonical_uid,
  named.deviceUserName AS name,
  named.deviceBadgeId AS badge
FROM device_users ghost
JOIN device_users named
  ON named.deviceConfigId = ghost.deviceConfigId
 AND named.deviceBadgeId = ghost.deviceUserId
WHERE (ghost.deviceUserName IS NULL OR TRIM(ghost.deviceUserName) = '')
  AND named.deviceUserName IS NOT NULL
  AND TRIM(named.deviceUserName) <> ''
  AND (@device_id IS NULL OR ghost.deviceConfigId = @device_id);

-- 2) Re-key pending punches from badge id → canonical uid
UPDATE pending_attendance_logs pal
JOIN device_users named
  ON named.deviceConfigId = pal.deviceConfigId
 AND named.deviceBadgeId = pal.deviceUserId
SET pal.deviceUserId = named.deviceUserId
WHERE (@device_id IS NULL OR pal.deviceConfigId = @device_id);

-- 3) Remove ghost device_users rows (badge-only duplicates)
DELETE ghost FROM device_users ghost
JOIN device_users named
  ON named.deviceConfigId = ghost.deviceConfigId
 AND named.deviceBadgeId = ghost.deviceUserId
WHERE (ghost.deviceUserName IS NULL OR TRIM(ghost.deviceUserName) = '')
  AND named.deviceUserName IS NOT NULL
  AND TRIM(named.deviceUserName) <> ''
  AND (@device_id IS NULL OR ghost.deviceConfigId = @device_id);

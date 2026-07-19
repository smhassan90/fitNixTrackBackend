-- Null keeps legacy role-based access until an administrator saves explicit checkboxes.
ALTER TABLE `users`
  ADD COLUMN `permissionKeys` JSON NULL AFTER `role`;

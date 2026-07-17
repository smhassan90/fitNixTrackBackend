-- Member portrait URL (compressed ~50KB JPEG stored via blob or /uploads/members/)
ALTER TABLE `members`
  ADD COLUMN `photoUrl` VARCHAR(2048) NULL AFTER `comments`;

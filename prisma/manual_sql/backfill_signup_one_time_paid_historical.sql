-- Preview pending signup one-time payments (gym 3)
-- These cause "Pay signup fees before monthly fee" on the payments screen.
--
-- DO NOT mark them PAID with today's date — that inflates today's revenue.
-- Run the TypeScript backfill instead (uses admission/join date):
--   npx tsx prisma/backfill-pending-signup-payments.ts --gym-id=3 --dry-run
--   npx tsx prisma/backfill-pending-signup-payments.ts --gym-id=3

SET @gym_id := 3;

SELECT COUNT(*) AS pending_signup_payments
FROM one_time_payments
WHERE gymId = @gym_id AND status = 'PENDING';

SELECT
  m.legacyMemberId,
  m.name,
  m.membershipStart AS would_use_paid_date,
  o.totalAmount,
  o.status
FROM one_time_payments o
JOIN members m ON m.id = o.memberId
WHERE o.gymId = @gym_id AND o.status = 'PENDING'
ORDER BY CAST(m.legacyMemberId AS UNSIGNED), m.id
LIMIT 50;

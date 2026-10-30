-- A candidate can also be an admin (user decision 2026-10-30): `role` stays `candidate`, so their
-- sessions keep counting in reports, and `admin_role` grants admin access from the admin app only.
ALTER TABLE "users" ADD COLUMN "admin_role" "UserRole";

ALTER TABLE "users" ADD CONSTRAINT "users_admin_role_check"
CHECK ("admin_role" IS NULL OR ("role" = 'candidate' AND "admin_role" IN ('admin', 'super_admin')));

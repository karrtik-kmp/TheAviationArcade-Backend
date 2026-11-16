ALTER TABLE "media_versions" DROP CONSTRAINT "media_versions_publishable_check";--> statement-breakpoint
ALTER TABLE "media_versions" ADD COLUMN "licence_waiver" text;--> statement-breakpoint
ALTER TABLE "media_versions" ADD CONSTRAINT "media_versions_licence_waiver_check" CHECK ("media_versions"."licence_waiver" IN ('dev-demo'));--> statement-breakpoint
ALTER TABLE "media_versions" ADD CONSTRAINT "media_versions_licence_waiver_rule_check" CHECK ("media_versions"."licence_waiver" IS NULL OR ("media_versions"."licence_name" IS NULL AND "media_versions"."published_at" IS NOT NULL));--> statement-breakpoint
-- Hand edit (drizzle cannot emit NOT VALID): as in 0019, media versions published before 0019 have no rights statement, so the
-- re-added constraint must not be checked against them. NOT VALID still enforces it on every INSERT and UPDATE from now on
-- (an UPDATE of an old published row must satisfy it, which is why the service refuses to publish without a statement first).
-- Do not VALIDATE it until those rows are backfilled or retired. The only change here: "licence or waiver" replaces "licence".
ALTER TABLE "media_versions" ADD CONSTRAINT "media_versions_publishable_check" CHECK ("media_versions"."published_at" IS NULL OR (("media_versions"."licence_name" IS NOT NULL OR "media_versions"."licence_waiver" IS NOT NULL) AND (NOT "media_versions"."credit_required" OR "media_versions"."credit_name" IS NOT NULL) AND "media_versions"."rights_statement" IS NOT NULL AND "media_versions"."rights_statement" IN ('v1_own', 'v1_authorised'))) NOT VALID;
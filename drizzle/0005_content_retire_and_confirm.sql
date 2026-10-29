ALTER TABLE "content_imports" DROP CONSTRAINT "content_imports_counts_check";--> statement-breakpoint
ALTER TABLE "content_items" DROP CONSTRAINT "content_items_status_check";--> statement-breakpoint
ALTER TABLE "content_imports" ADD COLUMN "retired" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "content_imports" ADD CONSTRAINT "content_imports_counts_check" CHECK ("content_imports"."created" >= 0 AND "content_imports"."updated" >= 0 AND "content_imports"."unchanged" >= 0 AND "content_imports"."retired" >= 0);--> statement-breakpoint
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_status_check" CHECK ("content_items"."status" IN ('approved', 'retired'));
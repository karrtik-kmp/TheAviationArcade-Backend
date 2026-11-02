CREATE TABLE "content_documents" (
	"name" text NOT NULL,
	"version" integer NOT NULL,
	"format" text NOT NULL,
	"body" jsonb NOT NULL,
	"sha256" text NOT NULL,
	"byte_size" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"note" text,
	CONSTRAINT "content_documents_pk" PRIMARY KEY("name","version"),
	CONSTRAINT "content_documents_name_check" CHECK ("content_documents"."name" IN ('field-awards', 'clipper-cards', 'aircraft-tags')),
	CONSTRAINT "content_documents_version_check" CHECK ("content_documents"."version" >= 1),
	CONSTRAINT "content_documents_format_check" CHECK ("content_documents"."format" = "content_documents"."name" || '.v1'),
	CONSTRAINT "content_documents_body_check" CHECK ("content_documents"."body" @> '{}'::jsonb),
	CONSTRAINT "content_documents_sha256_check" CHECK ("content_documents"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "content_documents_byte_size_check" CHECK ("content_documents"."byte_size" > 0),
	CONSTRAINT "content_documents_created_by_check" CHECK (length("content_documents"."created_by") BETWEEN 1 AND 256),
	CONSTRAINT "content_documents_note_check" CHECK ("content_documents"."note" IS NULL OR length("content_documents"."note") <= 500)
);

--> statement-breakpoint
-- Hand-added to the generated file (drizzle-kit does not model triggers; the snapshot is unaffected): published documents
-- are immutable. A change is a new version row. A test that needs to remove a row it inserted must DISABLE this trigger
-- itself, in its own cleanup.
CREATE FUNCTION "content_documents_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'content_documents rows are immutable (% refused)', TG_OP USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "content_documents_immutable" BEFORE UPDATE OR DELETE ON "content_documents" FOR EACH ROW EXECUTE FUNCTION "content_documents_immutable"();
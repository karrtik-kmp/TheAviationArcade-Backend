CREATE TABLE "rate_limit_hits" (
	"throttler_name" text NOT NULL,
	"key_hash" text NOT NULL,
	"hit_expiries" timestamp with time zone[] DEFAULT '{}'::timestamptz[] NOT NULL,
	"window_expires_at" timestamp with time zone NOT NULL,
	"blocked" boolean DEFAULT false NOT NULL,
	"block_expires_at" timestamp with time zone,
	CONSTRAINT "rate_limit_hits_throttler_name_key_hash_pk" PRIMARY KEY("throttler_name","key_hash"),
	CONSTRAINT "rate_limit_hits_key_hash_check" CHECK ("rate_limit_hits"."key_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE INDEX "rate_limit_hits_window_expires_at_idx" ON "rate_limit_hits" USING btree ("window_expires_at");
--> statement-breakpoint
-- Atomic port of @nestjs/throttler 6.7.1 ThrottlerStorageService.increment (per-hit sliding window, optional block) on
-- the database clock. The row is locked for the whole call, so concurrent instances serialise per key.
CREATE FUNCTION rate_limit_increment(
	p_name text,
	p_key_hash text,
	p_ttl_ms bigint,
	p_limit integer,
	p_block_ms bigint
) RETURNS TABLE (total_hits integer, time_to_expire integer, is_blocked boolean, time_to_block_expire integer)
LANGUAGE plpgsql AS $fn$
DECLARE
	t timestamptz;
	r rate_limit_hits%ROWTYPE;
	hits timestamptz[];
	win timestamptz;
	blk boolean;
	blk_exp timestamptz;
	tte integer;
	ttbe integer;
	ttl interval := p_ttl_ms * interval '1 millisecond';
	limited boolean;
BEGIN
	INSERT INTO rate_limit_hits (throttler_name, key_hash, window_expires_at)
	VALUES (p_name, p_key_hash, clock_timestamp() + ttl)
	ON CONFLICT (throttler_name, key_hash) DO NOTHING;
	SELECT * INTO r FROM rate_limit_hits WHERE throttler_name = p_name AND key_hash = p_key_hash FOR UPDATE;
	t := clock_timestamp();
	hits := coalesce(ARRAY(SELECT e FROM unnest(r.hit_expiries) AS e WHERE e > t ORDER BY e), '{}'::timestamptz[]);
	win := r.window_expires_at;
	blk := r.blocked;
	blk_exp := r.block_expires_at;
	tte := ceil(extract(epoch FROM (win - t)))::integer;
	IF tte <= 0 THEN
		win := t + ttl;
		tte := ceil(extract(epoch FROM (win - t)))::integer;
	END IF;
	IF p_block_ms <= 0 THEN
		limited := cardinality(hits) >= p_limit;
		IF NOT limited THEN
			hits := hits || (t + ttl);
		END IF;
		ttbe := CASE WHEN cardinality(hits) > 0 THEN ceil(extract(epoch FROM (hits[1] - t)))::integer ELSE tte END;
		total_hits := cardinality(hits) + (CASE WHEN limited THEN 1 ELSE 0 END);
		time_to_expire := tte;
		is_blocked := limited;
		time_to_block_expire := CASE WHEN limited THEN ttbe ELSE 0 END;
	ELSE
		IF NOT blk THEN
			hits := hits || (t + ttl);
		END IF;
		IF cardinality(hits) > p_limit AND NOT blk THEN
			blk := true;
			blk_exp := t + p_block_ms * interval '1 millisecond';
		END IF;
		ttbe := CASE WHEN blk_exp IS NULL THEN 0 ELSE ceil(extract(epoch FROM (blk_exp - t)))::integer END;
		IF ttbe <= 0 AND blk THEN
			blk := false;
			hits := ARRAY[t + ttl];
		END IF;
		total_hits := cardinality(hits);
		time_to_expire := tte;
		is_blocked := blk;
		time_to_block_expire := ttbe;
	END IF;
	UPDATE rate_limit_hits
	SET hit_expiries = hits, window_expires_at = win, blocked = blk, block_expires_at = blk_exp
	WHERE throttler_name = p_name AND key_hash = p_key_hash;
	RETURN NEXT;
END
$fn$;

ALTER TABLE "rounds" DROP CONSTRAINT "rounds_module_check";--> statement-breakpoint
UPDATE "rounds" SET "module" = 'aircraft-identifier-military' WHERE "module" = 'military-identifier';--> statement-breakpoint
ALTER TABLE "rounds" ADD CONSTRAINT "rounds_module_check" CHECK ("rounds"."module" IN ('airport-spotter', 'atc-match', 'call-sign-match', 'identifier',
        'aircraft-identifier-military', 'code-search', 'runway-identifier', 'tail-identifier'));
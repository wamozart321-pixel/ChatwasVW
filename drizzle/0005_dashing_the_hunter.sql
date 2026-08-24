ALTER TABLE "conversations" ADD COLUMN "bot_paso" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "bot_datos" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "bot_intentos" integer DEFAULT 0 NOT NULL;
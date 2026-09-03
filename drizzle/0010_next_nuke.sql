CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"tipo" text NOT NULL,
	"dispositivo" text,
	"ultima_actividad" timestamp with time zone DEFAULT now() NOT NULL,
	"revocada_en" timestamp with time zone,
	"motivo" text,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_una_por_tipo_idx" ON "sessions" USING btree ("user_id","tipo") WHERE "sessions"."revocada_en" is null;
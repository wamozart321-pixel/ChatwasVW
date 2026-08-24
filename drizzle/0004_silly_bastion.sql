ALTER TABLE "messages" ADD COLUMN "eliminado_en" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "eliminado_por" uuid;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_eliminado_por_users_id_fk" FOREIGN KEY ("eliminado_por") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
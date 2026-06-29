DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'agent_type') THEN
        CREATE TYPE "agent_type" AS ENUM ('root', 'user');
    END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "agent_type" "agent_type" DEFAULT 'root';
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "usage" jsonb;

-- expect: nothing
CREATE TYPE "public"."note_status" AS ENUM('draft', 'published');--> statement-breakpoint
ALTER TYPE "public"."note_status" ADD VALUE 'archived';

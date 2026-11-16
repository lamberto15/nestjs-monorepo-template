DROP INDEX "record_subscriptions_subscriber_idx";--> statement-breakpoint
CREATE INDEX "audit_log_target_id_id_idx" ON "audit_log" USING btree ("target_id","id");--> statement-breakpoint
CREATE INDEX "audit_log_actor_id_idx" ON "audit_log" USING btree ("actor","id");--> statement-breakpoint
CREATE INDEX "audit_log_tenant_action_id_idx" ON "audit_log" USING btree ("tenant_id","action","id");--> statement-breakpoint
CREATE INDEX "record_subscriptions_subscriber_id_idx" ON "record_subscriptions" USING btree ("subscriber","id");
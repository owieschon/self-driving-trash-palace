ALTER TABLE "outbox_messages" DROP CONSTRAINT "outbox_messages_execution_tenant_fk";
--> statement-breakpoint
ALTER TABLE "executions" ADD CONSTRAINT "executions_full_correlation_unique" UNIQUE("organization_id","id","mission_id","operation_id");--> statement-breakpoint
ALTER TABLE "outbox_messages" ADD CONSTRAINT "outbox_messages_dispatch_generation_fk" FOREIGN KEY ("organization_id","command_id","dispatch_generation") REFERENCES "public"."gateway_dispatches"("organization_id","command_id","generation") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox_messages" ADD CONSTRAINT "outbox_messages_execution_tenant_fk" FOREIGN KEY ("organization_id","execution_id","mission_id","operation_id") REFERENCES "public"."executions"("organization_id","id","mission_id","operation_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_payload_binding" CHECK ("evidence"."payload" ->> 'id' = "evidence"."id" AND "evidence"."payload" ->> 'organizationId' = "evidence"."organization_id" AND "evidence"."payload" ->> 'missionId' = "evidence"."mission_id" AND "evidence"."payload" ->> 'palaceId' = "evidence"."palace_id" AND "evidence"."payload" ->> 'type' = "evidence"."type"::text);--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_authority_receipt_binding" CHECK ("evidence"."authority_receipt" ->> 'id' = "evidence"."authority_receipt_id" AND "evidence"."authority_receipt" ->> 'evidenceId' = "evidence"."id" AND "evidence"."authority_receipt" ->> 'organizationId' = "evidence"."organization_id" AND "evidence"."authority_receipt" ->> 'missionId' = "evidence"."mission_id" AND "evidence"."authority_receipt" ->> 'palaceId' = "evidence"."palace_id" AND "evidence"."authority_receipt" ->> 'authority' = "evidence"."authority"::text);--> statement-breakpoint
ALTER TABLE "outbox_messages" ADD CONSTRAINT "outbox_messages_reference_payload_only" CHECK (
        ("outbox_messages"."topic" IN ('gateway.dispatch', 'gateway.effect.reconcile') AND "outbox_messages"."payload" = jsonb_build_object('organizationId', "outbox_messages"."organization_id", 'operationId', "outbox_messages"."operation_id", 'commandId', "outbox_messages"."command_id", 'generation', "outbox_messages"."dispatch_generation"))
        OR ("outbox_messages"."topic" = 'execution.deadline' AND "outbox_messages"."payload" = jsonb_build_object('organizationId', "outbox_messages"."organization_id", 'missionId', "outbox_messages"."mission_id", 'operationId', "outbox_messages"."operation_id", 'executionId', "outbox_messages"."execution_id"))
        OR ("outbox_messages"."topic" IN ('mission.resume', 'mission.verify') AND "outbox_messages"."payload" = jsonb_build_object('organizationId', "outbox_messages"."organization_id", 'missionId', "outbox_messages"."mission_id"))
        OR ("outbox_messages"."topic" = 'operation.reconcile' AND "outbox_messages"."payload" = jsonb_build_object('organizationId', "outbox_messages"."organization_id", 'operationId', "outbox_messages"."operation_id"))
      );
--> statement-breakpoint
CREATE TRIGGER gateway_commands_append_only BEFORE UPDATE OR DELETE ON "gateway_commands" FOR EACH ROW EXECUTE FUNCTION reject_immutable_record_mutation();
--> statement-breakpoint
CREATE TRIGGER gateway_effect_reconciliation_polls_append_only BEFORE UPDATE OR DELETE ON "gateway_effect_reconciliation_polls" FOR EACH ROW EXECUTE FUNCTION reject_immutable_record_mutation();
--> statement-breakpoint
CREATE FUNCTION guard_gateway_dispatch_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'gateway dispatches cannot be deleted' USING ERRCODE = '55000';
  END IF;
  IF (NEW.organization_id, NEW.command_id, NEW.operation_id, NEW.generation, NEW.created_at)
    IS DISTINCT FROM (OLD.organization_id, OLD.command_id, OLD.operation_id, OLD.generation, OLD.created_at) THEN
    RAISE EXCEPTION 'gateway dispatch identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.status IN ('accepted', 'unknown', 'failed', 'cancelled') THEN
    RAISE EXCEPTION 'terminal gateway dispatches are immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
    (OLD.status = 'pending' AND NEW.status IN ('dispatching', 'cancelled')) OR
    (OLD.status = 'dispatching' AND NEW.status IN ('accepted', 'unknown', 'failed'))
  ) THEN
    RAISE EXCEPTION 'invalid gateway dispatch transition % to %', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  IF NEW.record_version <> OLD.record_version + 1 OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'gateway dispatch version or time did not advance' USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER gateway_dispatches_guard BEFORE UPDATE OR DELETE ON "gateway_dispatches" FOR EACH ROW EXECUTE FUNCTION guard_gateway_dispatch_mutation();
--> statement-breakpoint
CREATE FUNCTION guard_gateway_effect_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  command_kind gateway_command_kind;
  execution_authorization gateway_command_authorization_kind;
  execution_epoch integer;
BEGIN
  SELECT command.kind, execution.authorization_kind, execution.authorizing_lease_epoch
    INTO command_kind, execution_authorization, execution_epoch
    FROM gateway_commands command
    JOIN executions execution
      ON execution.organization_id = command.organization_id
     AND execution.operation_id = command.operation_id
   WHERE command.organization_id = NEW.organization_id
     AND command.id = NEW.command_id
     AND command.operation_id = NEW.operation_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'gateway effect requires a bound command and execution' USING ERRCODE = '23514';
  END IF;
  IF (NEW.cancellation_policy = 'mandatory_relock') IS DISTINCT FROM
     (NEW.milestone = 'relock' AND command_kind = 'locked_desired_state') THEN
    RAISE EXCEPTION 'only the locked desired-state relock may be mandatory' USING ERRCODE = '23514';
  END IF;
  IF (NEW.authorization_kind, NEW.authorizing_lease_epoch)
    IS DISTINCT FROM (execution_authorization, execution_epoch) THEN
    RAISE EXCEPTION 'gateway effect authorization must inherit its execution' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER gateway_effects_insert_guard BEFORE INSERT ON "gateway_effects" FOR EACH ROW EXECUTE FUNCTION guard_gateway_effect_insert();
--> statement-breakpoint
CREATE FUNCTION guard_gateway_effect_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'gateway effects cannot be deleted' USING ERRCODE = '55000';
  END IF;
  IF (NEW.organization_id, NEW.command_id, NEW.operation_id, NEW.mission_id, NEW.dispatch_at, NEW.milestone, NEW.cancellation_policy, NEW.authorization_kind, NEW.authorizing_lease_epoch, NEW.created_at)
    IS DISTINCT FROM (OLD.organization_id, OLD.command_id, OLD.operation_id, OLD.mission_id, OLD.dispatch_at, OLD.milestone, OLD.cancellation_policy, OLD.authorization_kind, OLD.authorizing_lease_epoch, OLD.created_at) THEN
    RAISE EXCEPTION 'gateway effect intent is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.status IN ('completed', 'failed') THEN
    RAISE EXCEPTION 'terminal gateway effects are immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
    (OLD.status = 'pending' AND NEW.status IN ('acknowledged', 'executing', 'completed', 'failed')) OR
    (OLD.status = 'acknowledged' AND NEW.status IN ('executing', 'completed', 'failed')) OR
    (OLD.status = 'executing' AND NEW.status IN ('completed', 'failed'))
  ) THEN
    RAISE EXCEPTION 'invalid gateway effect transition % to %', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  IF OLD.cancellation_requested_at IS NOT NULL AND NEW.cancellation_requested_at IS DISTINCT FROM OLD.cancellation_requested_at THEN
    RAISE EXCEPTION 'gateway effect cancellation request is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.reconciliation_attempts < OLD.reconciliation_attempts OR NEW.reconciliation_attempts > OLD.reconciliation_attempts + 1 THEN
    RAISE EXCEPTION 'gateway effect reconciliation attempts must advance once' USING ERRCODE = '23514';
  END IF;
  IF NEW.record_version <> OLD.record_version + 1 OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'gateway effect version or time did not advance' USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER gateway_effects_guard BEFORE UPDATE OR DELETE ON "gateway_effects" FOR EACH ROW EXECUTE FUNCTION guard_gateway_effect_mutation();
--> statement-breakpoint
CREATE FUNCTION guard_execution_milestone_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'execution milestones cannot be deleted' USING ERRCODE = '55000';
  END IF;
  IF (NEW.organization_id, NEW.execution_id, NEW.name, NEW.command_id)
    IS DISTINCT FROM (OLD.organization_id, OLD.execution_id, OLD.name, OLD.command_id) THEN
    RAISE EXCEPTION 'execution milestone identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'resolved execution milestones are immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.status NOT IN ('completed', 'failed') THEN
    RAISE EXCEPTION 'execution milestone must resolve monotonically' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER execution_milestones_guard BEFORE UPDATE OR DELETE ON "execution_milestones" FOR EACH ROW EXECUTE FUNCTION guard_execution_milestone_mutation();

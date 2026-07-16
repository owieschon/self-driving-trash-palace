ALTER TYPE "public"."evidence_type" ADD VALUE 'operation_transport' BEFORE 'gateway_delivery';--> statement-breakpoint
ALTER TABLE "evidence" DROP CONSTRAINT "evidence_authority_shape";--> statement-breakpoint
ALTER TABLE "outbox_messages" DROP CONSTRAINT "outbox_messages_reference_payload_only";--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_operation_transport_shape" CHECK (
        "evidence"."type" <> 'operation_transport'
        OR (
          "evidence"."authority" = 'application'
          AND "evidence"."application_rule_id" = 'operation.application_response_lost'
          AND "evidence"."application_rule_version" = 1
          AND jsonb_typeof("evidence"."payload") = 'object'
          AND "evidence"."payload" ?& ARRAY['id', 'organizationId', 'missionId', 'palaceId', 'observedAt', 'type', 'operationId', 'attemptId', 'toolCallId', 'transport', 'status', 'operationCommitted', 'errorCode']::text[]
          AND "evidence"."payload" - ARRAY['id', 'organizationId', 'missionId', 'palaceId', 'observedAt', 'type', 'operationId', 'attemptId', 'toolCallId', 'transport', 'status', 'operationCommitted', 'errorCode']::text[] = '{}'::jsonb
          AND "evidence"."payload" ->> 'operationId' ~ '^op_[a-z0-9][a-z0-9_-]{7,63}$'
          AND "evidence"."payload" ->> 'attemptId' ~ '^att_[a-z0-9][a-z0-9_-]{7,63}$'
          AND "evidence"."payload" ->> 'toolCallId' ~ '^call_[a-z0-9][a-z0-9_-]{7,63}$'
          AND "evidence"."payload" ->> 'transport' = 'worker'
          AND "evidence"."payload" ->> 'status' = 'unknown'
          AND "evidence"."payload" -> 'operationCommitted' = 'true'::jsonb
          AND "evidence"."payload" ->> 'errorCode' = 'APPLICATION_RESPONSE_LOST'
          AND "evidence"."authority_receipt" ->> 'schemaVersion' = 'evidence-authority-receipt@1'
          AND "evidence"."authority_receipt" ->> 'producer' = 'application_code'
          AND "evidence"."authority_receipt" ->> 'ruleId' = 'operation.application_response_lost'
          AND ("evidence"."authority_receipt" ->> 'ruleVersion')::integer = 1
          AND "evidence"."authority_receipt" -> 'inputEvidenceIds' = '[]'::jsonb
          AND "evidence"."authority_receipt" -> 'derivationVerified' = 'true'::jsonb
        )
      );--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_authority_shape" CHECK (
        ("evidence"."authority" = 'identity_telemetry' AND "evidence"."type" = 'identity_arrival' AND "evidence"."authority_provider_event_id" IS NOT NULL AND "evidence"."authority_callback_id" IS NULL AND "evidence"."authority_command_id" IS NULL AND "evidence"."application_rule_id" IS NULL AND "evidence"."application_rule_version" IS NULL)
        OR ("evidence"."authority" = 'gateway_callback' AND "evidence"."type" IN ('device_command', 'temperature_observation', 'lighting_observation', 'lock_observation', 'gateway_delivery') AND "evidence"."authority_provider_event_id" IS NULL AND "evidence"."authority_callback_id" IS NOT NULL AND "evidence"."authority_command_id" IS NOT NULL AND "evidence"."application_rule_id" IS NULL AND "evidence"."application_rule_version" IS NULL)
        OR ("evidence"."authority" = 'application' AND "evidence"."type" IN ('battery_projection', 'routine_state', 'tenant_access_audit', 'operation_transport', 'tool_invocation_reconciliation') AND "evidence"."authority_provider_event_id" IS NULL AND "evidence"."authority_callback_id" IS NULL AND "evidence"."authority_command_id" IS NULL AND "evidence"."application_rule_id" IS NOT NULL AND "evidence"."application_rule_version" > 0)
      );--> statement-breakpoint
ALTER TABLE "outbox_messages" ADD CONSTRAINT "outbox_messages_reference_payload_only" CHECK (
        ("outbox_messages"."topic" IN ('gateway.dispatch', 'gateway.effect.reconcile') AND "outbox_messages"."payload" = jsonb_build_object('organizationId', "outbox_messages"."organization_id", 'operationId', "outbox_messages"."operation_id", 'commandId', "outbox_messages"."command_id", 'generation', "outbox_messages"."dispatch_generation"))
        OR ("outbox_messages"."topic" = 'execution.deadline' AND "outbox_messages"."payload" = jsonb_build_object('organizationId', "outbox_messages"."organization_id", 'missionId', "outbox_messages"."mission_id", 'operationId', "outbox_messages"."operation_id", 'executionId', "outbox_messages"."execution_id"))
        OR ("outbox_messages"."topic" = 'execution.identity-arrival' AND "outbox_messages"."payload" = jsonb_build_object('organizationId', "outbox_messages"."organization_id", 'missionId', "outbox_messages"."mission_id", 'operationId', "outbox_messages"."operation_id", 'executionId', "outbox_messages"."execution_id", 'evidenceId', "outbox_messages"."payload" ->> 'evidenceId') AND "outbox_messages"."payload" ->> 'evidenceId' ~ '^evd_[a-z0-9][a-z0-9_-]{7,63}$')
        OR ("outbox_messages"."topic" IN ('mission.resume', 'mission.verify') AND "outbox_messages"."payload" = jsonb_build_object('organizationId', "outbox_messages"."organization_id", 'missionId', "outbox_messages"."mission_id"))
        OR ("outbox_messages"."topic" = 'operation.reconcile' AND "outbox_messages"."payload" = jsonb_build_object('organizationId', "outbox_messages"."organization_id", 'operationId', "outbox_messages"."operation_id", 'attemptId', "outbox_messages"."payload" ->> 'attemptId') AND "outbox_messages"."payload" ->> 'attemptId' ~ '^att_[a-z0-9][a-z0-9_-]{7,63}$')
      );--> statement-breakpoint
CREATE FUNCTION require_operation_transport_source_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.type = 'operation_transport' AND NOT EXISTS (
    SELECT 1
    FROM attempts attempt
    INNER JOIN operations operation
      ON operation.organization_id = attempt.organization_id
      AND operation.id = attempt.operation_id
    INNER JOIN missions mission
      ON mission.organization_id = operation.organization_id
      AND mission.id = operation.mission_id
    WHERE attempt.organization_id = NEW.organization_id
      AND attempt.id = NEW.payload ->> 'attemptId'
      AND attempt.operation_id = NEW.payload ->> 'operationId'
      AND attempt.transport = 'worker'
      AND attempt.status = 'unknown'
      AND attempt.error_code = 'APPLICATION_RESPONSE_LOST'
      AND attempt.completed_at IS NOT NULL
      AND operation.status = 'committed'
      AND operation.committed_at IS NOT NULL
      AND operation.mission_id = NEW.mission_id
      AND mission.palace_id = NEW.palace_id
      AND operation.committed_at <= NEW.observed_at
      AND attempt.completed_at <= NEW.observed_at
  ) THEN
    RAISE EXCEPTION 'operation transport evidence requires its tenant-bound committed operation attempt'
      USING ERRCODE = '23514', CONSTRAINT = 'evidence_operation_transport_source_binding';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER evidence_operation_transport_source_binding
BEFORE INSERT ON "evidence"
FOR EACH ROW EXECUTE FUNCTION require_operation_transport_source_binding();--> statement-breakpoint
CREATE FUNCTION require_application_response_lost_invocation_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  linked_count integer;
  matching_count integer;
  has_transport_evidence boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM tool_invocation_evidence link
    INNER JOIN evidence item
      ON item.organization_id = link.organization_id
      AND item.id = link.evidence_id
    WHERE link.organization_id = NEW.organization_id
      AND link.call_id = NEW.call_id
      AND item.type = 'operation_transport'
  ) INTO has_transport_evidence;

  IF NEW.status = 'completed'
    AND (
      (NEW.tool_name = 'plans.activate' AND NEW.result ->> 'status' = 'unknown' AND NEW.attempt_id IS NOT NULL)
      OR NEW.result #>> '{error,code}' = 'APPLICATION_RESPONSE_LOST'
      OR has_transport_evidence
    ) THEN
    SELECT count(*) INTO linked_count
    FROM tool_invocation_evidence link
    WHERE link.organization_id = NEW.organization_id
      AND link.call_id = NEW.call_id;

    SELECT count(*) INTO matching_count
    FROM tool_invocation_evidence link
    INNER JOIN evidence item
      ON item.organization_id = link.organization_id
      AND item.id = link.evidence_id
    INNER JOIN attempts attempt
      ON attempt.organization_id = NEW.organization_id
      AND attempt.id = NEW.attempt_id
      AND attempt.id = item.payload ->> 'attemptId'
      AND attempt.operation_id = item.payload ->> 'operationId'
    INNER JOIN operations operation
      ON operation.organization_id = attempt.organization_id
      AND operation.id = attempt.operation_id
      AND operation.mission_id = NEW.mission_id
    WHERE link.organization_id = NEW.organization_id
      AND link.call_id = NEW.call_id
      AND item.mission_id = NEW.mission_id
      AND item.type = 'operation_transport'
      AND item.authority = 'application'
      AND item.application_rule_id = 'operation.application_response_lost'
      AND item.application_rule_version = 1
      AND item.payload ->> 'toolCallId' = NEW.call_id
      AND attempt.transport = 'worker'
      AND attempt.status = 'unknown'
      AND attempt.error_code = 'APPLICATION_RESPONSE_LOST'
      AND attempt.completed_at IS NOT NULL
      AND operation.status = 'committed'
      AND operation.committed_at IS NOT NULL
      AND operation.committed_at <= item.observed_at
      AND attempt.completed_at <= item.observed_at;

    IF NEW.tool_name <> 'plans.activate'
      OR NEW.result ->> 'status' <> 'unknown'
      OR NEW.result #>> '{error,code}' IS DISTINCT FROM 'APPLICATION_RESPONSE_LOST'
      OR NEW.attempt_id IS NULL
      OR linked_count <> 1
      OR matching_count <> 1 THEN
      RAISE EXCEPTION 'unknown plans.activate requires one exact application response-loss evidence record'
        USING ERRCODE = '23514', CONSTRAINT = 'tool_invocations_application_response_lost_evidence';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER tool_invocations_application_response_lost_evidence
AFTER INSERT OR UPDATE ON "tool_invocations"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION require_application_response_lost_invocation_evidence();--> statement-breakpoint
CREATE FUNCTION require_application_response_lost_receipt_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  receipt_linked_count integer;
  invocation_linked_count integer;
  matching_count integer;
  has_transport_evidence boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM tool_call_receipt_evidence receipt_link
    INNER JOIN evidence item
      ON item.organization_id = receipt_link.organization_id
      AND item.id = receipt_link.evidence_id
    WHERE receipt_link.organization_id = NEW.organization_id
      AND receipt_link.receipt_id = NEW.id
      AND item.type = 'operation_transport'
  ) INTO has_transport_evidence;

  IF (NEW.tool_name = 'plans.activate' AND NEW.status = 'unknown' AND NEW.attempt_id IS NOT NULL)
    OR has_transport_evidence THEN
    SELECT count(*) INTO receipt_linked_count
    FROM tool_call_receipt_evidence link
    WHERE link.organization_id = NEW.organization_id
      AND link.receipt_id = NEW.id;

    SELECT count(*) INTO invocation_linked_count
    FROM tool_invocation_evidence link
    WHERE link.organization_id = NEW.organization_id
      AND link.call_id = NEW.call_id;

    SELECT count(*) INTO matching_count
    FROM tool_invocations invocation
    INNER JOIN tool_invocation_evidence invocation_link
      ON invocation_link.organization_id = invocation.organization_id
      AND invocation_link.call_id = invocation.call_id
    INNER JOIN tool_call_receipt_evidence receipt_link
      ON receipt_link.organization_id = NEW.organization_id
      AND receipt_link.receipt_id = NEW.id
      AND receipt_link.evidence_id = invocation_link.evidence_id
      AND receipt_link.position = invocation_link.position
    INNER JOIN evidence item
      ON item.organization_id = invocation_link.organization_id
      AND item.id = invocation_link.evidence_id
    WHERE invocation.organization_id = NEW.organization_id
      AND invocation.call_id = NEW.call_id
      AND invocation.receipt_id = NEW.id
      AND invocation.status = 'completed'
      AND invocation.tool_name = NEW.tool_name
      AND invocation.channel = NEW.channel
      AND invocation.input_hash = NEW.input_hash
      AND invocation.result_hash = NEW.result_hash
      AND invocation.tool_contract_hash = NEW.tool_contract_hash
      AND invocation.tool_registry_hash = NEW.tool_registry_hash
      AND invocation.attempt_id = NEW.attempt_id
      AND invocation.result ->> 'status' = NEW.status
      AND invocation.result #>> '{error,code}' = 'APPLICATION_RESPONSE_LOST'
      AND item.type = 'operation_transport'
      AND item.payload ->> 'toolCallId' = NEW.call_id
      AND item.payload ->> 'attemptId' = NEW.attempt_id;

    IF NEW.tool_name <> 'plans.activate'
      OR NEW.status <> 'unknown'
      OR NEW.attempt_id IS NULL
      OR receipt_linked_count <> 1
      OR invocation_linked_count <> 1
      OR matching_count <> 1 THEN
      RAISE EXCEPTION 'unknown plans.activate receipt requires its exact invocation transport evidence'
        USING ERRCODE = '23514', CONSTRAINT = 'tool_call_receipts_application_response_lost_evidence';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER tool_call_receipts_application_response_lost_evidence
AFTER INSERT ON "tool_call_receipts"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION require_application_response_lost_receipt_evidence();

ALTER TABLE "tool_invocations" DROP CONSTRAINT "tool_invocations_hashes_valid";--> statement-breakpoint
ALTER TABLE "tool_invocations" ADD COLUMN "binding_hash" char(64) NOT NULL;--> statement-breakpoint
ALTER TABLE "tool_invocations" ADD CONSTRAINT "tool_invocations_hashes_valid" CHECK ("tool_invocations"."input_hash" ~ '^[a-f0-9]{64}$' AND "tool_invocations"."principal_scope_hash" ~ '^[a-f0-9]{64}$' AND "tool_invocations"."tool_contract_hash" ~ '^[a-f0-9]{64}$' AND "tool_invocations"."tool_registry_hash" ~ '^[a-f0-9]{64}$' AND "tool_invocations"."result_schema_hash" ~ '^[a-f0-9]{64}$' AND "tool_invocations"."binding_hash" ~ '^[a-f0-9]{64}$' AND "tool_invocations"."owner_token_hash" ~ '^[a-f0-9]{64}$' AND ("tool_invocations"."result_hash" IS NULL OR "tool_invocations"."result_hash" ~ '^[a-f0-9]{64}$'));--> statement-breakpoint
CREATE OR REPLACE FUNCTION enforce_tool_invocation_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'tool invocation records cannot be deleted';
  END IF;

  IF OLD.organization_id IS DISTINCT FROM NEW.organization_id
    OR OLD.mission_id IS DISTINCT FROM NEW.mission_id
    OR OLD.call_id IS DISTINCT FROM NEW.call_id
    OR OLD.tool_name IS DISTINCT FROM NEW.tool_name
    OR OLD.channel IS DISTINCT FROM NEW.channel
    OR OLD.input_hash IS DISTINCT FROM NEW.input_hash
    OR OLD.principal_scope_hash IS DISTINCT FROM NEW.principal_scope_hash
    OR OLD.tool_contract_hash IS DISTINCT FROM NEW.tool_contract_hash
    OR OLD.tool_registry_hash IS DISTINCT FROM NEW.tool_registry_hash
    OR OLD.result_schema_hash IS DISTINCT FROM NEW.result_schema_hash
    OR OLD.binding_hash IS DISTINCT FROM NEW.binding_hash
    OR OLD.execution_class IS DISTINCT FROM NEW.execution_class
    OR OLD.receipt_id IS DISTINCT FROM NEW.receipt_id
    OR OLD.started_at IS DISTINCT FROM NEW.started_at THEN
    RAISE EXCEPTION 'tool invocation immutable binding cannot change';
  END IF;

  IF OLD.status = 'completed' THEN
    RAISE EXCEPTION 'completed tool invocation is immutable';
  END IF;

  IF NEW.status = 'claimed' THEN
    IF NEW.generation <> OLD.generation + 1
      OR OLD.claim_expires_at > NEW.updated_at
      OR NEW.claim_expires_at <= NEW.updated_at
      OR NEW.claim_expires_at > NEW.updated_at + interval '5 minutes'
      OR NEW.disposition <> (CASE WHEN OLD.execution_class = 'read' THEN 'execute'::tool_invocation_disposition ELSE 'resolve_unknown'::tool_invocation_disposition END) THEN
      RAISE EXCEPTION 'invalid tool invocation claim takeover';
    END IF;
  ELSIF NEW.status = 'completed' THEN
    IF NEW.generation <> OLD.generation
      OR NEW.owner_token_hash IS DISTINCT FROM OLD.owner_token_hash
      OR NEW.claim_expires_at IS DISTINCT FROM OLD.claim_expires_at
      OR NEW.disposition IS DISTINCT FROM OLD.disposition
      OR NEW.completed_at < OLD.updated_at THEN
      RAISE EXCEPTION 'invalid tool invocation completion';
    END IF;
  ELSE
    RAISE EXCEPTION 'invalid tool invocation transition';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION require_tool_invocation_reconciliation_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  linked_count integer;
  matching_count integer;
BEGIN
  IF NEW.status = 'completed' AND NEW.disposition = 'resolve_unknown' THEN
    SELECT count(*) INTO linked_count
    FROM tool_invocation_evidence link
    WHERE link.organization_id = NEW.organization_id AND link.call_id = NEW.call_id;

    SELECT count(*) INTO matching_count
    FROM tool_invocation_evidence link
    INNER JOIN evidence item
      ON item.organization_id = link.organization_id
      AND item.id = link.evidence_id
      AND item.mission_id = NEW.mission_id
    WHERE link.organization_id = NEW.organization_id
      AND link.call_id = NEW.call_id
      AND item.type = 'tool_invocation_reconciliation'
      AND item.application_rule_id = 'tool_invocation.abandoned_write'
      AND item.application_rule_version = 1
      AND item.payload ->> 'toolCallId' = NEW.call_id
      AND item.payload ->> 'toolName' = NEW.tool_name
      AND item.payload ->> 'invocationBindingHash' = NEW.binding_hash
      AND (item.payload ->> 'abandonedClaimGeneration')::integer = NEW.generation - 1
      AND (item.payload ->> 'claimExpiredAt')::timestamptz <= NEW.updated_at
      AND item.payload ->> 'source' = 'tool_invocation_ledger'
      AND item.payload ->> 'observer' = 'application_code'
      AND item.payload ->> 'durableObservation' = 'expired_claim_without_terminal_result'
      AND item.payload ->> 'reconciledOutcome' = 'still_unknown';

    IF linked_count <> 1 OR matching_count <> 1 THEN
      RAISE EXCEPTION 'resolved unknown tool invocation requires one exact reconciliation observation';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

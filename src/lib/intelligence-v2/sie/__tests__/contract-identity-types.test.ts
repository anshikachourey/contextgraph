/**
 * SIE Identity Resolution Contract Tests
 *
 * Validates that the generated TypeScript types for identity resolution
 * correctly reflect the Python OpenAPI contract, including:
 * - New identity resolution record with stage statuses and confidences
 * - IRS signals and retrieval attempt records
 * - Candidate records with contributing attempt IDs
 * - Processing mode and resolution action enums
 * - GraphStateContext extended fields (snapshot_token, snapshot_digest, etc.)
 * - Backward compatibility with existing code referencing these types
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import type { components } from "../generated/transport-types";

// Type aliases for identity resolution types
type IdentityResolutionResult = components["schemas"]["IdentityResolutionResult"];
type IdentityResolutionRecord = components["schemas"]["IdentityResolutionRecord"];
type CandidateRecord = components["schemas"]["CandidateRecord"];
type RetrievalAttemptRecord = components["schemas"]["RetrievalAttemptRecord"];
type IRSSignal = components["schemas"]["IRSSignal"];
type EvidenceReference = components["schemas"]["EvidenceReference"];
type GraphStateContext = components["schemas"]["GraphStateContext"];
type ProcessRequest = components["schemas"]["ProcessRequest"];
type ProcessResult = components["schemas"]["ProcessResult"];

const OPENAPI_PATH = resolve(
  __dirname,
  "../../../../../ml-service/contracts/sie-openapi.json"
);

function loadOpenAPISpec(): Record<string, unknown> {
  const content = readFileSync(OPENAPI_PATH, "utf-8");
  return JSON.parse(content);
}

function getSchemas(spec: Record<string, unknown>): Record<string, unknown> {
  const components = spec.components as Record<string, unknown>;
  return components.schemas as Record<string, unknown>;
}

describe("SIE Identity Resolution Contract Types", () => {
  const spec = loadOpenAPISpec();
  const schemas = getSchemas(spec);

  describe("New identity resolution enums present in OpenAPI", () => {
    it("ResolutionAction enum has correct values", () => {
      const schema = schemas.ResolutionAction as Record<string, unknown>;
      expect(schema).toBeDefined();
      expect(schema.enum).toEqual([
        "ASSIGN_EXISTING",
        "PROPOSE_NEW",
        "RETAIN_PENDING",
        "NONE",
      ]);
    });

    it("IRSSignalType enum has correct values", () => {
      const schema = schemas.IRSSignalType as Record<string, unknown>;
      expect(schema).toBeDefined();
      expect(schema.enum).toEqual([
        "REVISIT_LANGUAGE",
        "HISTORICAL_REFERENT",
        "IMPLIED_PRIOR_STATE",
        "BROAD_CANDIDATE_MISMATCH",
        "ALIAS_OR_VOCABULARY_DRIFT",
        "CONTINUATION_HISTORY_MISMATCH",
      ]);
    });

    it("RetrievalAttemptStatus enum has correct values", () => {
      const schema = schemas.RetrievalAttemptStatus as Record<string, unknown>;
      expect(schema).toBeDefined();
      expect(schema.enum).toEqual([
        "SUCCESS_WITH_CANDIDATES",
        "SUCCESS_EMPTY",
        "ERROR",
        "TIMEOUT",
        "UNAVAILABLE",
        "SKIPPED_WITH_REASON",
      ]);
    });

    it("StageExecutionStatus enum has correct values", () => {
      const schema = schemas.StageExecutionStatus as Record<string, unknown>;
      expect(schema).toBeDefined();
      expect(schema.enum).toEqual(["COMPLETED", "NOT_RUN", "FAILED"]);
    });

    it("ProcessingMode enum has correct values", () => {
      const schema = schemas.ProcessingMode as Record<string, unknown>;
      expect(schema).toBeDefined();
      expect(schema.enum).toEqual([
        "FULL_PIPELINE",
        "IDENTITY_RESOLUTION_ONLY",
        "PENDING_RE_EVALUATION",
      ]);
    });
  });

  describe("IdentityResolutionResult schema structure", () => {
    it("has identity_stage_status and sufficiency_stage_status fields", () => {
      const schema = schemas.IdentityResolutionResult as Record<string, unknown>;
      const properties = schema.properties as Record<string, unknown>;
      expect(properties).toHaveProperty("identity_stage_status");
      expect(properties).toHaveProperty("sufficiency_stage_status");
      expect(properties).toHaveProperty("identity_confidence");
      expect(properties).toHaveProperty("sufficiency_confidence");
      expect(properties).toHaveProperty("action");
    });

    it("does NOT have the old 'confidence' field", () => {
      const schema = schemas.IdentityResolutionResult as Record<string, unknown>;
      const properties = schema.properties as Record<string, unknown>;
      expect(properties).not.toHaveProperty("confidence");
    });

    it("identity_confidence is nullable", () => {
      const schema = schemas.IdentityResolutionResult as Record<string, unknown>;
      const properties = schema.properties as Record<string, unknown>;
      const field = properties.identity_confidence as Record<string, unknown>;
      expect(field.anyOf).toBeDefined();
      const anyOf = field.anyOf as Array<Record<string, unknown>>;
      const hasNull = anyOf.some((t) => t.type === "null");
      expect(hasNull).toBe(true);
    });

    it("sufficiency_confidence is nullable", () => {
      const schema = schemas.IdentityResolutionResult as Record<string, unknown>;
      const properties = schema.properties as Record<string, unknown>;
      const field = properties.sufficiency_confidence as Record<string, unknown>;
      expect(field.anyOf).toBeDefined();
      const anyOf = field.anyOf as Array<Record<string, unknown>>;
      const hasNull = anyOf.some((t) => t.type === "null");
      expect(hasNull).toBe(true);
    });

    it("action references ResolutionAction", () => {
      const schema = schemas.IdentityResolutionResult as Record<string, unknown>;
      const properties = schema.properties as Record<string, unknown>;
      const field = properties.action as Record<string, unknown>;
      expect(field.$ref).toBe("#/components/schemas/ResolutionAction");
    });
  });

  describe("IdentityResolutionRecord schema structure", () => {
    it("schema exists with all required identity fields", () => {
      const schema = schemas.IdentityResolutionRecord as Record<string, unknown>;
      expect(schema).toBeDefined();
      const properties = schema.properties as Record<string, unknown>;
      expect(properties).toHaveProperty("record_id");
      expect(properties).toHaveProperty("request_id");
      expect(properties).toHaveProperty("packet_id");
      expect(properties).toHaveProperty("graph_version_analyzed");
      expect(properties).toHaveProperty("graph_snapshot_token");
      expect(properties).toHaveProperty("outcome");
      expect(properties).toHaveProperty("action");
      expect(properties).toHaveProperty("identity_stage_status");
      expect(properties).toHaveProperty("identity_confidence");
      expect(properties).toHaveProperty("sufficiency_stage_status");
      expect(properties).toHaveProperty("sufficiency_confidence");
      expect(properties).toHaveProperty("matched_concern_id");
      expect(properties).toHaveProperty("proposed_concern_id");
      expect(properties).toHaveProperty("candidates_considered");
      expect(properties).toHaveProperty("irs_signals");
      expect(properties).toHaveProperty("retrieval_attempts");
      expect(properties).toHaveProperty("evidence_references");
      expect(properties).toHaveProperty("reasoning");
      expect(properties).toHaveProperty("semantic_policy_version");
      expect(properties).toHaveProperty("retrieval_policy_version");
      expect(properties).toHaveProperty("model_config_version");
      expect(properties).toHaveProperty("prompt_version");
    });
  });

  describe("CandidateRecord schema structure", () => {
    it("uses contributing_attempt_ids (not contributing_channels)", () => {
      const schema = schemas.CandidateRecord as Record<string, unknown>;
      const properties = schema.properties as Record<string, unknown>;
      expect(properties).toHaveProperty("contributing_attempt_ids");
      expect(properties).not.toHaveProperty("contributing_channels");
    });

    it("uses confidence (not confidence_band)", () => {
      const schema = schemas.CandidateRecord as Record<string, unknown>;
      const properties = schema.properties as Record<string, unknown>;
      expect(properties).toHaveProperty("confidence");
      expect(properties).not.toHaveProperty("confidence_band");
    });
  });

  describe("RetrievalAttemptRecord schema structure", () => {
    it("has required query fields", () => {
      const schema = schemas.RetrievalAttemptRecord as Record<string, unknown>;
      const required = schema.required as string[];
      expect(required).toContain("query_mode");
      expect(required).toContain("query_reference");
      expect(required).toContain("scope_description");
    });

    it("has candidate_ids and candidate_count", () => {
      const schema = schemas.RetrievalAttemptRecord as Record<string, unknown>;
      const properties = schema.properties as Record<string, unknown>;
      expect(properties).toHaveProperty("candidate_ids");
      expect(properties).toHaveProperty("candidate_count");
    });
  });

  describe("GraphStateContext extended fields", () => {
    it("requires snapshot_token and snapshot_digest", () => {
      const schema = schemas.GraphStateContext as Record<string, unknown>;
      const required = schema.required as string[];
      expect(required).toContain("snapshot_token");
      expect(required).toContain("snapshot_digest");
    });

    it("has identity-resolution-specific context fields", () => {
      const schema = schemas.GraphStateContext as Record<string, unknown>;
      const properties = schema.properties as Record<string, unknown>;
      expect(properties).toHaveProperty("concern_embeddings");
      expect(properties).toHaveProperty("normalized_aliases");
      expect(properties).toHaveProperty("pending_identity_details");
      expect(properties).toHaveProperty("privacy_suppressed_concern_ids");
      expect(properties).toHaveProperty("packet_lineage");
    });
  });

  describe("ProcessRequest extended fields", () => {
    it("has processing_mode, semantic_policy_version, retrieval_policy_version fields", () => {
      const schema = schemas.ProcessRequest as Record<string, unknown>;
      const properties = schema.properties as Record<string, unknown>;
      expect(properties).toHaveProperty("processing_mode");
      // semantic_policy_version and retrieval_policy_version are required
      const required = schema.required as string[];
      expect(required).toContain("semantic_policy_version");
      expect(required).toContain("retrieval_policy_version");
    });

    it("has re-evaluation fields for PENDING_RE_EVALUATION mode", () => {
      const schema = schemas.ProcessRequest as Record<string, unknown>;
      const properties = schema.properties as Record<string, unknown>;
      expect(properties).toHaveProperty("re_evaluation_trigger");
      expect(properties).toHaveProperty("targeted_decision_ids");
    });
  });

  describe("ProcessResult extended fields", () => {
    it("has identity_resolution_records field", () => {
      const schema = schemas.ProcessResult as Record<string, unknown>;
      const properties = schema.properties as Record<string, unknown>;
      expect(properties).toHaveProperty("identity_resolution_records");
    });

    it("has identity_mutations and identity_dependency_groups", () => {
      const schema = schemas.ProcessResult as Record<string, unknown>;
      const properties = schema.properties as Record<string, unknown>;
      expect(properties).toHaveProperty("identity_mutations");
      expect(properties).toHaveProperty("identity_dependency_groups");
    });
  });

  describe("TypeScript type round-trip for identity resolution", () => {
    it("IdentityResolutionResult with YES/ASSIGN_EXISTING round-trips", () => {
      const result: IdentityResolutionResult = {
        packet_id: "pkt-001",
        outcome: "YES",
        action: "ASSIGN_EXISTING",
        identity_stage_status: "COMPLETED",
        identity_confidence: "HIGH",
        sufficiency_stage_status: "NOT_RUN",
        matched_concern_id: "concern-001",
        new_concern_proposal: null,
        candidates_considered: ["concern-001", "concern-002"],
        rationale: "Exact concern continuity confirmed",
      };

      const roundTripped = JSON.parse(
        JSON.stringify(result)
      ) as IdentityResolutionResult;
      expect(roundTripped).toEqual(result);
    });

    it("IdentityResolutionResult with NO/PROPOSE_NEW round-trips", () => {
      const result: IdentityResolutionResult = {
        packet_id: "pkt-002",
        outcome: "NO",
        action: "PROPOSE_NEW",
        identity_stage_status: "COMPLETED",
        identity_confidence: "LOW",
        sufficiency_stage_status: "COMPLETED",
        sufficiency_confidence: "HIGH",
        matched_concern_id: null,
        new_concern_proposal: {
          proposed_concern_id: "concern-new-001",
          concern_creation_key: "conv:req:concern-new",
          display_title: "New User Concern",
          identity_summary: "User wants to learn Rust",
          initial_summary: "Learning Rust programming language",
          parent_resolution_state: "PARENT_DEFERRED",
        },
        candidates_considered: [],
        rationale: "No existing concern matches; novel concern confirmed",
      };

      const roundTripped = JSON.parse(
        JSON.stringify(result)
      ) as IdentityResolutionResult;
      expect(roundTripped).toEqual(result);
    });

    it("IdentityResolutionResult with UNRESOLVED/RETAIN_PENDING round-trips", () => {
      const result: IdentityResolutionResult = {
        packet_id: "pkt-003",
        outcome: "UNRESOLVED",
        action: "RETAIN_PENDING",
        identity_stage_status: "COMPLETED",
        identity_confidence: "MEDIUM",
        sufficiency_stage_status: "NOT_RUN",
        matched_concern_id: null,
        new_concern_proposal: null,
        candidates_considered: ["concern-a", "concern-b"],
        rationale: "Two candidates remain competitive",
      };

      const roundTripped = JSON.parse(
        JSON.stringify(result)
      ) as IdentityResolutionResult;
      expect(roundTripped).toEqual(result);
    });

    it("IdentityResolutionResult with null confidence (NOT_RUN stage) round-trips", () => {
      const result: IdentityResolutionResult = {
        packet_id: "pkt-004",
        outcome: "DEFER",
        action: "RETAIN_PENDING",
        identity_stage_status: "FAILED",
        identity_confidence: null,
        sufficiency_stage_status: "NOT_RUN",
        sufficiency_confidence: null,
        matched_concern_id: null,
        new_concern_proposal: null,
        candidates_considered: [],
        rationale: "Model failure during evaluation",
      };

      const roundTripped = JSON.parse(
        JSON.stringify(result)
      ) as IdentityResolutionResult;
      expect(roundTripped.identity_confidence).toBeNull();
      expect(roundTripped.sufficiency_confidence).toBeNull();
      expect(roundTripped.identity_stage_status).toBe("FAILED");
    });

    it("CandidateRecord with contributing_attempt_ids round-trips", () => {
      const candidate: CandidateRecord = {
        concern_id: "concern-001",
        lifecycle_status: "ACTIVE",
        contributing_attempt_ids: ["att-001", "att-003"],
        channel_local_diagnostics: [
          {
            channel_id: "embedding_primary",
            metric_name: "cosine_similarity",
            metric_value: 0.87,
          },
        ],
        identity_evidence: [
          {
            entity_id: "prop-001",
            entity_type: "proposition",
            description: "Same relocation intent",
          },
        ],
        contrary_evidence: [],
        confidence: "HIGH",
        explanation: "Strong identity continuity with existing concern",
      };

      const roundTripped = JSON.parse(
        JSON.stringify(candidate)
      ) as CandidateRecord;
      expect(roundTripped).toEqual(candidate);
      expect(roundTripped.contributing_attempt_ids).toEqual([
        "att-001",
        "att-003",
      ]);
    });

    it("RetrievalAttemptRecord round-trips with all fields", () => {
      const attempt: RetrievalAttemptRecord = {
        attempt_id: "att-001",
        channel_id: "embedding_primary",
        channel_family: "embedding",
        query_mode: "broad",
        query_reference: "qref-sha256-abc",
        scope_description: "All ACTIVE concerns within conversation",
        status: "SUCCESS_WITH_CANDIDATES",
        candidate_ids: ["concern-001", "concern-002"],
        candidate_count: 2,
        latency_ms: 45,
        failure_reason: null,
        retrieval_policy_version: "1.0.0",
        triggered_by_signal: null,
      };

      const roundTripped = JSON.parse(
        JSON.stringify(attempt)
      ) as RetrievalAttemptRecord;
      expect(roundTripped).toEqual(attempt);
    });

    it("IRSSignal round-trips with evidence references", () => {
      const signal: IRSSignal = {
        signal_type: "ALIAS_OR_VOCABULARY_DRIFT",
        confidence: "HIGH",
        source_evidence: [
          {
            entity_id: "prop-ref-001",
            entity_type: "proposition",
            description: "Uses 'moving' instead of 'relocating'",
          },
        ],
        explanation:
          "Packet uses different vocabulary for the same semantic concept",
        resolved: false,
        resolved_by_attempt_ids: [],
      };

      const roundTripped = JSON.parse(JSON.stringify(signal)) as IRSSignal;
      expect(roundTripped).toEqual(signal);
    });

    it("GraphStateContext with identity-resolution fields round-trips", () => {
      const ctx: GraphStateContext = {
        graph_version: 15,
        snapshot_token: "snap-15-xyz",
        snapshot_digest: "sha256-abc123",
        concerns: [],
        propositions: [],
        active_associations: [],
        pending_decisions: [],
        concern_embeddings: [
          {
            concern_id: "concern-001",
            embedding: [0.1, 0.2, 0.3],
            source_text_hash: "sha256-def",
            embedding_model_version: "text-embedding-3-small",
            graph_version: 15,
          },
        ],
        normalized_aliases: [
          {
            concern_id: "concern-001",
            alias_text: "moving to Mumbai",
            normalized_form: "moving to mumbai",
          },
        ],
        pending_identity_details: [
          {
            decision_id: "pid-001",
            packet_id: "pkt-old",
            outcome: "UNRESOLVED",
            proposition_ids: ["prop-001"],
            graph_version_analyzed: 12,
          },
        ],
        privacy_suppressed_concern_ids: ["concern-deleted-001"],
        packet_lineage: [
          {
            packet_id: "pkt-002",
            split_from_packet_id: "pkt-001",
            split_reason: "mixed_cohesion",
          },
        ],
      };

      const roundTripped = JSON.parse(
        JSON.stringify(ctx)
      ) as GraphStateContext;
      expect(roundTripped).toEqual(ctx);
      expect(roundTripped.snapshot_token).toBe("snap-15-xyz");
      expect(roundTripped.snapshot_digest).toBe("sha256-abc123");
      expect(roundTripped.concern_embeddings).toHaveLength(1);
      expect(roundTripped.normalized_aliases).toHaveLength(1);
      expect(roundTripped.pending_identity_details).toHaveLength(1);
      expect(roundTripped.privacy_suppressed_concern_ids).toEqual([
        "concern-deleted-001",
      ]);
    });
  });

  describe("Backward compatibility", () => {
    it("ProcessResult still has identity_resolutions array", () => {
      const schema = schemas.ProcessResult as Record<string, unknown>;
      const required = schema.required as string[];
      expect(required).toContain("identity_resolutions");
    });

    it("ProcessResult.identity_resolution_records is optional (backward compat)", () => {
      const schema = schemas.ProcessResult as Record<string, unknown>;
      const required = schema.required as string[];
      // identity_resolution_records should NOT be required to maintain backward compat
      expect(required).not.toContain("identity_resolution_records");
    });

    it("GraphStateContext extended fields are optional (backward compat)", () => {
      const schema = schemas.GraphStateContext as Record<string, unknown>;
      const required = schema.required as string[];
      // New identity-resolution fields should not be required for backward compat
      expect(required).not.toContain("concern_embeddings");
      expect(required).not.toContain("normalized_aliases");
      expect(required).not.toContain("pending_identity_details");
      expect(required).not.toContain("privacy_suppressed_concern_ids");
      expect(required).not.toContain("packet_lineage");
    });

    it("existing types from types.ts re-export correctly", async () => {
      // Import from types.ts to verify re-exports work
      const types = await import("../types");
      // These should be type-only exports, so we verify the module loads
      expect(types).toBeDefined();
    });
  });
});

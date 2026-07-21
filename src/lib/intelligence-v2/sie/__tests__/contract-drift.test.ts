/**
 * SIE Contract Drift Tests
 *
 * Validates that:
 * 1. The generated transport-types.ts is not stale vs the OpenAPI artifact.
 * 2. Key contract structures (enums, nullable fields, established_by_packet_id,
 *    pending decisions) are present and correctly defined in the OpenAPI JSON.
 * 3. Representative Python payload shapes match expected TypeScript contract structure.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, statSync } from "fs";
import { execSync } from "child_process";
import { resolve } from "path";

const OPENAPI_PATH = resolve(
  __dirname,
  "../../../../../ml-service/contracts/sie-openapi.json"
);
const TRANSPORT_TYPES_PATH = resolve(
  __dirname,
  "../generated/transport-types.ts"
);

function loadOpenAPISpec(): Record<string, unknown> {
  const content = readFileSync(OPENAPI_PATH, "utf-8");
  return JSON.parse(content);
}

function getSchemas(spec: Record<string, unknown>): Record<string, unknown> {
  const components = spec.components as Record<string, unknown>;
  return components.schemas as Record<string, unknown>;
}

describe("SIE Contract Drift Detection", () => {
  describe("Generated file freshness", () => {
    it("transport-types.ts file exists and is non-empty", () => {
      expect(existsSync(TRANSPORT_TYPES_PATH)).toBe(true);
      const stat = statSync(TRANSPORT_TYPES_PATH);
      expect(stat.size).toBeGreaterThan(0);
    });

    it("transport-types.ts is not stale vs OpenAPI artifact", () => {
      const currentContent = readFileSync(TRANSPORT_TYPES_PATH, "utf-8");
      const tmpOutput = resolve(__dirname, "../generated/.transport-types-check.ts");
      const cwd = resolve(__dirname, "../../../../..");

      try {
        execSync(
          `npx openapi-typescript ${OPENAPI_PATH} -o ${tmpOutput}`,
          { encoding: "utf-8", cwd }
        );
        const freshContent = readFileSync(tmpOutput, "utf-8");
        // Compare normalized content (trim trailing whitespace)
        expect(currentContent.trim()).toBe(freshContent.trim());
      } finally {
        // Clean up temp file
        try {
          const { unlinkSync } = require("fs");
          unlinkSync(tmpOutput);
        } catch {
          // ignore cleanup errors
        }
      }
    });
  });

  describe("OpenAPI schema structure verification", () => {
    const spec = loadOpenAPISpec();
    const schemas = getSchemas(spec);

    it("PropositionAssociation includes established_by_packet_id", () => {
      const assocSchema = schemas.PropositionAssociation as Record<
        string,
        unknown
      >;
      const properties = assocSchema.properties as Record<string, unknown>;
      expect(properties).toHaveProperty("established_by_packet_id");

      // Verify it's nullable (anyOf with string | null)
      const field = properties.established_by_packet_id as Record<
        string,
        unknown
      >;
      expect(field.anyOf).toBeDefined();
      const anyOf = field.anyOf as Array<Record<string, unknown>>;
      const types = anyOf.map((t) => t.type);
      expect(types).toContain("string");
      expect(types).toContain("null");
    });

    it("PendingDecisionSummary schema has required fields", () => {
      const schema = schemas.PendingDecisionSummary as Record<string, unknown>;
      expect(schema).toBeDefined();

      const properties = schema.properties as Record<string, unknown>;
      expect(properties).toHaveProperty("entity_id");
      expect(properties).toHaveProperty("stage");
      expect(properties).toHaveProperty("outcome");
      expect(properties).toHaveProperty("rationale");

      const required = schema.required as string[];
      expect(required).toContain("entity_id");
      expect(required).toContain("stage");
      expect(required).toContain("outcome");
    });

    it("GraphStateContext includes pending_decisions field", () => {
      const schema = schemas.GraphStateContext as Record<string, unknown>;
      const properties = schema.properties as Record<string, unknown>;
      expect(properties).toHaveProperty("pending_decisions");

      const field = properties.pending_decisions as Record<string, unknown>;
      const items = field.items as Record<string, unknown>;
      expect(items.$ref).toBe(
        "#/components/schemas/PendingDecisionSummary"
      );
    });

    describe("Enum values match expected lists", () => {
      it("AssociationRole enum", () => {
        const schema = schemas.AssociationRole as Record<string, unknown>;
        expect(schema.enum).toEqual([
          "PRIMARY_OWNER",
          "SUPPORTING_EVIDENCE",
          "EMERGENCE_EVIDENCE",
          "CONTEXT",
          "CROSS_OBJECT_IMPACT",
        ]);
      });

      it("RetentionLevel enum", () => {
        const schema = schemas.RetentionLevel as Record<string, unknown>;
        expect(schema.enum).toEqual([
          "DISCARD",
          "CONTEXT_ONLY",
          "SUPPORTING_EVIDENCE",
          "DURABLE_PROPOSITION",
          "EMERGENCE_EVIDENCE",
          "INDEPENDENT_CONCERN_CANDIDATE",
        ]);
      });

      it("PipelineOutcome enum", () => {
        const schema = schemas.PipelineOutcome as Record<string, unknown>;
        expect(schema.enum).toEqual([
          "YES",
          "NO",
          "UNRESOLVED",
          "DEFER",
          "RETRIEVAL_INCONCLUSIVE",
          "REQUIRES_VALIDATION",
        ]);
      });

      it("BehavioralConfidenceBand enum", () => {
        const schema = schemas.BehavioralConfidenceBand as Record<
          string,
          unknown
        >;
        expect(schema.enum).toEqual(["HIGH", "MEDIUM", "LOW"]);
      });

      it("CohesionStatus enum", () => {
        const schema = schemas.CohesionStatus as Record<string, unknown>;
        expect(schema.enum).toEqual([
          "COHESIVE",
          "MIXED",
          "UNRESOLVED_COHESION",
        ]);
      });

      it("ConcernStatus enum", () => {
        const schema = schemas.ConcernStatus as Record<string, unknown>;
        expect(schema.enum).toEqual(["ACTIVE", "DORMANT", "RETIRED", "MERGED"]);
      });

      it("ParentResolutionState enum", () => {
        const schema = schemas.ParentResolutionState as Record<string, unknown>;
        expect(schema.enum).toEqual([
          "ROOT_CONFIRMED",
          "PARENT_DEFERRED",
          "PARENT_ASSIGNED",
        ]);
      });

      it("SemanticState enum", () => {
        const schema = schemas.SemanticState as Record<string, unknown>;
        expect(schema.enum).toEqual([
          "ACTIVE",
          "SUPERSEDED",
          "RETRACTED",
          "INVALIDATED",
        ]);
      });

      it("PropositionType enum", () => {
        const schema = schemas.PropositionType as Record<string, unknown>;
        expect(schema.enum).toEqual([
          "QUESTION",
          "CLAIM",
          "PREFERENCE",
          "GOAL",
          "INTENT",
          "DECISION",
          "CONSTRAINT",
          "PLAN",
          "CORRECTION",
          "REJECTION",
          "UPDATE",
          "REQUEST",
          "EMOTIONAL_STATE",
          "EXAMPLE",
        ]);
      });

      it("PropositionProvenance enum", () => {
        const schema = schemas.PropositionProvenance as Record<string, unknown>;
        expect(schema.enum).toEqual([
          "DIRECT",
          "PARAPHRASE",
          "INTERPRETATION",
          "INFERENCE",
        ]);
      });
    });

    describe("Nullable fields are properly represented", () => {
      it("ConcernProposal.proposed_parent_id is nullable", () => {
        const schema = schemas.ConcernProposal as Record<string, unknown>;
        const properties = schema.properties as Record<string, unknown>;
        const field = properties.proposed_parent_id as Record<string, unknown>;
        expect(field.anyOf).toBeDefined();
        const types = (field.anyOf as Array<Record<string, unknown>>).map(
          (t) => t.type
        );
        expect(types).toContain("null");
      });

      it("IdentityResolutionResult.matched_concern_id is nullable", () => {
        const schema = schemas.IdentityResolutionResult as Record<
          string,
          unknown
        >;
        const properties = schema.properties as Record<string, unknown>;
        const field = properties.matched_concern_id as Record<string, unknown>;
        expect(field.anyOf).toBeDefined();
        const types = (field.anyOf as Array<Record<string, unknown>>).map(
          (t) => t.type
        );
        expect(types).toContain("null");
      });

      it("Proposition.supersedes_proposition_id is nullable", () => {
        const schema = schemas.Proposition as Record<string, unknown>;
        const properties = schema.properties as Record<string, unknown>;
        const field = properties.supersedes_proposition_id as Record<
          string,
          unknown
        >;
        expect(field.anyOf).toBeDefined();
        const types = (field.anyOf as Array<Record<string, unknown>>).map(
          (t) => t.type
        );
        expect(types).toContain("null");
      });

      it("PendingDecisionSummary.rationale is nullable", () => {
        const schema = schemas.PendingDecisionSummary as Record<
          string,
          unknown
        >;
        const properties = schema.properties as Record<string, unknown>;
        const field = properties.rationale as Record<string, unknown>;
        expect(field.anyOf).toBeDefined();
        const types = (field.anyOf as Array<Record<string, unknown>>).map(
          (t) => t.type
        );
        expect(types).toContain("null");
      });
    });

    describe("Sequence/tuple fields use correct array constraints", () => {
      it("Proposition.message_seq_range is a 2-tuple of integers", () => {
        const schema = schemas.Proposition as Record<string, unknown>;
        const properties = schema.properties as Record<string, unknown>;
        const field = properties.message_seq_range as Record<string, unknown>;
        expect(field.type).toBe("array");
        expect(field.minItems).toBe(2);
        expect(field.maxItems).toBe(2);
        const prefixItems = field.prefixItems as Array<Record<string, unknown>>;
        expect(prefixItems).toHaveLength(2);
        expect(prefixItems[0].type).toBe("integer");
        expect(prefixItems[1].type).toBe("integer");
      });

      it("PropositionSummary.message_seq_range is a 2-tuple of integers", () => {
        const schema = schemas.PropositionSummary as Record<string, unknown>;
        const properties = schema.properties as Record<string, unknown>;
        const field = properties.message_seq_range as Record<string, unknown>;
        expect(field.type).toBe("array");
        expect(field.minItems).toBe(2);
        expect(field.maxItems).toBe(2);
      });

      it("SemanticPacket.message_seq_range is a 2-tuple of integers", () => {
        const schema = schemas.SemanticPacket as Record<string, unknown>;
        const properties = schema.properties as Record<string, unknown>;
        const field = properties.message_seq_range as Record<string, unknown>;
        expect(field.type).toBe("array");
        expect(field.minItems).toBe(2);
        expect(field.maxItems).toBe(2);
      });
    });
  });

  describe("Representative Python payload structure validation", () => {
    const spec = loadOpenAPISpec();
    const schemas = getSchemas(spec);

    it("ProcessRequest schema has all required version/id fields", () => {
      const schema = schemas.ProcessRequest as Record<string, unknown>;
      const required = schema.required as string[];
      expect(required).toContain("api_contract_version");
      expect(required).toContain("pipeline_version");
      expect(required).toContain("model_version");
      expect(required).toContain("extraction_version");
      expect(required).toContain("request_id");
      expect(required).toContain("idempotency_key");
      expect(required).toContain("conversation_id");
      expect(required).toContain("base_graph_version");
      expect(required).toContain("message_seq_start");
      expect(required).toContain("message_seq_end");
      expect(required).toContain("messages");
      expect(required).toContain("current_graph_state");
    });

    it("ProcessResult schema has all semantic decision fields", () => {
      const schema = schemas.ProcessResult as Record<string, unknown>;
      const required = schema.required as string[];
      expect(required).toContain("retention_decisions");
      expect(required).toContain("propositions");
      expect(required).toContain("packets");
      expect(required).toContain("packet_memberships");
      expect(required).toContain("splits");
      expect(required).toContain("identity_resolutions");
      expect(required).toContain("new_concern_proposals");
      expect(required).toContain("proposed_associations");
      expect(required).toContain("diagnostics");
    });

    it("ProcessResult.proposed_associations references PropositionAssociation", () => {
      const schema = schemas.ProcessResult as Record<string, unknown>;
      const properties = schema.properties as Record<string, unknown>;
      const field = properties.proposed_associations as Record<string, unknown>;
      const items = field.items as Record<string, unknown>;
      expect(items.$ref).toBe(
        "#/components/schemas/PropositionAssociation"
      );
    });

    it("GraphStateContext schema requires graph_version and context arrays", () => {
      const schema = schemas.GraphStateContext as Record<string, unknown>;
      const required = schema.required as string[];
      expect(required).toContain("graph_version");
      expect(required).toContain("concerns");
      expect(required).toContain("propositions");
      expect(required).toContain("active_associations");
    });

    it("PropositionAssociation has creation-key and version fields", () => {
      const schema = schemas.PropositionAssociation as Record<string, unknown>;
      const required = schema.required as string[];
      expect(required).toContain("association_id");
      expect(required).toContain("association_creation_key");
      expect(required).toContain("proposition_id");
      expect(required).toContain("concern_id");
      expect(required).toContain("role");
      expect(required).toContain("confidence");
      expect(required).toContain("provenance");
      expect(required).toContain("created_at");

      // Version has a default so is not required but must be defined
      const properties = schema.properties as Record<string, unknown>;
      expect(properties).toHaveProperty("version");
      const versionProp = properties.version as Record<string, unknown>;
      expect(versionProp.default).toBe(1);
    });
  });
});

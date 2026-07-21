/**
 * SIE Contract Round-Trip Tests
 *
 * Verifies that representative payloads matching the SIE transport contract
 * survive JSON serialization/deserialization (round-trip) with all fields
 * preserved, including:
 * - Enum values
 * - Nullable fields (null and non-null)
 * - Tuple/sequence fields (message_seq_range)
 * - Creation keys and versions
 * - established_by_packet_id
 * - pending_decisions arrays
 */
import { describe, it, expect } from "vitest";
import type { components } from "../generated/transport-types";

// Type aliases for readability
type ProcessRequest = components["schemas"]["ProcessRequest"];
type ProcessResult = components["schemas"]["ProcessResult"];
type GraphStateContext = components["schemas"]["GraphStateContext"];
type PropositionAssociation = components["schemas"]["PropositionAssociation"];
type PendingDecisionSummary = components["schemas"]["PendingDecisionSummary"];
type RetentionDecision = components["schemas"]["RetentionDecision"];
type Proposition = components["schemas"]["Proposition"];
type SemanticPacket = components["schemas"]["SemanticPacket"];

describe("SIE Contract Round-Trip", () => {
  describe("ProcessRequest payload", () => {
    const sampleRequest: ProcessRequest = {
      api_contract_version: "1.1.0",
      pipeline_version: "0.1.0",
      model_version: "gpt-4o-2024-05-13",
      extraction_version: "0.1.0",
      request_id: "req-abc-123",
      idempotency_key: "conv-001:seq-5-10:pipe-0.1.0",
      conversation_id: "conv-001",
      base_graph_version: 7,
      message_seq_start: 5,
      message_seq_end: 10,
      messages: [
        {
          message_id: "msg-005",
          conversation_id: "conv-001",
          role: "USER",
          content: "I want to move to Mumbai for the Netflix offer.",
          sequence_position: 5,
          created_at: "2024-06-01T10:00:00Z",
          attachment_refs: [],
          structured_content: null,
        },
        {
          message_id: "msg-006",
          conversation_id: "conv-001",
          role: "ASSISTANT",
          content: "That sounds exciting! What aspects are you considering?",
          sequence_position: 6,
          created_at: "2024-06-01T10:01:00Z",
        },
      ],
      context_window: [],
      current_graph_state: {
        graph_version: 7,
        concerns: [
          {
            concern_id: "concern-relocation-001",
            identity_summary: "User considering relocation to Mumbai",
            display_title: "Mumbai Relocation",
            current_summary: "Active exploration of moving to Mumbai",
            status: "ACTIVE",
            aliases: ["moving to India", "Mumbai move"],
            canonical_parent_id: null,
            parent_resolution_state: "ROOT_CONFIRMED",
            last_active_at: "2024-05-30T12:00:00Z",
            semantic_version: 3,
          },
        ],
        propositions: [
          {
            proposition_id: "prop-prev-001",
            canonical_meaning: "User is exploring relocation options",
            proposition_type: "GOAL",
            speaker_role: "USER",
            semantic_state: "ACTIVE",
            message_seq_range: [3, 4],
          },
        ],
        active_associations: [
          {
            association_id: "assoc-prev-001",
            proposition_id: "prop-prev-001",
            concern_id: "concern-relocation-001",
            role: "PRIMARY_OWNER",
            semantic_state: "ACTIVE",
          },
        ],
        pending_decisions: [
          {
            entity_id: "prop-deferred-xyz",
            stage: "identity_resolution",
            outcome: "DEFER",
            rationale: "Insufficient context to resolve ownership",
          },
        ],
      },
    };

    it("round-trips through JSON serialization preserving all fields", () => {
      const roundTripped = JSON.parse(
        JSON.stringify(sampleRequest)
      ) as ProcessRequest;
      expect(roundTripped).toEqual(sampleRequest);
    });

    it("preserves graph_version matching base_graph_version", () => {
      const roundTripped = JSON.parse(
        JSON.stringify(sampleRequest)
      ) as ProcessRequest;
      expect(roundTripped.current_graph_state.graph_version).toBe(
        roundTripped.base_graph_version
      );
    });

    it("preserves message sequence range as tuple", () => {
      const roundTripped = JSON.parse(
        JSON.stringify(sampleRequest)
      ) as ProcessRequest;
      expect(roundTripped.message_seq_start).toBe(5);
      expect(roundTripped.message_seq_end).toBe(10);
    });

    it("preserves pending_decisions in graph state", () => {
      const roundTripped = JSON.parse(
        JSON.stringify(sampleRequest)
      ) as ProcessRequest;
      const decisions = roundTripped.current_graph_state.pending_decisions!;
      expect(decisions).toHaveLength(1);
      expect(decisions[0].entity_id).toBe("prop-deferred-xyz");
      expect(decisions[0].stage).toBe("identity_resolution");
      expect(decisions[0].outcome).toBe("DEFER");
      expect(decisions[0].rationale).toBe(
        "Insufficient context to resolve ownership"
      );
    });
  });

  describe("ProcessResult payload", () => {
    const sampleResult: ProcessResult = {
      api_contract_version: "1.1.0",
      pipeline_version: "0.1.0",
      model_version: "gpt-4o-2024-05-13",
      extraction_version: "0.1.0",
      request_id: "req-abc-123",
      idempotency_key: "conv-001:seq-5-10:pipe-0.1.0",
      conversation_id: "conv-001",
      base_graph_version: 7,
      lowest_seq: 5,
      highest_seq: 10,
      retention_decisions: [
        {
          decision_id: "dec-001",
          decision_creation_key: "conv-001:req-abc-123:msg-005:pos-0",
          conversation_id: "conv-001",
          primary_level: "DURABLE_PROPOSITION",
          secondary_roles: ["EMERGENCE_EVIDENCE"],
          confidence: "HIGH",
          outcome: "YES",
          source_message_ids: ["msg-005"],
          speaker_role: "USER",
          sequence_position: 5,
          extraction_version: "0.1.0",
          assessment_version: "0.1.0",
          rationale: "Expresses durable relocation intent",
        },
      ],
      propositions: [
        {
          proposition_id: "prop-new-001",
          proposition_creation_key: "conv-001:req-abc-123:extract-0",
          conversation_id: "conv-001",
          source_message_ids: ["msg-005"],
          speaker_role: "USER",
          canonical_meaning:
            "User wants to move to Mumbai for the Netflix offer",
          proposition_type: "GOAL",
          message_seq_range: [5, 5],
          provenance: "DIRECT",
          semantic_state: "ACTIVE",
          retention_levels: ["DURABLE_PROPOSITION", "EMERGENCE_EVIDENCE"],
          created_at: "2024-06-01T10:00:00Z",
          extraction_version: "0.1.0",
          supersedes_proposition_id: null,
        },
      ],
      packets: [
        {
          packet_id: "pkt-001",
          packet_creation_key: "conv-001:req-abc-123:partition-0",
          conversation_id: "conv-001",
          source_message_ids: ["msg-005"],
          message_seq_range: [5, 5],
          user_grounded_meaning:
            "User expresses intent to move to Mumbai for Netflix opportunity",
          assistant_context: null,
          continuation_origin: null,
          provenance: "extraction",
          packet_formation_version: "0.1.0",
          cohesion_status: "COHESIVE",
          provisional_boundaries: [],
        },
      ],
      packet_memberships: [
        {
          membership_id: "mem-001",
          membership_creation_key: "pkt-001:prop-new-001:ord-0",
          packet_id: "pkt-001",
          proposition_id: "prop-new-001",
          ordinal: 0,
          created_at: "2024-06-01T10:00:00Z",
        },
      ],
      splits: [],
      identity_resolutions: [
        {
          packet_id: "pkt-001",
          outcome: "YES",
          confidence: "HIGH",
          matched_concern_id: "concern-relocation-001",
          new_concern_proposal: null,
          candidates_considered: [
            "concern-relocation-001",
            "concern-career-002",
          ],
          rationale: "Packet clearly advances the existing Mumbai relocation concern",
        },
      ],
      new_concern_proposals: [],
      proposed_associations: [
        {
          association_id: "assoc-new-001",
          association_creation_key: "conv-001:req-abc-123:assoc-0",
          proposition_id: "prop-new-001",
          concern_id: "concern-relocation-001",
          role: "PRIMARY_OWNER",
          confidence: "HIGH",
          provenance: "identity_resolution",
          established_by_packet_id: "pkt-001",
          semantic_state: "ACTIVE",
          created_at: "2024-06-01T10:00:00Z",
          version: 1,
        },
      ],
      dependency_groups: [
        {
          group_id: "grp-001",
          mutation_refs: ["assoc-new-001", "prop-new-001"],
          failure_policy: "ALL_OR_NONE",
        },
      ],
      diagnostics: {
        stage_versions: {
          retention: "0.1.0",
          extraction: "0.1.0",
          packet_formation: "0.1.0",
          identity_resolution: "0.1.0",
        },
        warnings: [],
        deferred_entity_ids: [],
      },
    };

    it("round-trips through JSON serialization preserving all fields", () => {
      const roundTripped = JSON.parse(
        JSON.stringify(sampleResult)
      ) as ProcessResult;
      expect(roundTripped).toEqual(sampleResult);
    });

    it("preserves retention_decisions with enum values", () => {
      const roundTripped = JSON.parse(
        JSON.stringify(sampleResult)
      ) as ProcessResult;
      const dec = roundTripped.retention_decisions[0];
      expect(dec.primary_level).toBe("DURABLE_PROPOSITION");
      expect(dec.secondary_roles).toEqual(["EMERGENCE_EVIDENCE"]);
      expect(dec.confidence).toBe("HIGH");
      expect(dec.outcome).toBe("YES");
    });

    it("preserves propositions with tuple sequence ranges", () => {
      const roundTripped = JSON.parse(
        JSON.stringify(sampleResult)
      ) as ProcessResult;
      const prop = roundTripped.propositions[0];
      expect(prop.message_seq_range).toEqual([5, 5]);
      expect(prop.proposition_type).toBe("GOAL");
      expect(prop.provenance).toBe("DIRECT");
      expect(prop.semantic_state).toBe("ACTIVE");
    });

    it("preserves packets with cohesion status", () => {
      const roundTripped = JSON.parse(
        JSON.stringify(sampleResult)
      ) as ProcessResult;
      const pkt = roundTripped.packets[0];
      expect(pkt.cohesion_status).toBe("COHESIVE");
      expect(pkt.message_seq_range).toEqual([5, 5]);
      expect(pkt.packet_creation_key).toBe(
        "conv-001:req-abc-123:partition-0"
      );
    });

    it("preserves proposed_associations with established_by_packet_id", () => {
      const roundTripped = JSON.parse(
        JSON.stringify(sampleResult)
      ) as ProcessResult;
      const assoc = roundTripped.proposed_associations[0];
      expect(assoc.established_by_packet_id).toBe("pkt-001");
      expect(assoc.role).toBe("PRIMARY_OWNER");
      expect(assoc.version).toBe(1);
      expect(assoc.association_creation_key).toBe(
        "conv-001:req-abc-123:assoc-0"
      );
    });
  });

  describe("established_by_packet_id nullable behavior", () => {
    it("preserves null value for repair/migration associations", () => {
      const association: PropositionAssociation = {
        association_id: "assoc-repair-001",
        association_creation_key: "conv-001:repair:assoc-r1",
        proposition_id: "prop-001",
        concern_id: "concern-001",
        role: "SUPPORTING_EVIDENCE",
        confidence: "MEDIUM",
        provenance: "semantic_repair",
        established_by_packet_id: null,
        semantic_state: "ACTIVE",
        created_at: "2024-06-01T10:00:00Z",
        version: 1,
      };

      const roundTripped = JSON.parse(
        JSON.stringify(association)
      ) as PropositionAssociation;
      expect(roundTripped.established_by_packet_id).toBeNull();
    });

    it("preserves non-null value for packet-established associations", () => {
      const association: PropositionAssociation = {
        association_id: "assoc-pkt-001",
        association_creation_key: "conv-001:req-abc:assoc-p1",
        proposition_id: "prop-001",
        concern_id: "concern-001",
        role: "PRIMARY_OWNER",
        confidence: "HIGH",
        provenance: "identity_resolution",
        established_by_packet_id: "pkt-formation-123",
        semantic_state: "ACTIVE",
        created_at: "2024-06-01T10:00:00Z",
        version: 1,
      };

      const roundTripped = JSON.parse(
        JSON.stringify(association)
      ) as PropositionAssociation;
      expect(roundTripped.established_by_packet_id).toBe(
        "pkt-formation-123"
      );
    });
  });

  describe("pending_decisions round-trip with various outcomes", () => {
    const pendingDecisions: PendingDecisionSummary[] = [
      {
        entity_id: "prop-unresolved-001",
        stage: "identity_resolution",
        outcome: "UNRESOLVED",
        rationale: "No matching concern found with sufficient confidence",
      },
      {
        entity_id: "pkt-deferred-002",
        stage: "cohesion_analysis",
        outcome: "DEFER",
        rationale: null,
      },
      {
        entity_id: "assoc-pending-003",
        stage: "ownership_assignment",
        outcome: "REQUIRES_VALIDATION",
        rationale: "Structural validation pending",
      },
      {
        entity_id: "concern-retrieval-004",
        stage: "identity_resolution",
        outcome: "RETRIEVAL_INCONCLUSIVE",
        rationale: "Retrieval returned conflicting candidates",
      },
    ];

    it("preserves all pending decision outcomes through round-trip", () => {
      const roundTripped = JSON.parse(
        JSON.stringify(pendingDecisions)
      ) as PendingDecisionSummary[];
      expect(roundTripped).toEqual(pendingDecisions);
    });

    it("preserves null rationale distinctly from string rationale", () => {
      const roundTripped = JSON.parse(
        JSON.stringify(pendingDecisions)
      ) as PendingDecisionSummary[];
      // First has string rationale
      expect(roundTripped[0].rationale).toBe(
        "No matching concern found with sufficient confidence"
      );
      // Second has null rationale
      expect(roundTripped[1].rationale).toBeNull();
    });

    it("pending_decisions in GraphStateContext round-trips correctly", () => {
      const graphState: GraphStateContext = {
        graph_version: 12,
        concerns: [],
        propositions: [],
        active_associations: [],
        pending_decisions: pendingDecisions,
      };

      const roundTripped = JSON.parse(
        JSON.stringify(graphState)
      ) as GraphStateContext;
      expect(roundTripped.pending_decisions).toEqual(pendingDecisions);
      expect(roundTripped.pending_decisions).toHaveLength(4);
    });
  });

  describe("Enum value round-trip correctness", () => {
    it("all AssociationRole values round-trip", () => {
      const roles: components["schemas"]["AssociationRole"][] = [
        "PRIMARY_OWNER",
        "SUPPORTING_EVIDENCE",
        "EMERGENCE_EVIDENCE",
        "CONTEXT",
        "CROSS_OBJECT_IMPACT",
      ];
      const roundTripped = JSON.parse(JSON.stringify(roles));
      expect(roundTripped).toEqual(roles);
    });

    it("all RetentionLevel values round-trip", () => {
      const levels: components["schemas"]["RetentionLevel"][] = [
        "DISCARD",
        "CONTEXT_ONLY",
        "SUPPORTING_EVIDENCE",
        "DURABLE_PROPOSITION",
        "EMERGENCE_EVIDENCE",
        "INDEPENDENT_CONCERN_CANDIDATE",
      ];
      const roundTripped = JSON.parse(JSON.stringify(levels));
      expect(roundTripped).toEqual(levels);
    });

    it("all PipelineOutcome values round-trip", () => {
      const outcomes: components["schemas"]["PipelineOutcome"][] = [
        "YES",
        "NO",
        "UNRESOLVED",
        "DEFER",
        "RETRIEVAL_INCONCLUSIVE",
        "REQUIRES_VALIDATION",
      ];
      const roundTripped = JSON.parse(JSON.stringify(outcomes));
      expect(roundTripped).toEqual(outcomes);
    });

    it("all SemanticState values round-trip", () => {
      const states: components["schemas"]["SemanticState"][] = [
        "ACTIVE",
        "SUPERSEDED",
        "RETRACTED",
        "INVALIDATED",
      ];
      const roundTripped = JSON.parse(JSON.stringify(states));
      expect(roundTripped).toEqual(states);
    });

    it("all CohesionStatus values round-trip", () => {
      const statuses: components["schemas"]["CohesionStatus"][] = [
        "COHESIVE",
        "MIXED",
        "UNRESOLVED_COHESION",
      ];
      const roundTripped = JSON.parse(JSON.stringify(statuses));
      expect(roundTripped).toEqual(statuses);
    });
  });

  describe("Creation key and version preservation", () => {
    it("creation keys survive round-trip in all entity types", () => {
      const entities = {
        proposition_creation_key: "conv-001:req-abc:extract-0",
        packet_creation_key: "conv-001:req-abc:partition-0",
        association_creation_key: "conv-001:req-abc:assoc-0",
        decision_creation_key: "conv-001:req-abc:msg-005:pos-0",
        membership_creation_key: "pkt-001:prop-001:ord-0",
        split_creation_key: "conv-001:req-abc:split-pkt-001",
      };

      const roundTripped = JSON.parse(JSON.stringify(entities));
      expect(roundTripped).toEqual(entities);
    });

    it("version fields preserve integer type through round-trip", () => {
      const versioned = {
        base_graph_version: 7,
        semantic_version: 3,
        association_version: 1,
        sequence_position: 42,
        ordinal: 0,
      };

      const roundTripped = JSON.parse(JSON.stringify(versioned));
      expect(roundTripped.base_graph_version).toBe(7);
      expect(roundTripped.semantic_version).toBe(3);
      expect(roundTripped.association_version).toBe(1);
      expect(roundTripped.sequence_position).toBe(42);
      expect(roundTripped.ordinal).toBe(0);
      // Verify they remain numbers, not strings
      expect(typeof roundTripped.base_graph_version).toBe("number");
      expect(typeof roundTripped.ordinal).toBe("number");
    });
  });

  describe("Nullability edge cases", () => {
    it("proposition with null supersedes_proposition_id", () => {
      const prop: Proposition = {
        proposition_id: "prop-001",
        proposition_creation_key: "conv:req:extract-0",
        conversation_id: "conv-001",
        source_message_ids: ["msg-001"],
        speaker_role: "USER",
        canonical_meaning: "A test proposition",
        proposition_type: "CLAIM",
        message_seq_range: [1, 1],
        provenance: "DIRECT",
        semantic_state: "ACTIVE",
        retention_levels: ["DURABLE_PROPOSITION"],
        created_at: "2024-01-01T00:00:00Z",
        extraction_version: "0.1.0",
        supersedes_proposition_id: null,
      };

      const roundTripped = JSON.parse(JSON.stringify(prop)) as Proposition;
      expect(roundTripped.supersedes_proposition_id).toBeNull();
    });

    it("proposition with non-null supersedes_proposition_id", () => {
      const prop: Proposition = {
        proposition_id: "prop-002",
        proposition_creation_key: "conv:req:extract-1",
        conversation_id: "conv-001",
        source_message_ids: ["msg-002"],
        speaker_role: "USER",
        canonical_meaning: "Updated proposition",
        proposition_type: "UPDATE",
        message_seq_range: [2, 2],
        provenance: "DIRECT",
        semantic_state: "ACTIVE",
        retention_levels: ["DURABLE_PROPOSITION"],
        created_at: "2024-01-01T01:00:00Z",
        extraction_version: "0.1.0",
        supersedes_proposition_id: "prop-001",
      };

      const roundTripped = JSON.parse(JSON.stringify(prop)) as Proposition;
      expect(roundTripped.supersedes_proposition_id).toBe("prop-001");
    });

    it("packet with null assistant_context and continuation_origin", () => {
      const packet: SemanticPacket = {
        packet_id: "pkt-null-test",
        packet_creation_key: "conv:req:partition-0",
        conversation_id: "conv-001",
        source_message_ids: ["msg-001"],
        message_seq_range: [1, 1],
        user_grounded_meaning: "Test meaning",
        assistant_context: null,
        continuation_origin: null,
        provenance: "extraction",
        packet_formation_version: "0.1.0",
        cohesion_status: "COHESIVE",
        provisional_boundaries: [],
      };

      const roundTripped = JSON.parse(
        JSON.stringify(packet)
      ) as SemanticPacket;
      expect(roundTripped.assistant_context).toBeNull();
      expect(roundTripped.continuation_origin).toBeNull();
    });

    it("packet with non-null assistant_context", () => {
      const packet: SemanticPacket = {
        packet_id: "pkt-ctx-test",
        packet_creation_key: "conv:req:partition-1",
        conversation_id: "conv-001",
        source_message_ids: ["msg-001", "msg-002"],
        message_seq_range: [1, 2],
        user_grounded_meaning: "User discussing relocation",
        assistant_context:
          "Assistant asked about relocation timeline preferences",
        continuation_origin: "pkt-prev-001",
        provenance: "extraction",
        packet_formation_version: "0.1.0",
        cohesion_status: "COHESIVE",
        provisional_boundaries: [],
      };

      const roundTripped = JSON.parse(
        JSON.stringify(packet)
      ) as SemanticPacket;
      expect(roundTripped.assistant_context).toBe(
        "Assistant asked about relocation timeline preferences"
      );
      expect(roundTripped.continuation_origin).toBe("pkt-prev-001");
    });
  });
});

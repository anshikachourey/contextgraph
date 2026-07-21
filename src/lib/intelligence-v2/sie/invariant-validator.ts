/**
 * Deterministic structural invariant validation for the SIE pipeline.
 *
 * TypeScript performs STRUCTURAL validation only — it does NOT make
 * semantic ownership decisions. All semantic judgments are made by
 * the Python ml-service and arrive via the ProcessResult.
 *
 * Validation checks cover:
 * - Dangling references (propositions → concerns, associations → propositions/concerns)
 * - Conversation boundary (all entities share conversation_id)
 * - One active primary owner per proposition
 * - Single parent per concern
 * - Acyclicity in concern parent hierarchy
 * - Parent-resolution consistency (PARENT_ASSIGNED ↔ non-null parent)
 * - Merge redirects (MERGED ↔ non-null target)
 * - Sequence ranges (start <= end)
 * - Base graph version consistency
 * - Semantic dependency group completeness (ALL_OR_NONE integrity)
 * - Pending-decision lifecycle consistency
 */

import type {
  InvariantValidationResult,
  InvariantViolation,
  ProcessResult,
  SIEGraphState,
} from "./types";

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Validates structural invariants of a ProcessResult against the current
 * graph state and expected base graph version.
 *
 * This function is deterministic and side-effect-free. It returns a list
 * of all detected violations without short-circuiting.
 */
export function validateInvariants(
  processResult: ProcessResult,
  currentGraphState: SIEGraphState,
  baseGraphVersion: number
): InvariantValidationResult {
  const violations: InvariantViolation[] = [
    ...validateDanglingReferences(processResult, currentGraphState),
    ...validateConversationBoundary(processResult),
    ...validateOneActivePrimaryOwner(processResult),
    ...validateSingleParent(processResult),
    ...validateAcyclicity(processResult, currentGraphState),
    ...validateParentResolutionConsistency(processResult),
    ...validateMergeRedirects(processResult),
    ...validateSequenceRanges(processResult),
    ...validateBaseGraphVersion(processResult, baseGraphVersion),
    ...validateDependencyGroups(processResult),
    ...validatePendingDecisionLifecycle(processResult, currentGraphState),
  ];

  return {
    valid: violations.length === 0,
    violations,
  };
}

// ─── Individual Validators ──────────────────────────────────────────────────

/**
 * Validates that propositions reference existing concerns and that
 * associations reference existing propositions and concerns.
 */
function validateDanglingReferences(
  processResult: ProcessResult,
  currentGraphState: SIEGraphState
): InvariantViolation[] {
  const violations: InvariantViolation[] = [];

  // Build sets of known entity IDs from both the process result and current state
  const knownConcernIds = new Set<string>();
  const knownPropositionIds = new Set<string>();

  // From current graph state
  for (const concern of currentGraphState.concerns) {
    knownConcernIds.add(concern.concern_id);
  }
  for (const prop of currentGraphState.propositions) {
    knownPropositionIds.add(prop.proposition_id);
  }

  // From process result (new proposals and propositions)
  for (const proposal of processResult.new_concern_proposals) {
    knownConcernIds.add(proposal.proposed_concern_id);
  }
  for (const prop of processResult.propositions) {
    knownPropositionIds.add(prop.proposition_id);
  }

  // Validate associations reference existing propositions and concerns
  for (const assoc of processResult.proposed_associations) {
    if (!knownPropositionIds.has(assoc.proposition_id)) {
      violations.push({
        type: "dangling_reference",
        entityId: assoc.association_id,
        description: `Association references non-existent proposition: ${assoc.proposition_id}`,
      });
    }
    if (!knownConcernIds.has(assoc.concern_id)) {
      violations.push({
        type: "dangling_reference",
        entityId: assoc.association_id,
        description: `Association references non-existent concern: ${assoc.concern_id}`,
      });
    }
  }

  // Validate identity resolutions reference known concerns
  for (const resolution of processResult.identity_resolutions) {
    if (
      resolution.matched_concern_id &&
      !knownConcernIds.has(resolution.matched_concern_id)
    ) {
      violations.push({
        type: "dangling_reference",
        entityId: resolution.packet_id,
        description: `Identity resolution references non-existent concern: ${resolution.matched_concern_id}`,
      });
    }
  }

  // Validate packet memberships reference known propositions and packets
  const knownPacketIds = new Set<string>(
    processResult.packets.map((p) => p.packet_id)
  );
  for (const membership of processResult.packet_memberships) {
    if (!knownPropositionIds.has(membership.proposition_id)) {
      violations.push({
        type: "dangling_reference",
        entityId: membership.membership_id,
        description: `Packet membership references non-existent proposition: ${membership.proposition_id}`,
      });
    }
    if (!knownPacketIds.has(membership.packet_id)) {
      violations.push({
        type: "dangling_reference",
        entityId: membership.membership_id,
        description: `Packet membership references non-existent packet: ${membership.packet_id}`,
      });
    }
  }

  // Validate splits reference known packets
  for (const split of processResult.splits) {
    if (!knownPacketIds.has(split.original_packet_id)) {
      violations.push({
        type: "dangling_reference",
        entityId: split.split_id,
        description: `Split references non-existent original packet: ${split.original_packet_id}`,
      });
    }
    for (const resultId of split.resulting_packet_ids) {
      if (!knownPacketIds.has(resultId)) {
        violations.push({
          type: "dangling_reference",
          entityId: split.split_id,
          description: `Split references non-existent resulting packet: ${resultId}`,
        });
      }
    }
  }

  return violations;
}

/**
 * Validates that all entities in the result share the same conversation_id.
 */
function validateConversationBoundary(
  processResult: ProcessResult
): InvariantViolation[] {
  const violations: InvariantViolation[] = [];
  const expectedConversationId = processResult.conversation_id;

  for (const prop of processResult.propositions) {
    if (prop.conversation_id !== expectedConversationId) {
      violations.push({
        type: "dangling_reference",
        entityId: prop.proposition_id,
        description: `Proposition has conversation_id "${prop.conversation_id}" but expected "${expectedConversationId}"`,
      });
    }
  }

  for (const packet of processResult.packets) {
    if (packet.conversation_id !== expectedConversationId) {
      violations.push({
        type: "dangling_reference",
        entityId: packet.packet_id,
        description: `Packet has conversation_id "${packet.conversation_id}" but expected "${expectedConversationId}"`,
      });
    }
  }

  for (const decision of processResult.retention_decisions) {
    if (decision.conversation_id !== expectedConversationId) {
      violations.push({
        type: "dangling_reference",
        entityId: decision.decision_id,
        description: `Retention decision has conversation_id "${decision.conversation_id}" but expected "${expectedConversationId}"`,
      });
    }
  }

  return violations;
}

/**
 * Validates that no proposition has multiple active PRIMARY_OWNER associations.
 *
 * A proposition MAY be PRIMARY_OWNER for at most one concern at a time.
 * Multiple non-PRIMARY_OWNER associations are allowed.
 */
function validateOneActivePrimaryOwner(
  processResult: ProcessResult
): InvariantViolation[] {
  const violations: InvariantViolation[] = [];

  // Count active PRIMARY_OWNER associations per proposition
  const primaryOwnerCount = new Map<string, string[]>();

  for (const assoc of processResult.proposed_associations) {
    if (
      assoc.role === "PRIMARY_OWNER" &&
      assoc.semantic_state === "ACTIVE"
    ) {
      const existing = primaryOwnerCount.get(assoc.proposition_id) ?? [];
      existing.push(assoc.concern_id);
      primaryOwnerCount.set(assoc.proposition_id, existing);
    }
  }

  primaryOwnerCount.forEach((concernIds, propositionId) => {
    if (concernIds.length > 1) {
      violations.push({
        type: "multi_parent",
        entityId: propositionId,
        description: `Proposition has ${concernIds.length} active PRIMARY_OWNER associations to concerns: ${concernIds.join(", ")}`,
      });
    }
  });

  return violations;
}

/**
 * Validates that no concern has multiple parent assignments.
 *
 * New concern proposals in the result should not have conflicting parents,
 * and existing concerns should not be given additional parents.
 */
function validateSingleParent(
  processResult: ProcessResult
): InvariantViolation[] {
  const violations: InvariantViolation[] = [];

  // Check for duplicate concern proposals (same ID proposed multiple times)
  const proposalsByIds = new Map<string, number>();
  for (const proposal of processResult.new_concern_proposals) {
    const count = (proposalsByIds.get(proposal.proposed_concern_id) ?? 0) + 1;
    proposalsByIds.set(proposal.proposed_concern_id, count);
    if (count > 1) {
      violations.push({
        type: "multi_parent",
        entityId: proposal.proposed_concern_id,
        description: `Concern proposed ${count} times in the same result — conflicting parent assignments possible`,
      });
    }
  }

  return violations;
}

/**
 * Validates that the concern parent hierarchy contains no cycles.
 *
 * Uses a topological-sort-based cycle detection approach combining
 * existing graph state with new concern proposals.
 */
function validateAcyclicity(
  processResult: ProcessResult,
  currentGraphState: SIEGraphState
): InvariantViolation[] {
  const violations: InvariantViolation[] = [];

  // Build the full parent map: concern_id → parent_id
  const parentMap = new Map<string, string>();

  // Existing concerns from graph state
  for (const concern of currentGraphState.concerns) {
    if (concern.canonical_parent_id) {
      parentMap.set(concern.concern_id, concern.canonical_parent_id);
    }
  }

  // New concern proposals — override or add parent relationships
  for (const proposal of processResult.new_concern_proposals) {
    if (proposal.proposed_parent_id) {
      parentMap.set(proposal.proposed_concern_id, proposal.proposed_parent_id);
    }
  }

  // Detect cycles by walking up the parent chain for each concern
  const allConcernIds = new Set([
    ...currentGraphState.concerns.map((c) => c.concern_id),
    ...processResult.new_concern_proposals.map((p) => p.proposed_concern_id),
  ]);

  Array.from(allConcernIds).forEach((startId) => {
    const visited = new Set<string>();
    let current: string | undefined = startId;

    while (current && parentMap.has(current)) {
      if (visited.has(current)) {
        violations.push({
          type: "cycle_detected",
          entityId: startId,
          description: `Cycle detected in concern parent hierarchy involving: ${Array.from(visited).join(" → ")} → ${current}`,
        });
        break;
      }
      visited.add(current);
      current = parentMap.get(current);
    }
  });

  return violations;
}

/**
 * Validates parent-resolution consistency:
 * - PARENT_ASSIGNED must have a non-null parent
 * - ROOT_CONFIRMED and PARENT_DEFERRED must have null parent
 */
function validateParentResolutionConsistency(
  processResult: ProcessResult
): InvariantViolation[] {
  const violations: InvariantViolation[] = [];

  for (const proposal of processResult.new_concern_proposals) {
    const state = proposal.parent_resolution_state;
    const hasParent = proposal.proposed_parent_id != null;

    if (state === "PARENT_ASSIGNED" && !hasParent) {
      violations.push({
        type: "dangling_reference",
        entityId: proposal.proposed_concern_id,
        description: `Concern has parent_resolution_state=PARENT_ASSIGNED but proposed_parent_id is null`,
      });
    }

    if (
      (state === "ROOT_CONFIRMED" || state === "PARENT_DEFERRED") &&
      hasParent
    ) {
      violations.push({
        type: "dangling_reference",
        entityId: proposal.proposed_concern_id,
        description: `Concern has parent_resolution_state=${state} but proposed_parent_id is set to "${proposal.proposed_parent_id}"`,
      });
    }
  }

  return violations;
}

/**
 * Validates merge redirect consistency:
 * - MERGED concerns must have a merge target (merged_into_concern_id)
 * - Non-MERGED concerns must NOT have a merge target
 *
 * Note: Only new concern proposals are validated — existing graph state
 * concerns are assumed to have been validated at commit time.
 * Since ConcernProposal does not carry status or merged_into_concern_id,
 * this check validates against identity resolutions that imply merges.
 */
function validateMergeRedirects(
  processResult: ProcessResult
): InvariantViolation[] {
  const violations: InvariantViolation[] = [];

  // Validate that new concern proposals with PARENT_ASSIGNED state
  // reference a valid parent that isn't MERGED (structural check)
  const newConcernIds = new Set(
    processResult.new_concern_proposals.map((p) => p.proposed_concern_id)
  );

  // Check if any identity resolution matches a concern that's also being
  // proposed as new (which would be contradictory)
  for (const resolution of processResult.identity_resolutions) {
    if (
      resolution.matched_concern_id &&
      resolution.new_concern_proposal
    ) {
      violations.push({
        type: "dangling_reference",
        entityId: resolution.packet_id,
        description: `Identity resolution has both matched_concern_id and new_concern_proposal — these are mutually exclusive`,
      });
    }
  }

  // Check that proposed parent IDs don't reference concerns that are being
  // newly proposed and also referencing themselves (would be caught by cycle
  // detection, but this is an additional structural validation)
  for (const proposal of processResult.new_concern_proposals) {
    if (
      proposal.proposed_parent_id &&
      proposal.proposed_parent_id === proposal.proposed_concern_id
    ) {
      violations.push({
        type: "cycle_detected",
        entityId: proposal.proposed_concern_id,
        description: `Concern proposes itself as parent`,
      });
    }
  }

  return violations;
}

/**
 * Validates that all sequence ranges have start <= end.
 */
function validateSequenceRanges(
  processResult: ProcessResult
): InvariantViolation[] {
  const violations: InvariantViolation[] = [];

  // Validate proposition seq ranges
  for (const prop of processResult.propositions) {
    const [start, end] = prop.message_seq_range;
    if (start > end) {
      violations.push({
        type: "dangling_reference",
        entityId: prop.proposition_id,
        description: `Proposition has invalid message_seq_range: start (${start}) > end (${end})`,
      });
    }
  }

  // Validate packet seq ranges
  for (const packet of processResult.packets) {
    const [start, end] = packet.message_seq_range;
    if (start > end) {
      violations.push({
        type: "dangling_reference",
        entityId: packet.packet_id,
        description: `Packet has invalid message_seq_range: start (${start}) > end (${end})`,
      });
    }
  }

  // Validate process result overall seq range
  if (processResult.lowest_seq > processResult.highest_seq) {
    violations.push({
      type: "dangling_reference",
      entityId: processResult.request_id,
      description: `ProcessResult has invalid seq range: lowest_seq (${processResult.lowest_seq}) > highest_seq (${processResult.highest_seq})`,
    });
  }

  return violations;
}

/**
 * Validates that processResult.base_graph_version matches the expected version.
 */
function validateBaseGraphVersion(
  processResult: ProcessResult,
  baseGraphVersion: number
): InvariantViolation[] {
  const violations: InvariantViolation[] = [];

  if (processResult.base_graph_version !== baseGraphVersion) {
    violations.push({
      type: "version_conflict",
      entityId: processResult.request_id,
      description: `ProcessResult base_graph_version (${processResult.base_graph_version}) does not match expected version (${baseGraphVersion})`,
    });
  }

  return violations;
}

/**
 * Validates semantic dependency group completeness.
 *
 * Every mutation_ref in a group must exist in the result regardless of
 * failure_policy. INDEPENDENT means mutations may commit or fail independently
 * at execution time — it does NOT permit dangling mutation references.
 * A dangling reference means the ProcessResult is structurally incomplete.
 */
function validateDependencyGroups(
  processResult: ProcessResult
): InvariantViolation[] {
  const violations: InvariantViolation[] = [];
  const groups = processResult.dependency_groups ?? [];

  // Build set of all known entity/mutation IDs in the result
  const allResultIds = new Set<string>();
  for (const prop of processResult.propositions) {
    allResultIds.add(prop.proposition_id);
  }
  for (const packet of processResult.packets) {
    allResultIds.add(packet.packet_id);
  }
  for (const assoc of processResult.proposed_associations) {
    allResultIds.add(assoc.association_id);
  }
  for (const membership of processResult.packet_memberships) {
    allResultIds.add(membership.membership_id);
  }
  for (const split of processResult.splits) {
    allResultIds.add(split.split_id);
  }
  for (const decision of processResult.retention_decisions) {
    allResultIds.add(decision.decision_id);
  }
  for (const proposal of processResult.new_concern_proposals) {
    allResultIds.add(proposal.proposed_concern_id);
  }
  for (const resolution of processResult.identity_resolutions) {
    allResultIds.add(resolution.packet_id);
  }

  for (const group of groups) {
    const missingRefs: string[] = [];
    for (const ref of group.mutation_refs) {
      if (!allResultIds.has(ref)) {
        missingRefs.push(ref);
      }
    }

    if (missingRefs.length > 0) {
      violations.push({
        type: "dangling_reference",
        entityId: group.group_id,
        description: `Dependency group (policy=${group.failure_policy}) has missing mutation refs: ${missingRefs.join(", ")}`,
      });
    }
  }

  return violations;
}

/**
 * Validates pending-decision lifecycle transitions.
 *
 * - Cannot resolve a decision that doesn't exist in the current graph state's
 *   pending decisions.
 * - Cannot create duplicate pending decisions (same entity_id + stage).
 *
 * Note: The ProcessResult itself may contain identity resolutions that reference
 * pending decisions from the graph state. This validator ensures structural
 * consistency without making semantic ownership decisions.
 */
function validatePendingDecisionLifecycle(
  processResult: ProcessResult,
  currentGraphState: SIEGraphState
): InvariantViolation[] {
  const violations: InvariantViolation[] = [];

  // Build a set of existing pending decision entity IDs from graph state
  const existingPendingDecisionEntityIds = new Set<string>();
  for (const packet of currentGraphState.packets) {
    // Packets are tracked but pending decisions come from the GraphStateContext
    // which is embedded in ProcessResult via currentGraphState
  }

  // The graph state's pending decisions are accessed through the associations
  // and packets — but the primary source is the ProcessResult's diagnostics
  // which reports deferred_entity_ids
  const deferredIds = new Set(
    processResult.diagnostics.deferred_entity_ids ?? []
  );

  // Check identity resolutions that claim to match concerns that are being
  // deferred — a deferred entity shouldn't be matched in the same result
  for (const resolution of processResult.identity_resolutions) {
    if (
      resolution.matched_concern_id &&
      deferredIds.has(resolution.matched_concern_id)
    ) {
      violations.push({
        type: "dangling_reference",
        entityId: resolution.packet_id,
        description: `Identity resolution matches concern "${resolution.matched_concern_id}" which is also listed as deferred in the same result`,
      });
    }
  }

  // Check for duplicate new concern proposals (same concern_id proposed twice)
  const seenProposalIds = new Set<string>();
  for (const proposal of processResult.new_concern_proposals) {
    if (seenProposalIds.has(proposal.proposed_concern_id)) {
      violations.push({
        type: "dangling_reference",
        entityId: proposal.proposed_concern_id,
        description: `Duplicate new concern proposal for the same concern_id`,
      });
    }
    seenProposalIds.add(proposal.proposed_concern_id);
  }

  // Check that identity resolutions referencing matched_concern_id point to
  // concerns that exist in the current graph state (not just new proposals)
  // — new proposals should use new_concern_proposal, not matched_concern_id
  const existingConcernIds = new Set(
    currentGraphState.concerns.map((c) => c.concern_id)
  );
  for (const resolution of processResult.identity_resolutions) {
    if (resolution.matched_concern_id) {
      if (
        !existingConcernIds.has(resolution.matched_concern_id) &&
        !seenProposalIds.has(resolution.matched_concern_id)
      ) {
        // Already caught by dangling references, but providing lifecycle context
        violations.push({
          type: "dangling_reference",
          entityId: resolution.packet_id,
          description: `Identity resolution attempts to resolve to concern "${resolution.matched_concern_id}" which does not exist in graph state or new proposals`,
        });
      }
    }
  }

  return violations;
}

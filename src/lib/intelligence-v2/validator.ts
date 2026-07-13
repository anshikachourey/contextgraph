/**
 * V2 Validator: Deterministic validation of the graph plan.
 *
 * Rejects: unsupported claims, cycles, hallucinations, provenance violations.
 */

import type { V2GraphPlan, ValidationResult } from "./schemas";

export function validateGraphPlan(plan: V2GraphPlan): ValidationResult[] {
  const results: ValidationResult[] = [];

  // 1. Objects must have user-proposition support
  for (const obj of plan.objects) {
    if (obj.status === "discarded" || obj.objectType === "noise") continue;

    if (obj.supportingUtteranceIds.length === 0) {
      results.push({
        targetId: obj.objectId,
        valid: false,
        errors: [`Object "${obj.title}" has no supporting user utterances — may be assistant-only derivation`],
        warnings: [],
      });
    }
  }

  // 2. No child_of cycles
  const parentMap = new Map<string, string>();
  for (const rel of [...plan.semanticRelationships, ...plan.structuralRelationships]) {
    if (rel.type === "child_of") {
      parentMap.set(rel.sourceObjectId, rel.targetObjectId);
    }
  }
  for (const [child] of parentMap) {
    const visited = new Set<string>();
    let current: string | undefined = child;
    while (current && parentMap.has(current)) {
      if (visited.has(current)) {
        results.push({
          targetId: child,
          valid: false,
          errors: [`Cycle detected in child_of chain involving ${child}`],
          warnings: [],
        });
        break;
      }
      visited.add(current);
      current = parentMap.get(current);
    }
  }

  // 3. diverged_from must not imply hierarchy
  for (const rel of plan.structuralRelationships) {
    if (rel.type === "diverged_from") {
      // Check that source is not also child_of target
      const isAlsoChild = plan.structuralRelationships.some(
        (r) => r.type === "child_of" && r.sourceObjectId === rel.sourceObjectId && r.targetObjectId === rel.targetObjectId,
      );
      if (isAlsoChild) {
        results.push({
          targetId: rel.relationshipId,
          valid: false,
          errors: [`diverged_from AND child_of between same objects — contradictory`],
          warnings: [],
        });
      }
    }
  }

  // 4. Propositions with provenance "interpretation" cannot be sole support for user-attributed objects
  for (const obj of plan.objects) {
    if (obj.status === "discarded") continue;
    const objProps = plan.propositions.filter((p) => obj.propositionIds.includes(p.propositionId));
    const userDirectProps = objProps.filter((p) => p.authoredBy === "user" && p.provenance === "direct");
    const interpretationOnlyProps = objProps.filter((p) => p.provenance === "interpretation");

    if (userDirectProps.length === 0 && interpretationOnlyProps.length > 0) {
      results.push({
        targetId: obj.objectId,
        valid: false,
        errors: [`Object "${obj.title}" relies only on assistant interpretations — no direct user support`],
        warnings: [],
      });
    }
  }

  // 5. Superseded propositions should not be sole support
  for (const obj of plan.objects) {
    const objProps = plan.propositions.filter((p) => obj.propositionIds.includes(p.propositionId));
    const superseded = objProps.filter((p) => p.status === "superseded");
    if (superseded.length > 0 && superseded.length === objProps.length) {
      results.push({
        targetId: obj.objectId,
        valid: false,
        errors: [`Object "${obj.title}" relies entirely on superseded propositions`],
        warnings: [],
      });
    }
  }

  return results;
}

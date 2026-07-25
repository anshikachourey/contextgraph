/**
 * Fixture Loader — Loads and validates golden fixtures and variants.
 */

import fs from "fs";
import path from "path";
import type { EvalFixture, EvalVariant, VariantMaterializationStatus } from "./types";

const EVALS_DIR = path.resolve(process.cwd(), "contextgraph-eval-harness-v1/evals/semantic-mutation");
const GOLDEN_DIR = path.join(EVALS_DIR, "golden");
const VARIANTS_DIR = path.join(EVALS_DIR, "variants");
const SCHEMA_PATH = path.join(EVALS_DIR, "schema/semantic-mutation-eval-case.schema.json");

const REQUIRED_FIELDS = ["id", "title", "tags", "executionMode", "existingGraph", "expectedTrace", "expectedMutationSet", "forbiddenOutcomes", "criticalAssertions"];

export interface LoadResult<T> {
  items: T[];
  errors: Array<{ file: string; errors: string[] }>;
}

/**
 * Load all golden fixtures with validation.
 */
export function loadGoldenFixtures(): LoadResult<EvalFixture> {
  return loadFixturesFromDir(GOLDEN_DIR);
}

/**
 * Load a single golden fixture by ID.
 */
export function loadGoldenFixture(id: string): EvalFixture | null {
  const filePath = path.join(GOLDEN_DIR, `${id}.json`);
  if (!fs.existsSync(filePath)) return null;
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const errors = validateFixture(raw, filePath);
  if (errors.length > 0) return null;
  return raw as EvalFixture;
}

/**
 * Load all variant descriptors.
 */
export function loadVariants(): LoadResult<EvalVariant> {
  const items: EvalVariant[] = [];
  const errors: Array<{ file: string; errors: string[] }> = [];

  if (!fs.existsSync(VARIANTS_DIR)) return { items, errors };

  const files = fs.readdirSync(VARIANTS_DIR).filter((f) => f.endsWith(".json")).sort();
  for (const file of files) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(VARIANTS_DIR, file), "utf8"));
      const variantErrors: string[] = [];
      if (!raw.id) variantErrors.push("missing id");
      if (!raw.baseCaseId) variantErrors.push("missing baseCaseId");
      if (!raw.transformation) variantErrors.push("missing transformation");
      if (variantErrors.length > 0) {
        errors.push({ file, errors: variantErrors });
      } else {
        items.push(raw as EvalVariant);
      }
    } catch (e) {
      errors.push({ file, errors: [`Parse error: ${e instanceof Error ? e.message : "unknown"}`] });
    }
  }

  return { items, errors };
}

/**
 * Classify variant materialization status.
 */
export function classifyVariant(variant: EvalVariant): VariantMaterializationStatus {
  if (!variant.transformation?.patches || !Array.isArray(variant.transformation.patches)) {
    return "INVALID";
  }
  // JSON Patch with op/path/value is machine-materializable
  for (const patch of variant.transformation.patches) {
    if (!patch.op || !patch.path) return "REQUIRES_EXPLICIT_MATERIALIZATION";
    if (!["replace", "add", "remove"].includes(patch.op)) return "REQUIRES_EXPLICIT_MATERIALIZATION";
  }
  return "MACHINE_MATERIALIZABLE";
}

/**
 * Materialize a variant by applying patches to the base fixture.
 */
export function materializeVariant(base: EvalFixture, variant: EvalVariant): EvalFixture | null {
  if (classifyVariant(variant) !== "MACHINE_MATERIALIZABLE") return null;

  const materialized = JSON.parse(JSON.stringify(base)) as EvalFixture;
  materialized.id = variant.id;

  for (const patch of variant.transformation.patches) {
    applyPatch(materialized as unknown as Record<string, unknown>, patch.path, patch.op, patch.value);
  }

  return materialized;
}

function applyPatch(obj: Record<string, unknown>, jsonPath: string, op: string, value: unknown): void {
  const parts = jsonPath.split("/").filter(Boolean);
  let target: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    target = target[parts[i]] as Record<string, unknown>;
    if (!target) return;
  }
  const key = parts[parts.length - 1];
  if (op === "replace" || op === "add") target[key] = value;
  else if (op === "remove") delete target[key];
}

// ─── Internal ───────────────────────────────────────────────────────────────

function loadFixturesFromDir(dir: string): LoadResult<EvalFixture> {
  const items: EvalFixture[] = [];
  const errors: Array<{ file: string; errors: string[] }> = [];

  if (!fs.existsSync(dir)) return { items, errors: [{ file: dir, errors: ["directory not found"] }] };

  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  for (const file of files) {
    const filePath = path.join(dir, file);
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
      const fileErrors = validateFixture(raw, file);
      if (fileErrors.length > 0) {
        errors.push({ file, errors: fileErrors });
      } else {
        items.push(raw as EvalFixture);
      }
    } catch (e) {
      errors.push({ file, errors: [`Parse error: ${e instanceof Error ? e.message : "unknown"}`] });
    }
  }

  return { items, errors };
}

function validateFixture(raw: Record<string, unknown>, filename: string): string[] {
  const errors: string[] = [];
  for (const field of REQUIRED_FIELDS) {
    if (!(field in raw)) errors.push(`[${filename}] missing required field: ${field}`);
  }
  if (raw.executionMode && !["SINGLE_STEP", "SEQUENCE"].includes(raw.executionMode as string)) {
    errors.push(`[${filename}] invalid executionMode: ${raw.executionMode}`);
  }
  if (raw.executionMode === "SEQUENCE" && !Array.isArray(raw.steps)) {
    errors.push(`[${filename}] SEQUENCE mode requires steps array`);
  }
  return errors;
}

# SIE Contract Policy

## Source of Truth

The `sie-openapi.json` file in this directory is the **single source of truth**
for the SIE Python–TypeScript transport contract. TypeScript transport types are
generated from this artifact — never maintained as a separate handwritten schema.

## Regenerating the Artifact

```bash
cd ml-service
python scripts/export_openapi.py
```

The script produces deterministic output (sorted keys, consistent formatting).
If the artifact has changed after regeneration, commit the updated file.

## Contract Version Bump Rule

The `api_contract_version` field in `ProcessRequest` and `ProcessResult` MUST be
incremented when a **breaking change** is introduced. Breaking changes include:

1. **Field removal** — removing an existing field from any contract model.
2. **Type change** — changing the type of an existing field (e.g., `str` → `int`,
   `Optional[str]` → `str`).
3. **New required field** — adding a field without a default value to an existing
   model (consumers that do not send the field will fail validation).
4. **Enum value removal** — removing a previously valid enum variant.
5. **Semantic redefinition** — changing the meaning of an existing field or enum
   value without changing its type.

Non-breaking additions (new optional fields, new enum variants that do not alter
existing behavior) do NOT require a version bump.

## CI Staleness Check

A test (`tests/sie/test_contract_drift.py`) verifies that the checked-in artifact
matches the current state of the Python models. If the test fails, it means
someone changed the Pydantic models without regenerating the contract. Run:

```bash
python scripts/export_openapi.py
```

Then commit the updated `sie-openapi.json`.

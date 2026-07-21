#!/usr/bin/env python3
"""Export the FastAPI app's OpenAPI schema to a deterministic JSON artifact.

Usage:
    python scripts/export_openapi.py

Output:
    contracts/sie-openapi.json

The output is deterministic (sorted keys, consistent indent) so that
diff-based comparisons and CI staleness checks work reliably.
"""

import json
import sys
from pathlib import Path

# Ensure the ml-service root is on the Python path so `app` is importable.
_ML_SERVICE_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_ML_SERVICE_ROOT))

from app.main import app  # noqa: E402


def export_openapi() -> None:
    """Generate the OpenAPI JSON artifact from the FastAPI app."""
    schema = app.openapi()

    output_dir = _ML_SERVICE_ROOT / "contracts"
    output_dir.mkdir(parents=True, exist_ok=True)

    output_path = output_dir / "sie-openapi.json"
    output_path.write_text(
        json.dumps(schema, indent=2, sort_keys=True, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    print(f"OpenAPI schema exported to {output_path}")


if __name__ == "__main__":
    export_openapi()

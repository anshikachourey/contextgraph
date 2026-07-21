"""SIE feature configuration.

All SIE features are disabled by default. Each flag is controlled by an
environment variable and must be explicitly enabled for the corresponding
functionality to become available.
"""

import os


def _env_bool(key: str, default: bool = False) -> bool:
    """Parse a boolean from an environment variable.

    Truthy values: "1", "true", "yes" (case-insensitive).
    Everything else (including absent) is False.
    """
    val = os.environ.get(key, "").strip().lower()
    if default:
        return val not in ("0", "false", "no")
    return val in ("1", "true", "yes")


# Whether the /sie/process-messages endpoint is exposed and accepts requests.
SIE_ENDPOINT_ENABLED: bool = _env_bool("SIE_ENDPOINT_ENABLED", default=False)

# Whether shadow-mode execution is active (SIE runs alongside V2 without
# affecting production state).
SIE_SHADOW_ENABLED: bool = _env_bool("SIE_SHADOW_ENABLED", default=False)

# Whether SIE is the authoritative semantic engine for new conversations.
SIE_AUTHORITY_ENABLED: bool = _env_bool("SIE_AUTHORITY_ENABLED", default=False)

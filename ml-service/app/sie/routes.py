"""SIE API routes.

Exposes the versioned /sie/process-messages endpoint for OpenAPI generation.
The endpoint is gated behind the SIE_ENDPOINT_ENABLED configuration flag and
additionally requires approved stage implementations to be installed before
producing any semantic results.

Until both conditions are met, the endpoint returns HTTP 503 with an explicit
unavailability message. It NEVER fabricates semantic output.
"""

from fastapi import APIRouter, HTTPException

from .config import SIE_ENDPOINT_ENABLED
from .contracts import ProcessRequest, ProcessResult

router = APIRouter(
    prefix="/sie",
    tags=["SIE Pipeline"],
)


def _has_stage_implementations() -> bool:
    """Check whether approved semantic stage implementations are installed.

    Returns True only when concrete implementations of all required stages
    (RetentionAssessor, PropositionExtractor, PacketFormer, CohesionAnalyzer,
    IdentityResolver) are registered and available for use.

    Currently always returns False because no approved stage implementations
    exist yet. This will be updated when semantic algorithm implementations
    are approved and installed.
    """
    return False


@router.post(
    "/process-messages",
    response_model=ProcessResult,
    summary="Process messages through the SIE semantic pipeline",
    description=(
        "Accepts a batch of messages with current graph state and produces "
        "semantic decisions including retention, propositions, packets, and "
        "identity resolutions. Requires approved stage implementations to be "
        "installed and the SIE endpoint to be enabled via configuration."
    ),
    responses={
        503: {
            "description": "SIE pipeline not available",
            "content": {
                "application/json": {
                    "example": {
                        "detail": "SIE pipeline not available: no approved stage implementations installed"
                    }
                }
            },
        }
    },
)
async def process_messages(request: ProcessRequest) -> ProcessResult:
    """Full semantic processing pipeline endpoint.

    This endpoint validates the request and then delegates to the installed
    stage implementations. Until approved implementations are available,
    it fails explicitly with HTTP 503.
    """
    if not SIE_ENDPOINT_ENABLED:
        raise HTTPException(
            status_code=503,
            detail="SIE pipeline not available: endpoint disabled by configuration",
        )

    if not _has_stage_implementations():
        raise HTTPException(
            status_code=503,
            detail="SIE pipeline not available: no approved stage implementations installed",
        )

    # Once stage implementations are installed, this will orchestrate the
    # pipeline. For now, this code path is unreachable due to the above guards.
    raise HTTPException(  # pragma: no cover
        status_code=503,
        detail="SIE pipeline not available: no approved stage implementations installed",
    )

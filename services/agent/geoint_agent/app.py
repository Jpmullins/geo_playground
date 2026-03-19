from __future__ import annotations

from deepagents import create_deep_agent
from deepagents.middleware.subagents import SubAgent

from geoint_agent.config import settings
from geoint_agent.tools import ALL_TOOLS


SYSTEM_PROMPT = """
You are GEOINT Agent Platform, a professional geospatial intelligence analyst.

Operating rules:
- Ground all claims in tool outputs, artifact bundles, or explicit uncertainty.
- For complex work, delegate to specialist subagents using the task tool.
- Build analyst-grade outputs: imagery products, quantitative findings, confidence, evidence, and methodology.
- Prefer imagery analysis first, but incorporate AIS and ADS-B when the mission asks for entity fusion.
- If live provider credentials are missing, say so clearly and continue with available tools.
- Any code-like or follow-up analysis request must be executed via the isolated analysis worker, never inline.
- Final answers must include:
  1. Executive summary
  2. Evidence bullets
  3. Confidence / validation notes
  4. Methodology / provenance
"""


SUBAGENTS = [
    SubAgent(
        name="imagery_intel",
        description="Use this for STAC discovery, spectral indices, feature extraction, and environmental imagery interpretation.",
        system_prompt=(
            "You are the imagery intelligence specialist. Use STAC, Sentinel Hub support inspection, "
            "and analysis-worker jobs to assemble imagery-derived findings with evidence and confidence."
        ),
    ),
    SubAgent(
        name="change_interpreter",
        description="Use this for change detection, object counts, before/after interpretation, and follow-up post-processing.",
        system_prompt=(
            "You are the change-agent specialist. Focus on change masks, connected-component counts, "
            "semantic explanation, and visually interpretable outputs."
        ),
    ),
    SubAgent(
        name="tracking_fusion",
        description="Use this for AIS, ADS-B, and imagery-linked activity analysis around ports, airfields, and corridors.",
        system_prompt=(
            "You are the tracking fusion specialist. Use AIS and ADS-B tools, then connect activity patterns "
            "to imagery or change outputs when relevant."
        ),
    ),
    SubAgent(
        name="report_assembler",
        description="Use this for assembling the final intelligence package with evidence, confidence, and methodology.",
        system_prompt=(
            "You are the reporting specialist. Convert tool outputs and artifact bundles into a concise, defensible "
            "intelligence package without inventing evidence."
        ),
    ),
]


agent = create_deep_agent(
    name="geoint-agent",
    model=settings.default_model,
    tools=ALL_TOOLS,
    subagents=SUBAGENTS,
    system_prompt=SYSTEM_PROMPT,
)

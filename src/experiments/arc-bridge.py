"""Run the unmodified ARC CLI, recording its workflow outcome for the experiment."""
from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
import sys
from urllib.parse import urlparse
from uuid import uuid4


def install_opencode_session_headers() -> None:
    """The opencode Zen/Go gateway rejects requests without a session header."""
    import openai

    session = os.environ.get("ARC_OPENCODE_SESSION") or str(uuid4())

    def headers_for(base_url: str | None) -> dict[str, str]:
        host = urlparse(base_url or os.environ.get("OPENAI_BASE_URL") or "").hostname or ""
        return {"x-opencode-session": session} if host == "opencode.ai" or host.endswith(".opencode.ai") else {}

    for name in ("OpenAI", "AsyncOpenAI"):
        original = getattr(openai, name)

        class SessionClient(original):
            def __init__(self, *args, **kwargs):
                base_url = kwargs.get("base_url")
                headers = dict(kwargs.pop("default_headers", None) or {})
                headers.update(headers_for(base_url))
                super().__init__(*args, **kwargs, default_headers=headers)

        SessionClient.__name__ = name
        SessionClient.__qualname__ = name
        setattr(openai, name, SessionClient)


def main() -> int:
    source, requirements, output, report, port = sys.argv[1:]
    sys.path.insert(0, str(Path(source) / "src"))
    install_opencode_session_headers()
    import main as arc

    original = arc.ARCWorkflowManager.start_compilation

    async def tracked(self, *args, **kwargs):
        result = await original(self, *args, **kwargs)
        temporary = Path(report + ".tmp")
        temporary.write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
        temporary.replace(report)
        return result

    arc.ARCWorkflowManager.start_compilation = tracked
    if os.environ["SHALLOW_REFERENCE_IMAGES"] == "0":
        import core.phases

        async def skip_visual_analysis(requirement_data, *args, **kwargs):
            return requirement_data

        core.phases.analyze_and_attach_visual_references = skip_visual_analysis

    args = arc.build_parser().parse_args([
        "compile", requirements, "-o", output, "--type", "web", "--port", port,
    ])
    return asyncio.run(arc.cmd_compile(args))


if __name__ == "__main__":
    sys.exit(main())

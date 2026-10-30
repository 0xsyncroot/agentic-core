"""Bounded server diagnostics. Never serialize arguments, document cells or frame locals."""
from __future__ import annotations

import os
import re
import traceback

from errors import ToolInputError


def safe_text(value: object, limit: int = 2000) -> str:
    text = str(value)
    # Exceptions from storage/network libraries can include credentials and signed URLs.
    for name, secret in os.environ.items():
        if len(secret) >= 8 and re.search(r"TOKEN|PASSWORD|SECRET|(?:ACCESS|API|ENCRYPTION)_KEY", name, re.I):
            text = text.replace(secret, "[redacted]")
    text = re.sub(r"(?i)Bearer\s+[^\s\"']+", "Bearer [redacted]", text)
    text = re.sub(r"(?i)(https?://)[^\s/@]+:[^\s/@]+@", r"\1[redacted]@", text)
    text = re.sub(r"(?i)(https?://[^\s?\"']+)\?[^\s\"']+", r"\1?[redacted]", text)
    return text[:limit]


def _loggable(error: BaseException) -> dict:
    """The part of an error's text that may reach the log.

    A refusal is written for the model and may quote the document (header_not_matched repeats the
    cells of the rows it read), and an unexpected exception can carry a value out of a cell
    (`KeyError: 'Nội dung'`). Only a refusal that does not echo cells keeps its sentence; the rest
    are located by type, code, row numbers and the traceback instead.
    """
    if not isinstance(error, ToolInputError):
        return {}
    if not error.echoes_cells:
        return {"message": safe_text(error)}
    return {"rows": list(error.rows[:12])} if error.rows else {}


def error_details(error: BaseException) -> dict:
    """Keep the actual raise site and chained cause; never read locals or source lines."""
    causes = []
    seen = set()
    current = error
    while current is not None and id(current) not in seen and len(causes) < 4:
        seen.add(id(current))
        frames = traceback.extract_tb(current.__traceback__, limit=-12)
        detail = {"type": type(current).__name__, **_loggable(current),
                  "traceback": [{"file": safe_text(frame.filename, 300), "line": frame.lineno,
                                 "function": safe_text(frame.name, 100)} for frame in frames]}
        code = getattr(current, "code", None)
        if isinstance(code, (str, int)):
            detail["code"] = safe_text(code, 100) if isinstance(code, str) else code
        causes.append(detail)
        current = current.__cause__ or (None if current.__suppress_context__ else current.__context__)
    return {**causes[0], **({"causes": causes[1:]} if len(causes) > 1 else {})}


def call_context(message: dict) -> dict:
    """Only routing and page coordinates, not arbitrary caller-supplied fields."""
    params = message.get("params")
    params = params if isinstance(params, dict) else {}
    args = params.get("arguments")
    args = args if isinstance(args, dict) else {}
    context = {"rpcId": safe_text(message.get("id"), 128),
               "method": safe_text(message.get("method"), 80)}
    for name in ("documentId", "sheet"):
        if isinstance(args.get(name), str):
            context[name] = safe_text(args[name], 160)
    for name in ("offset", "maxRows", "headerRow"):
        if type(args.get(name)) is int:
            context[name] = args[name]
    return context

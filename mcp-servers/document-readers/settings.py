"""Reads one named setting, honouring the retired names it replaced.

The Python twin of `@0xsyncroot/env-settings` (packages/env-settings), so this service and the
TypeScript backends treat a renamed setting the same way:

- only the current name is set: its value;
- only a retired name is set: that value, plus one line on stderr (the service log) naming the
  current name, once per process and name;
- both hold the same value: the current one, silently;
- both hold different values: `SettingConflict`, and the service does not start.

Values are stripped and an empty value counts as unset. Messages name settings, never values.
"""
from __future__ import annotations

import os
import sys
from collections.abc import Iterable, Mapping

_NOTICED: set[str] = set()


class SettingConflict(RuntimeError):
    """The current name and a retired name disagree."""


def notice_once(key: str, message: str) -> None:
    """One `[settings]` line on stderr per process and key."""
    if key in _NOTICED:
        return
    _NOTICED.add(key)
    print(f"[settings] {message}", file=sys.stderr, flush=True)


def read_setting(name: str, legacy: Iterable[str] = (), environ: Mapping[str, str] | None = None) -> str | None:
    """The setting's stripped value, from `name` or else the first retired name that is set."""
    env = os.environ if environ is None else environ
    current = env.get(name, "").strip()
    retired = list(legacy)
    if current:
        for old in retired:
            value = env.get(old, "").strip()
            if value and value != current:
                raise SettingConflict(f"{name} and its retired name {old} are both set, to different values; keep only {name}")
        return current
    for old in retired:
        value = env.get(old, "").strip()
        if value:
            notice_once(f"retired:{old}:{name}", f"{old} is a retired setting name and is still read for now; rename it to {name}")
            return value
    return None

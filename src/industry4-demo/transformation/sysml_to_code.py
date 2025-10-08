#!/usr/bin/env python3
"""
Translate textual SysML requirements into language-specific stubs.

The script is intentionally lightweight: it parses the curated reqs.sysml file,
emits a canonical JSON artifact for traceability, and mirrors the requirements
into Python, Go, and Node stubs so each service can reference the formal
requirements at runtime or within tests.
"""

from __future__ import annotations

import json
import pathlib
import re
from dataclasses import dataclass, asdict

BASE_DIR = pathlib.Path(__file__).resolve().parents[1]
MODELS_DIR = BASE_DIR / "models"
OUTPUT_DIR = pathlib.Path(__file__).resolve().parent / "out"
OUTPUT_DIR.mkdir(exist_ok=True)


@dataclass
class Requirement:
  """Minimal representation of a SysML requirement."""

  identifier: str
  text: str
  verifies: list[str]

  @staticmethod
  def parse(block: str) -> "Requirement":
    id_match = re.search(r'id\s*=\s*"([^"]+)"', block)
    text_match = re.search(r'text\s*=\s*"([^"]+)"', block)
    verifies_match = re.search(r'verifies\s*=\s*\[([^\]]*)\]', block)

    if not id_match or not text_match:
      raise ValueError(f"Invalid requirement block:\n{block}")

    verifies = (
      [item.strip().strip('"') for item in verifies_match.group(1).split(",") if item.strip()]
      if verifies_match
      else []
    )

    return Requirement(
      identifier=id_match.group(1),
      text=text_match.group(1),
      verifies=verifies,
    )


def parse_requirements(model_path: pathlib.Path) -> list[Requirement]:
  content = model_path.read_text(encoding="utf-8")
  blocks = re.findall(r"requirement\s+\w+\s*{([^}]*)}", content, flags=re.MULTILINE)
  return [Requirement.parse(block) for block in blocks]


def emit_json(requirements: list[Requirement]) -> None:
  data = [asdict(req) for req in requirements]
  json_path = OUTPUT_DIR / "requirements.json"
  json_path.write_text(json.dumps(data, indent=2), encoding="utf-8")


def emit_python(requirements: list[Requirement]) -> None:
  target = BASE_DIR / "services" / "python" / "__generated__" / "requirements.py"
  target.parent.mkdir(parents=True, exist_ok=True)
  mapping_lines = [f'    "{req.identifier}": "{req.text}"' for req in requirements]
  body = "REQUIREMENTS = {\n" + ",\n".join(mapping_lines) + "\n}\n"
  target.write_text(body, encoding="utf-8")


def emit_node(requirements: list[Requirement]) -> None:
  target = BASE_DIR / "services" / "node" / "generated" / "requirements.json"
  target.parent.mkdir(parents=True, exist_ok=True)
  payload = {req.identifier: {"text": req.text, "verifies": req.verifies} for req in requirements}
  target.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def emit_go(requirements: list[Requirement]) -> None:
  target = BASE_DIR / "services" / "go" / "generated" / "requirements.go"
  target.parent.mkdir(parents=True, exist_ok=True)
  lines = [
    'package generated',
    "",
    "// Requirements exports requirements for Go services.",
    "var Requirements = map[string]string{",
  ]
  for req in requirements:
    lines.append(f'\t"{req.identifier}": "{req.text}",')
  lines.append("}")
  target.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> None:
  reqs = parse_requirements(MODELS_DIR / "reqs.sysml")
  emit_json(reqs)
  emit_python(reqs)
  emit_node(reqs)
  emit_go(reqs)
  print(f"Generated artifacts for {len(reqs)} requirements in {OUTPUT_DIR}")


if __name__ == "__main__":
  main()

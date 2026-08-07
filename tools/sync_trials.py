#!/usr/bin/env python3
"""Rebuild data/trials_index.json from a local checkout of respiratorytrials.org.

Autotexts cite trials by acronym. This caches acronym -> slug, year and one-line
summary so that validate.py can fail the build on a trial reference that does
not exist, and so the evidence panel can show what the trial found without a
network call at build time.

    python3 tools/sync_trials.py [--repo ../respiratorytrials]

The cache is committed. Re-run it when the sister site gains trials.
"""

import argparse
import json
import pathlib
import re
import sys

import yaml

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "trials_index.json"


def slugify(value):
    value = re.sub(r"[^\w\s-]", "", str(value).lower())
    return re.sub(r"[\s_-]+", "-", value).strip("-")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", default=str(ROOT.parent / "respiratorytrials"))
    args = parser.parse_args()

    trials_dir = pathlib.Path(args.repo).expanduser().resolve() / "data" / "trials"
    if not trials_dir.is_dir():
        print(f"no trial data at {trials_dir}", file=sys.stderr)
        return 1

    index = {}
    for path in sorted(trials_dir.rglob("*.yaml")):
        record = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        acronym = str(record.get("acronym", "")).strip()
        if not acronym:
            continue
        index[acronym.upper()] = {
            "acronym": acronym,
            "slug": record.get("slug") or slugify(acronym),
            "topic": record.get("topic", ""),
            "year": record.get("year", ""),
            "summary": " ".join(str(record.get("summary", "")).split()),
        }

    OUT.write_text(json.dumps(index, indent=2, ensure_ascii=False, sort_keys=True) + "\n", encoding="utf-8")
    print(f"indexed {len(index)} trials into {OUT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

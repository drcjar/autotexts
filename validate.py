#!/usr/bin/env python3
"""Check the data before it is built. CI gates on this.

Catches the failures that would otherwise reach a clinic letter: a missing
required field, an unknown topic or kind, a trial reference the sister site does
not have, an evidence entry with no source, a paste block that has silently
picked up markdown or a smart quote, or an autotext no one has reviewed.

    python3 validate.py [--strict]

--strict also fails on warnings.
"""

import argparse
import datetime as dt
import re
import sys

import sitelib as lib

# Characters that look right in a browser and wrong in an EPR. Most electronic
# record systems still render Latin-1; a curly quote pasted from here arrives as
# a replacement character in the letter that reaches the GP.
SMART = {
    "‘": "'", "’": "'", "“": '"', "”": '"',
    "–": "-", "—": "-", "…": "...", " ": " ",
}

# Markdown in a paste block is a mistake: it is copied as literal asterisks into
# the notes. Editorial `notes` may use it; `body` may not.
MARKDOWN_IN_BODY = re.compile(r"(\*\*|^\s*[-*+]\s+\*|\[\[)", re.MULTILINE)

# How long before a clinical block should be looked at again.
REVIEW_MONTHS = 18


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--strict", action="store_true")
    args = parser.parse_args()

    errors, warnings = [], []

    site = lib.load_site()
    topics = {t["slug"] for t in site["topics"]}
    kinds = {k["slug"] for k in site["kinds"]}
    trials = lib.load_json(lib.TRIALS_INDEX)
    records = lib.load_autotexts()

    if not records:
        errors.append("no autotexts found in data/autotexts/")

    for group in site["groups"]:
        for slug in group["topics"]:
            if slug not in topics:
                errors.append(f"site.yaml: group {group['name']!r} lists unknown topic {slug!r}")

    listed = {slug for group in site["groups"] for slug in group["topics"]}
    for slug in topics - listed:
        warnings.append(f"site.yaml: topic {slug!r} is in no navigation group")

    seen_slugs, seen_titles = {}, {}
    today = dt.date.today()

    for record in records:
        path = record["_path"]

        for field in lib.REQUIRED:
            if not record.get(field):
                errors.append(f"{path}: missing required field {field!r}")

        if record.get("topic") and record["topic"] not in topics:
            errors.append(f"{path}: unknown topic {record['topic']!r}")
        if record.get("kind") and record["kind"] not in kinds:
            errors.append(f"{path}: unknown kind {record['kind']!r}")

        if record["slug"] in seen_slugs:
            errors.append(f"{path}: duplicate slug {record['slug']!r} (also {seen_slugs[record['slug']]})")
        seen_slugs[record["slug"]] = path

        title = str(record.get("title", "")).strip().lower()
        if title in seen_titles:
            warnings.append(f"{path}: title duplicates {seen_titles[title]}")
        seen_titles[title] = path

        for acronym in record["trials"]:
            if str(acronym).upper() not in trials:
                errors.append(
                    f"{path}: trial {acronym!r} is not on respiratorytrials.org"
                )

        for slug in record["see_also"]:
            if slug not in seen_slugs and slug not in {r["slug"] for r in records}:
                errors.append(f"{path}: see_also {slug!r} is not an autotext")

        for item in record["evidence"]:
            if not item.get("name"):
                errors.append(f"{path}: an evidence entry has no name")
            url = item.get("url", "")
            if url and not url.startswith("https://"):
                errors.append(f"{path}: evidence url {url!r} is not https")

        # A clinical block with no stated basis is exactly what this site exists
        # to stop being normal. Admin blocks are exempt: there is no guideline
        # for a bronchoscopy booking form.
        if record["kind"] not in ("admin", "results") and not (record["evidence"] or record["trials"]):
            warnings.append(f"{path}: no evidence or trials cited")

        # Variants are copied by the same button as the main block, so they are
        # held to exactly the same standard.
        blocks = [("body", record["body"])]
        for variant in record["variants"]:
            if not variant.get("title"):
                errors.append(f"{path}: a variant has no title")
            blocks.append((f"variant {variant.get('title', '?')!r}", variant["body"]))

        for where, body in blocks:
            for char, replacement in SMART.items():
                if char in body:
                    errors.append(
                        f"{path}: {where} contains {char!r} — use {replacement!r}, "
                        f"EPRs mangle it"
                    )
            if MARKDOWN_IN_BODY.search(body):
                errors.append(f"{path}: {where} contains markup — paste blocks are plain text only")
            if "\t" in body:
                errors.append(
                    f"{path}: {where} contains a tab — use spaces, tabs break EPR paste alignment"
                )

            for line in body.split("\n"):
                if len(line) > 110:
                    warnings.append(
                        f"{path}: a {where} line is {len(line)} characters — hard to read in a letter"
                    )
                    break

            unclosed = body.count("[") - body.count("]")
            if unclosed:
                errors.append(f"{path}: unbalanced field brackets in {where} ({unclosed:+d})")

        updated = record.get("updated")
        if not updated:
            warnings.append(f"{path}: no `updated` date")
        else:
            if isinstance(updated, str):
                try:
                    updated = dt.date.fromisoformat(updated)
                except ValueError:
                    errors.append(f"{path}: updated {updated!r} is not an ISO date")
                    updated = None
            if updated and (today - updated).days > REVIEW_MONTHS * 30:
                warnings.append(f"{path}: last reviewed {updated} — due a check against current guidance")
            if updated and updated > today:
                errors.append(f"{path}: updated {updated} is in the future")

    for layer in lib.load_local_layers().values():
        if not layer.get("name"):
            errors.append(f"{layer['_path']}: local layer has no name")
        for block in layer.get("blocks", []):
            if not block.get("title") or not block.get("body"):
                errors.append(f"{layer['_path']}: a block is missing title or body")

    for warning in warnings:
        print(f"warning: {warning}")
    for error in errors:
        print(f"error: {error}", file=sys.stderr)

    print(f"\n{len(records)} autotexts checked: {len(errors)} error(s), {len(warnings)} warning(s)")
    if errors or (args.strict and warnings):
        return 1
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except lib.DataError as exc:
        print(f"error: {exc}", file=sys.stderr)
        raise SystemExit(1)

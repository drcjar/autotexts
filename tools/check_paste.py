#!/usr/bin/env python3
"""Check that every rendered block copies back to exactly its source text.

The site makes one promise: press Copy and your clipboard holds the plain text
in the YAML, with nothing added and nothing lost. The copy button reads
`pre.textContent`, so this reverses the two things that stand between the YAML
and that value - HTML escaping, and the spans that highlight fields - and
compares the result with the source.

Run it against a built site:

    python3 build.py && python3 tools/check_paste.py [--output site]
"""

import argparse
import html
import pathlib
import re
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

import sitelib as lib  # noqa: E402

PRE = re.compile(r'<pre class="paste" id="([^"]+)" tabindex="0">(.*?)</pre>', re.S)
FIELD_SPAN = re.compile(r'<span class="f">(\[[^<]*?\])</span>')


def as_clipboard(rendered):
    """What `pre.textContent` would be for this markup."""
    return html.unescape(FIELD_SPAN.sub(r"\1", rendered))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", default="site")
    args = parser.parse_args()

    root = pathlib.Path(__file__).resolve().parent.parent
    site_dir = root / args.output
    if not site_dir.is_dir():
        print(f"no built site at {site_dir} - run build.py first", file=sys.stderr)
        return 1

    records = {r["slug"]: r for r in lib.load_autotexts()}
    layers = lib.load_local_layers()

    expected = {}
    for slug, record in records.items():
        expected[(f"t/{slug}", "block-main")] = record["body"]
        for variant in record["variants"]:
            key = "block-" + (variant.get("slug") or lib.slugify(variant["title"]))
            expected[(f"t/{slug}", key)] = variant["body"]
    for slug, layer in layers.items():
        for block in layer.get("blocks", []):
            expected[(f"local/{slug}", "local-" + block["slug"])] = block["body"]

    mismatched, missing = [], []
    for (page, block_id), source in sorted(expected.items()):
        path = site_dir / page / "index.html"
        if not path.exists():
            missing.append(f"{page} was not built")
            continue
        blocks = dict(PRE.findall(path.read_text(encoding="utf-8")))
        if block_id not in blocks:
            missing.append(f"{page}: no block {block_id}")
            continue
        if as_clipboard(blocks[block_id]) != source:
            mismatched.append(f"{page}: {block_id} does not copy back to its source")

    for problem in missing + mismatched:
        print(f"error: {problem}", file=sys.stderr)

    print(f"{len(expected)} rendered blocks checked: {len(mismatched) + len(missing)} problem(s)")
    return 1 if (mismatched or missing) else 0


if __name__ == "__main__":
    raise SystemExit(main())

# Respiratory Autotexts

Ready-to-paste text blocks for the respiratory clinic — consultation templates, patient
information, test explainers, results layouts and letters — each one showing the guideline or
trial it rests on.

Sister site to [respiratorytrials.org](https://respiratorytrials.org), and built the same way:
plain YAML, a Python script, no database, no server, no npm.

## Where it came from

In April 2024 Dr Angshu Bhowmik sent a new registrar at the Homerton the auto-texts he used with
his dictation software, with a note saying they were by no means perfect, that he changed them
from time to time, and that if we all helped each other out with good examples of letters this
might be a good thing.

His originals are the seed — the clerking skeleton, the bronchiectasis advice, the sputum
collection instructions, the non-attendance and discharge letters. What has been added is the
sourcing: every clinical block names the national or international guideline behind it, and where
a specific trial is the reason a sentence says what it says, that trial links to its record on
respiratorytrials.org.

## How it works

```
build.py                 generate site/ from data/ + templates/
validate.py              schema, referential integrity and paste-safety checks — CI gates on this
sitelib.py               shared loading, field parsing and defaulting
data/site.yaml           topics, kinds, navigation
data/autotexts/          one YAML file per block, filed by topic
data/local/              organisation-specific overlays (delete the directory to remove them all)
data/trials_index.json   acronym -> slug cache from respiratorytrials.org
templates/               Jinja2 templates
static/                  CSS, JS, favicon
tools/sync_trials.py     rebuild the trial index from a local respiratorytrials checkout
```

```bash
pip install -r requirements.txt
python3 validate.py && python3 build.py
python3 -m http.server -d site 8000
```

## The paste block

Square brackets are fields, left empty on purpose. The convention is Angshu's: Dragon's "Manage
auto-texts" treats `[]` as a stop you jump between with F1 and F2. Where the line does not make it
obvious what goes in the field, the hint is written inside the brackets — it is a prompt to the
person dictating and is copied along with everything else.

What the copy button puts on the clipboard is exactly the plain text in the YAML. The field
highlighting is a `<span>` around the brackets, so `textContent` is byte-identical to the source;
no citations, no attribution line, no formatting travel with it. The evidence panel is deliberately
outside the block.

## Adding a block

```yaml
title: New asthma patient
topic: asthma          # must exist in data/site.yaml
kind: consultation     # consultation | patient-info | test-info | results | letter | admin
summary: One line, shown on cards and in search.
updated: 2026-08-06    # validate warns after 18 months
body: |
  The text that gets pasted. Plain text only.
  Smoking status: []
variants:              # optional: a shorter or alternative form of the same block
  - title: ...
    body: |
      ...
notes: >-              # editorial: how to use it, and why it says what it says.
  Supports **bold** and [[TRIAL]] links.
evidence:
  - name: NICE NG245
    url: https://www.nice.org.uk/guidance/ng245
    note: What this guideline actually says that the block depends on.
trials: [SYGMA 1]      # must exist on respiratorytrials.org
see_also: [asthma-review]
```

`validate.py` fails the build on an unknown topic or kind, a duplicate slug, a trial or `see_also`
that does not exist, an evidence entry with no name, unbalanced brackets, a tab, markdown that has
crept into a paste block, or a smart quote — curly quotes and en dashes arrive in many EPRs as
replacement characters, so they are an error rather than a style preference. It warns on a clinical
block with no evidence cited, and on anything not reviewed for 18 months.

## Editing in a browser

There is a form-based editor at [`/admin/`](https://autotexts.respiratorytrials.org/admin/), running
[Sveltia CMS](https://sveltiacms.app/en/). It edits the YAML files in this repository directly —
there is no separate content database.

Editors **sign in with a Google account**. A small Cloudflare Worker in [`gateway/`](gateway/)
checks the address against a list, then does the GitHub side on their behalf with a GitHub App that
only it holds — nobody needs a GitHub account or a token.

Every save **opens a pull request** rather than committing to `main`, so `validate.py` runs on it and
someone approves the diff before it reaches the site. Format errors show as a failed check; clinical
errors need the human. The gateway enforces this: it moves each save onto its own `edit/…` branch,
refuses any other kind of write, and only lets the editor touch files under `data/autotexts/`. The
editor's name and address go in the commit and the pull request.

**Adding an editor** is adding their Google address to the Worker's `ALLOWED_EMAILS` secret.
Removing them takes effect on their next request. Setup, from nothing, is in
[`gateway/README.md`](gateway/README.md).

Sveltia's button still says **Sign In with GitHub** — its label is fixed — but it opens Google.

After saving, the change is in a pull request, not yet on the site. Until that is merged, reopening
the editor shows the old text, and a second edit to the same block starts from the old text too —
merge first, then edit again.

The editor's form is generated at build time from `data/site.yaml` by `admin_config()` in
`build.py`, so the topic list and the "what it is for" options cannot drift from the ones the site is
built with. Adding a topic to `site.yaml` adds it to the editor. `admin/index.html` is the only
hand-written part, and the Sveltia version in it is pinned deliberately — it is pre-1.0 and minor
releases have made breaking changes.

Two things to expect:

- The first time a block is saved through the editor, its YAML is reformatted by the CMS's own
  serialiser, so the diff will be larger than the change. Harmless — the text itself is unchanged,
  and `tools/check_paste.py` proves it.
- Editing files directly on GitHub still works, and the **Work with Local Repository** button in the
  editor edits your local checkout with no sign-in at all.
- Without `editor.gateway` in `data/site.yaml`, the editor falls back to asking for a GitHub token,
  and then **commits straight to `main`**: Sveltia has no pull-request workflow of its own, and
  silently ignores `publish_mode: editorial_workflow`.

## The local layer

`data/local/*.yaml` holds organisation-specific blocks: phone numbers, booking systems, where to
drop a sample. They are facts about a building rather than about medicine, they go out of date
faster than anything else here, and they render on their own pages with a warning saying so.

Delete `data/local/` and every organisation-specific detail leaves the site in one step. Forking
this for another trust means rewriting that one directory.

## Caveats

Templates, not decisions. Nothing here is approved by any trust, college or society. A template
makes it easy to write a fluent letter about a consultation that did not happen; that risk comes
with the time it saves.

The site holds no patient data and asks for none — you copy from it, and the filling in happens in
your own record system.

Blocks go out of date the moment a guideline moves. Corrections are the most useful thing you can
send.

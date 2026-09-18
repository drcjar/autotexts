# Editor sign-in gateway

A Cloudflare Worker that lets editors sign in to `/admin/` with a Google account. It stands in for
`api.github.com` as far as the editor is concerned:

- **Sign-in.** "Sign in with Google", then the address is checked against `ALLOWED_EMAILS`. The
  editor gets a 12-hour session token; the list is re-checked on every request.
- **Reading.** Requests for this repository are forwarded to GitHub with a token from a GitHub App
  that only the Worker holds.
- **Saving.** The editor's commit to `main` is moved onto a new `edit/<block>-<time>` branch and a
  pull request is opened, with the editor's name and address in both. Any other write, any file
  outside `EDITABLE_PATHS`, and any other repository or branch is refused.

One file, `worker.mjs`, with no dependencies. `node test.mjs` runs its tests with Google and GitHub
mocked out; CI runs them too.

## Setting it up

About half an hour, once. You need a Cloudflare account (the free plan is plenty), a Google account,
and admin on the GitHub repository.

### 1. Deploy the Worker, to get its address

```bash
cd gateway
npx wrangler login
npx wrangler deploy
```

It prints an address like `https://autotexts-editor.<you>.workers.dev`. That is the **gateway URL**
used below. (It will not work yet — it has no secrets.)

### 2. A GitHub App, to do the writing

[github.com/settings/apps/new](https://github.com/settings/apps/new):

- Name: anything, e.g. `autotexts-editor`. Homepage URL: the site.
- Webhook: untick **Active**.
- Repository permissions: **Contents** read and write, **Pull requests** read and write.
  (Metadata read-only is added automatically.)
- Where can it be installed: **Only on this account**.

Create it, then on its page:

- Note the **App ID**.
- **Generate a private key**. GitHub gives it in a format Workers cannot read; convert it:
  `openssl pkcs8 -topk8 -nocrypt -in downloaded.pem -out key.pem`
- **Install App** → Only select repositories → `autotexts`.

### 3. A Google OAuth client, to do the sign-in

In [Google Cloud console](https://console.cloud.google.com/), in a new project:

- **APIs & Services → OAuth consent screen**: External; app name and support email; no extra
  scopes. Publish it (**In production**) — with only name and email requested, Google does not need
  to review it.
- **Credentials → Create credentials → OAuth client ID**: Web application.
  Authorised redirect URI: `<gateway URL>/callback`.

Note the **client ID** and **client secret**.

### 4. Give the Worker its secrets

From `gateway/`:

```bash
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put GITHUB_APP_ID
npx wrangler secret put GITHUB_APP_PRIVATE_KEY < key.pem
openssl rand -base64 48 | npx wrangler secret put SESSION_SECRET
npx wrangler secret put ALLOWED_EMAILS       # e.g. you@gmail.com, colleague@gmail.com
```

Then delete both `.pem` files from your machine; GitHub can issue another key if one is ever needed.

### 5. Point the editor at it

In `data/site.yaml`, under `editor:`, set `gateway:` to the gateway URL and push. Once the site has
rebuilt, `/admin/` → **Sign In with GitHub** opens Google.

### 6. Protect `main` (recommended)

Settings → Rules → add a ruleset for `main`: require a pull request and the **build** check. The
gateway already never writes to `main`, so this is about everyone else — it also closes the old route
of signing in with a personal GitHub token and committing directly.

## Day to day

- **Add or remove an editor:** `npx wrangler secret put ALLOWED_EMAILS` with the new list. Removal is
  immediate.
- **Sign everyone out:** set a new `SESSION_SECRET`.
- **Working on the editor locally:** `SITE_ORIGINS` includes `http://localhost:8000`, so
  `python3 build.py && python3 -m http.server -d site 8000` signs in through the deployed gateway.
- **If the editor says "Gateway error":** `npx wrangler tail` shows the Worker's log live.

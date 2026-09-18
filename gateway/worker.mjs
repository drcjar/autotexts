// Sign-in gateway for the browser editor at /admin/.
//
// Sveltia CMS only knows how to talk to GitHub, and GitHub only knows GitHub
// accounts. This Worker sits between them so that an editor can sign in with a
// Google account instead:
//
//   1. /auth and /callback run "Sign in with Google", check the address against
//      ALLOWED_EMAILS, and hand the editor a short-lived session token using the
//      popup handshake Sveltia already speaks.
//   2. /api/v3/* and /api/graphql stand in for api.github.com. Each request is
//      checked against the session, then forwarded with a GitHub App token that
//      only this Worker holds. Editors never see a GitHub credential.
//   3. The one write Sveltia makes - a createCommitOnBranch mutation aimed at
//      main - is moved onto a fresh branch and a pull request is opened for it,
//      so validate.py runs and a second person reads the diff before anything
//      reaches the site. Nothing an editor does can write to main directly.
//
// No dependencies and no build step: `wrangler deploy` uploads this file as is.
// Setup is in gateway/README.md.

const GITHUB_API = "https://api.github.com";
const SESSION_HOURS = 12;
const PROVIDER = "github"; // what Sveltia calls the backend in its handshake

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: cors ? 204 : 403, headers: cors || {} });
    }

    try {
      if (url.pathname === "/auth") return startSignIn(url, env);
      if (url.pathname === "/callback") return await finishSignIn(request, url, env);
      if (url.pathname === "/") return text("Sign-in gateway for the autotexts editor.", 200);

      const api = url.pathname.match(/^\/api(\/v3(\/.*)?|\/graphql)$/);
      if (!api) return text("Not found", 404);

      const session = await readSession(request, env);
      if (!session) return json({ message: "Bad credentials" }, 401, cors);

      const response =
        api[1] === "/graphql"
          ? await graphql(request, session, env)
          : await rest(request, api[2] || "/", url.search, session, env);
      return withHeaders(response, cors);
    } catch (err) {
      console.error(err);
      return json({ message: err.expose ? err.message : "Gateway error" }, err.status || 500, cors);
    }
  },
};

// --- Sign in with Google ------------------------------------------------------

function startSignIn(url, env) {
  if (url.searchParams.get("provider") !== PROVIDER) return text("Unknown provider", 400);
  const state = randomToken();
  const google = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  google.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: `${url.origin}/callback`,
    response_type: "code",
    scope: "openid email profile",
    state,
    prompt: "select_account",
  });
  return new Response(null, {
    status: 302,
    headers: {
      Location: google.toString(),
      "Set-Cookie": `oauth_state=${state}; Path=/callback; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
    },
  });
}

async function finishSignIn(request, url, env) {
  const fail = (message) => handshakePage(env, { error: message });

  const state = url.searchParams.get("state");
  const cookie = (request.headers.get("Cookie") || "").match(/(?:^|;\s*)oauth_state=([^;]+)/);
  if (!state || !cookie || cookie[1] !== state) return fail("The sign-in link expired. Close this window and try again.");
  if (url.searchParams.get("error")) return fail("Sign-in was cancelled.");

  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: url.searchParams.get("code") || "",
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: `${url.origin}/callback`,
      grant_type: "authorization_code",
    }),
  });
  if (!tokenResponse.ok) return fail("Google did not accept the sign-in. Try again.");
  const { id_token: idToken } = await tokenResponse.json();

  // The ID token came straight from Google's token endpoint over TLS, so its
  // signature does not need checking (OpenID Connect Core 3.1.3.7); the claims do.
  const claims = decodeJwtPayload(idToken);
  const issuers = ["accounts.google.com", "https://accounts.google.com"];
  if (!claims || !issuers.includes(claims.iss) || claims.aud !== env.GOOGLE_CLIENT_ID || claims.exp * 1000 < Date.now()) {
    return fail("Google returned an identity this gateway could not check.");
  }
  const email = String(claims.email || "").toLowerCase();
  if (!claims.email_verified) return fail(`${email} has not been verified with Google.`);
  if (!allowedEmails(env).has(email)) {
    return fail(`${email} is not on the list of editors. Ask whoever runs the site to add it.`);
  }

  const token = await signSession(env, {
    email,
    name: claims.name || email,
    picture: claims.picture || "",
    exp: Date.now() + SESSION_HOURS * 3600 * 1000,
  });
  return handshakePage(env, { token, provider: PROVIDER });
}

// The popup protocol Sveltia (and Decap before it) uses: announce ourselves,
// wait for the editor window to answer from an origin we trust, and only then
// post the result to that origin - so the token cannot land anywhere else.
function handshakePage(env, result) {
  const status = result.error ? "error" : "success";
  const message = `authorization:${PROVIDER}:${status}:${JSON.stringify(result)}`;
  const origins = siteOrigins(env);
  const body = `<!doctype html><meta charset="utf-8"><title>Signing in</title>
<body style="font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem">
<p id="m">${escapeHtml(result.error || "Signed in. This window will close.")}</p>
<script>
  var origins = ${JSON.stringify(origins)};
  var message = ${JSON.stringify(message)};
  window.addEventListener("message", function (e) {
    if (e.data !== "authorizing:${PROVIDER}" || origins.indexOf(e.origin) < 0) return;
    window.opener.postMessage(message, e.origin);
  });
  if (window.opener) {
    origins.forEach(function (o) { window.opener.postMessage("authorizing:${PROVIDER}", o); });
  } else {
    document.getElementById("m").textContent += " Open the editor at /admin/ and sign in from there.";
  }
</script>`;
  return new Response(body, {
    status: result.error ? 403 : 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Set-Cookie": "oauth_state=; Path=/callback; Max-Age=0",
    },
  });
}

// --- Sessions -------------------------------------------------------------------

async function signSession(env, payload) {
  const body = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  return `${body}.${await hmac(env, body)}`;
}

async function readSession(request, env) {
  const header = request.headers.get("Authorization") || "";
  const token = header.replace(/^(token|bearer)\s+/i, "");
  const [body, sig] = token.split(".");
  if (!body || !sig || !timingSafeEqual(sig, await hmac(env, body))) return null;
  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(unb64url(body)));
  } catch {
    return null;
  }
  // Re-checked on every request, so removing someone from ALLOWED_EMAILS takes
  // effect immediately rather than when their session runs out.
  if (!payload.exp || payload.exp < Date.now() || !allowedEmails(env).has(payload.email)) return null;
  return payload;
}

async function hmac(env, data) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.SESSION_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data))));
}

// --- REST -----------------------------------------------------------------------

async function rest(request, path, search, session, env) {
  const repo = `/repos/${env.GITHUB_REPO}`;

  // Sveltia asks GitHub who is signed in and whether they may edit the
  // repository. The answers come from the Google session, not from GitHub.
  if (request.method === "GET" && path === "/user") {
    return json({
      id: await numericId(session.email),
      login: session.email,
      name: session.name,
      email: session.email,
      avatar_url: session.picture,
      html_url: `mailto:${session.email}`,
    });
  }
  if (request.method === "GET" && path.startsWith(`${repo}/collaborators/`)) {
    const login = decodeURIComponent(path.slice(`${repo}/collaborators/`.length));
    return new Response(null, { status: login === session.email ? 204 : 404 });
  }

  const readable = request.method === "GET" && (path === repo || path.startsWith(`${repo}/`));
  // Uploading a blob writes nothing to any branch; it only matters once a
  // commit refers to it, and commits go through graphql() below.
  const blob = request.method === "POST" && path === `${repo}/git/blobs`;
  if (!readable && !blob) return json({ message: "Not allowed through the editor gateway" }, 403);

  return github(env, path + search, {
    method: request.method,
    headers: { Accept: request.headers.get("Accept") || "application/vnd.github+json" },
    body: blob ? await request.text() : undefined,
  });
}

// --- GraphQL --------------------------------------------------------------------

async function graphql(request, session, env) {
  if (request.method !== "POST") return json({ message: "Method not allowed" }, 405);
  const { query, variables = {} } = await request.json();
  const shape = String(query || "").replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/\s+/g, " ").trim();

  if (!/\b(mutation|subscription)\b/.test(shape)) {
    return github(env, "/graphql", { method: "POST", body: JSON.stringify({ query, variables }) });
  }
  if (!COMMIT_MUTATION.test(shape)) return json({ message: "Only saving a block is allowed through the editor gateway" }, 403);
  return commitAsPullRequest(query, variables.input, session, env);
}

// Exactly the mutation Sveltia sends when it saves (string literals blanked):
// one createCommitOnBranch, taking all of its input from $input, selecting
// nothing but the commit id, its date and the new file ids.
const COMMIT_MUTATION =
  /^mutation ?\( ?\$input ?: ?CreateCommitOnBranchInput! ?\) ?\{ ?createCommitOnBranch ?\( ?input ?: ?\$input ?\) ?\{ ?commit ?\{ ?oid committedDate( file_\d+ ?: ?file ?\( ?path ?: ?"" ?\) ?\{ ?oid ?\})* ?\} ?\} ?\}$/;

async function commitAsPullRequest(query, input, session, env) {
  const base = env.BASE_BRANCH || "main";
  if (!input || input.branch?.repositoryNameWithOwner !== env.GITHUB_REPO || input.branch?.branchName !== base) {
    return json({ message: "The editor is pointed at a different repository or branch from the gateway" }, 403);
  }
  if (!/^[0-9a-f]{40}$/.test(input.expectedHeadOid || "")) return json({ message: "Missing expectedHeadOid" }, 400);

  const additions = input.fileChanges?.additions || [];
  const deletions = input.fileChanges?.deletions || [];
  const paths = [...additions, ...deletions].map((change) => change.path);
  const allowed = (env.EDITABLE_PATHS || "data/autotexts/").split(",").map((p) => p.trim()).filter(Boolean);
  const outside = paths.filter(
    (p) => typeof p !== "string" || p.split("/").includes("..") || !allowed.some((prefix) => p.startsWith(prefix)),
  );
  if (!paths.length || outside.length) {
    return json({ message: `The editor may only change files under ${allowed.join(", ")}` }, 403);
  }

  const headline = String(input.message?.headline || "Edit from the browser editor").slice(0, 200);
  const who = `${session.name} <${session.email}>`;
  const branch = branchName(paths[0]);

  const ref = await github(env, `/repos/${env.GITHUB_REPO}/git/refs`, {
    method: "POST",
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: input.expectedHeadOid }),
  });
  if (!ref.ok) return ref;

  const committed = await github(env, "/graphql", {
    method: "POST",
    body: JSON.stringify({
      query,
      variables: {
        input: {
          ...input,
          branch: { repositoryNameWithOwner: env.GITHUB_REPO, branchName: branch },
          message: {
            headline,
            body: `Edited in the browser editor by ${who}.\n\nCo-authored-by: ${who}`,
          },
        },
      },
    }),
  });
  const result = await committed.json();
  if (!committed.ok || result.errors) {
    await github(env, `/repos/${env.GITHUB_REPO}/git/refs/heads/${branch}`, { method: "DELETE" });
    return json(result, committed.status);
  }

  const pr = await github(env, `/repos/${env.GITHUB_REPO}/pulls`, {
    method: "POST",
    body: JSON.stringify({
      title: headline,
      head: branch,
      base,
      body: [
        `Opened from the browser editor by **${session.name}** (${session.email}).`,
        "",
        ...paths.map((p) => `- \`${p}\``),
        "",
        "The validate check has to pass, and someone other than the editor should read the diff before this is merged.",
      ].join("\n"),
    }),
  });
  if (!pr.ok) {
    const detail = await pr.text();
    return json({ errors: [{ message: `Saved to branch ${branch}, but the pull request could not be opened: ${detail}` }] });
  }
  return json(result);
}

function branchName(path) {
  const stem = path.split("/").pop().replace(/\.[^.]+$/, "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 40);
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  return `edit/${stem || "block"}-${stamp}-${randomToken().slice(0, 4)}`;
}

// --- GitHub App -----------------------------------------------------------------

let installationToken = null; // { token, expires } - reused across requests while it lasts

async function github(env, path, { method = "GET", headers = {}, body } = {}) {
  return fetch(GITHUB_API + path, {
    method,
    body,
    headers: {
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      ...headers,
      Authorization: `Bearer ${await appToken(env)}`,
      "User-Agent": "autotexts-editor-gateway",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
}

async function appToken(env) {
  if (installationToken && installationToken.expires - Date.now() > 5 * 60 * 1000) return installationToken.token;

  const jwt = await appJwt(env);
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${jwt}`,
    "User-Agent": "autotexts-editor-gateway",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const install = await fetch(`${GITHUB_API}/repos/${env.GITHUB_REPO}/installation`, { headers });
  if (!install.ok) throw exposed(`The GitHub App is not installed on ${env.GITHUB_REPO}`, 502);
  const { id } = await install.json();

  // Narrower than the App itself: this repository, and only what saving needs.
  const minted = await fetch(`${GITHUB_API}/app/installations/${id}/access_tokens`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      repositories: [env.GITHUB_REPO.split("/")[1]],
      permissions: { contents: "write", pull_requests: "write", metadata: "read" },
    }),
  });
  if (!minted.ok) throw exposed("GitHub would not issue a token for the editor", 502);
  const { token, expires_at: expiresAt } = await minted.json();
  installationToken = { token, expires: Date.parse(expiresAt) };
  return token;
}

async function appJwt(env) {
  const pem = env.GITHUB_APP_PRIVATE_KEY;
  if (!pem.includes("BEGIN PRIVATE KEY")) {
    throw exposed("GITHUB_APP_PRIVATE_KEY must be PKCS#8 - see gateway/README.md", 500);
  }
  const der = Uint8Array.from(atob(pem.replace(/-----[^-]+-----|\s/g, "")), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const now = Math.floor(Date.now() / 1000);
  const encode = (obj) => b64url(new TextEncoder().encode(JSON.stringify(obj)));
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: now - 60, exp: now + 540, iss: env.GITHUB_APP_ID })}`;
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  return `${unsigned}.${b64url(new Uint8Array(sig))}`;
}

// --- Helpers --------------------------------------------------------------------

function siteOrigins(env) {
  return (env.SITE_ORIGINS || "").split(",").map((o) => o.trim()).filter(Boolean);
}

function allowedEmails(env) {
  return new Set((env.ALLOWED_EMAILS || "").split(/[\s,]+/).map((e) => e.trim().toLowerCase()).filter(Boolean));
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  if (!origin || !siteOrigins(env).includes(origin)) return null;
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function withHeaders(response, extra) {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(extra || {})) headers.set(k, v);
  // The body was already decompressed by fetch(); don't claim otherwise.
  headers.delete("Content-Encoding");
  headers.delete("Content-Length");
  return new Response(response.body, { status: response.status, headers });
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...(headers || {}) },
  });
}

function text(body, status) {
  return new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

function exposed(message, status) {
  return Object.assign(new Error(message), { expose: true, status });
}

function decodeJwtPayload(jwt) {
  try {
    return JSON.parse(new TextDecoder().decode(unb64url(String(jwt).split(".")[1])));
  } catch {
    return null;
  }
}

async function numericId(email) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(email)));
  return new DataView(digest.buffer).getUint32(0);
}

function randomToken() {
  return b64url(crypto.getRandomValues(new Uint8Array(24)));
}

function b64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64url(s) {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export const _test = { COMMIT_MUTATION };

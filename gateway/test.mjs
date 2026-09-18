// Tests for the editor gateway, with Google and GitHub mocked out.
// Run with:  node gateway/test.mjs   (Node 20+, no dependencies)
import worker, { _test } from "./worker.mjs";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const env = {
  GITHUB_REPO: "drcjar/autotexts", BASE_BRANCH: "main",
  SITE_ORIGINS: "https://autotexts.respiratorytrials.org,http://localhost:8000",
  EDITABLE_PATHS: "data/autotexts/",
  GOOGLE_CLIENT_ID: "cid.apps.googleusercontent.com", GOOGLE_CLIENT_SECRET: "sec",
  GITHUB_APP_ID: "123", GITHUB_APP_PRIVATE_KEY: privateKey,
  SESSION_SECRET: "s3cret-s3cret", ALLOWED_EMAILS: "Editor@gmail.com, other@gmail.com",
};
const W = "https://gw.example.workers.dev";
const calls = [];
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
let idClaims = { iss: "https://accounts.google.com", aud: env.GOOGLE_CLIENT_ID, exp: Date.now()/1000+3600, email: "editor@gmail.com", email_verified: true, name: "Ed Itor", picture: "p" };
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url); const body = init.body ? String(init.body) : "";
  calls.push({ method: init.method || "GET", path: u.pathname, body, auth: init.headers?.Authorization });
  const J = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "Content-Type": "application/json" } });
  if (u.host === "oauth2.googleapis.com") return J({ id_token: `x.${b64(idClaims)}.y` });
  if (u.pathname === "/repos/drcjar/autotexts/installation") return J({ id: 9 });
  if (u.pathname === "/app/installations/9/access_tokens") return J({ token: "ghs_inst", expires_at: new Date(Date.now()+3600e3).toISOString() });
  if (u.pathname === "/graphql") {
    const q = JSON.parse(body);
    if (q.query.includes("createCommitOnBranch")) return J({ data: { createCommitOnBranch: { commit: { oid: "c".repeat(40), committedDate: "2026-09-18T00:00:00Z", file_0: { oid: "f" } } } } });
    return J({ data: { repository: { ok: true } } });
  }
  if (u.pathname === "/repos/drcjar/autotexts/git/refs") return J({}, 201);
  if (u.pathname === "/repos/drcjar/autotexts/pulls") return J({ number: 5 }, 201);
  return J({ path: u.pathname });
};
const req = (path, init = {}) => worker.fetch(new Request(W + path, init), env);

// sign-in start
let r = await req("/auth?provider=github&site_id=x&scope=repo,user");
assert.equal(r.status, 302);
const state = new URL(r.headers.get("Location")).searchParams.get("state");
assert.ok(r.headers.get("Location").startsWith("https://accounts.google.com/"));
// callback with bad state
r = await req(`/callback?code=c&state=nope`, { headers: { Cookie: `oauth_state=${state}` } });
assert.equal(r.status, 403);
// good callback
r = await req(`/callback?code=c&state=${state}`, { headers: { Cookie: `oauth_state=${state}` } });
let html = await r.text(); assert.equal(r.status, 200, html);
const msg = JSON.parse(html.match(/var message = (".*");/)[1]);
assert.ok(msg.startsWith("authorization:github:success:"));
const token = JSON.parse(msg.slice("authorization:github:success:".length)).token;
// disallowed email
idClaims = { ...idClaims, email: "stranger@gmail.com" };
r = await req(`/callback?code=c&state=${state}`, { headers: { Cookie: `oauth_state=${state}` } });
assert.equal(r.status, 403); assert.match(await r.text(), /not on the list/);
idClaims = { ...idClaims, email: "editor@gmail.com", aud: "evil" };
r = await req(`/callback?code=c&state=${state}`, { headers: { Cookie: `oauth_state=${state}` } });
assert.equal(r.status, 403);

const H = { Authorization: `token ${token}`, Origin: "https://autotexts.respiratorytrials.org" };
// no / bad token
assert.equal((await req("/api/v3/user")).status, 401);
assert.equal((await req("/api/v3/user", { headers: { Authorization: "token " + token.slice(0,-2) + "xx" } })).status, 401);
// revocation: removed from allowlist
{ const e2 = { ...env, ALLOWED_EMAILS: "other@gmail.com" }; assert.equal((await worker.fetch(new Request(W+"/api/v3/user",{headers:H}), e2)).status, 401); }
// preflight
r = await req("/api/graphql", { method: "OPTIONS", headers: { Origin: "https://autotexts.respiratorytrials.org" } });
assert.equal(r.status, 204); assert.equal(r.headers.get("Access-Control-Allow-Origin"), "https://autotexts.respiratorytrials.org");
assert.equal((await req("/api/graphql", { method: "OPTIONS", headers: { Origin: "https://evil.com" } })).status, 403);
// user
r = await req("/api/v3/user", { headers: H }); const user = await r.json();
assert.equal(user.login, "editor@gmail.com"); assert.equal(r.headers.get("Access-Control-Allow-Origin"), H.Origin);
// collaborator check exactly as Sveltia sends it
assert.equal((await req(`/api/v3/repos/drcjar/autotexts/collaborators/${encodeURIComponent(user.login)}`, { headers: H })).status, 204);
assert.equal((await req(`/api/v3/repos/drcjar/autotexts/collaborators/someone`, { headers: H })).status, 404);
// reads pass through, with the app token
r = await req("/api/v3/repos/drcjar/autotexts/git/trees/main?recursive=1", { headers: H });
assert.equal(r.status, 200); assert.equal(calls.at(-1).auth, "Bearer ghs_inst"); assert.equal(calls.at(-1).path, "/repos/drcjar/autotexts/git/trees/main");
// forbidden REST
assert.equal((await req("/api/v3/repos/drcjar/other", { headers: H })).status, 403);
assert.equal((await req("/api/v3/repos/drcjar/autotexts/git/refs/heads/main", { method: "POST", headers: H, body: "{}" })).status, 403);
assert.equal((await req("/api/v3/repos/drcjar/autotexts/dispatches", { method: "POST", headers: H, body: "{}" })).status, 403);

// graphql read
const gq = (query, variables) => req("/api/graphql", { method: "POST", headers: H, body: JSON.stringify({ query, variables }) });
r = await gq("query($owner: String!) { repository(owner: $owner, name: \"x\") { id } }", { owner: "drcjar" });
assert.equal(r.status, 200);
// other mutations refused
for (const q of ["mutation { deleteRef(input:{refId:\"x\"}) { clientMutationId } }",
  "query { viewer { login } } mutation { deleteRef(input:{refId:\"x\"}) { clientMutationId } }",
  "mutation($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { commit { oid committedDate } } x: mergePullRequest(input:{pullRequestId:\"1\"}) { clientMutationId } }"]) {
  assert.equal((await gq(q, {})).status, 403, q);
}
// the exact mutation Sveltia sends (after its \n\s* -> ' ' collapse)
const paths = ["data/autotexts/asthma/new-asthma-patient.yaml"];
const sveltia = `
    mutation($input: CreateCommitOnBranchInput!) {
      createCommitOnBranch(input: $input) {
        commit {
          oid
          committedDate
          ${paths.map((e,t)=>`file_${t}: file(path: ${JSON.stringify(e)}) { oid }`).join(" ")}
        }
      }
    }
  `.replace(/\n\s*/g, " ");
const input = { branch: { repositoryNameWithOwner: "drcjar/autotexts", branchName: "main" }, expectedHeadOid: "a".repeat(40),
  fileChanges: { additions: [{ path: paths[0], contents: "eA==" }], deletions: [] }, message: { headline: "Update Asthma block “x”" } };
calls.length = 0;
r = await gq(sveltia, { input });
const out = await r.json(); assert.equal(r.status, 200, JSON.stringify(out));
assert.equal(out.data.createCommitOnBranch.commit.oid, "c".repeat(40));
const [ref, commit, pr] = calls.filter(c => !c.path.includes("installation"));
assert.equal(ref.path, "/repos/drcjar/autotexts/git/refs");
const branch = JSON.parse(ref.body).ref.replace("refs/heads/", ""); assert.match(branch, /^edit\/new-asthma-patient-\d{8}-\d{6}-/);
const ci = JSON.parse(commit.body).variables.input;
assert.equal(ci.branch.branchName, branch); assert.match(ci.message.body, /Co-authored-by: Ed Itor <editor@gmail.com>/);
assert.equal(JSON.parse(pr.body).head, branch); assert.equal(JSON.parse(pr.body).base, "main");
// with no file_N (deletion only) also matches
const del = sveltia.replace(/file_0[^}]*\}/, "");
r = await gq(del, { input: { ...input, fileChanges: { additions: [], deletions: [{ path: paths[0] }] } } }); assert.equal(r.status, 200);
// path outside, traversal, wrong branch
for (const bad of [
  { ...input, fileChanges: { additions: [{ path: ".github/workflows/deploy.yml", contents: "" }] } },
  { ...input, fileChanges: { additions: [{ path: "data/autotexts/../../build.py", contents: "" }] } },
  { ...input, branch: { ...input.branch, branchName: "other" } },
  { ...input, branch: { ...input.branch, repositoryNameWithOwner: "x/y" } },
]) assert.equal((await gq(sveltia, { input: bad })).status, 403);
// string containing braces/mutation words in path doesn't confuse the shape check
assert.ok(_test.COMMIT_MUTATION.test(`mutation($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { commit { oid committedDate file_0: file(path: "") { oid } file_1: file(path: "") { oid } } } }`));
console.log("all gateway tests passed");

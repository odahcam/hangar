// Remote control end to end on one machine: the relay (cloud/, under wrangler dev), a stand-in auth.odahcam.com that
// signs real tokens, and two Hangars with identities of their own. The first roots the account's device chain, the
// second pairs with a code, and then one drives the other through the relay.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { makeWorld, addSession, startServer, cleanup } = require("./helpers");

const CLOUD = path.join(__dirname, "..", "cloud");
const skip = !fs.existsSync(path.join(CLOUD, "node_modules", "wrangler")) && "run npm ci in cloud/ first";

// The same throwaway key as cloud/test/keys.ts.
const JWK = { crv: "Ed25519", d: "MMzR2wrhX4eTh9-w9B4ixJah0wVK1Nfc71Aw-ZnYM-Y", x: "NJwQUDRqiQgtgG7DCQ8gpi3P2-EfBpJkuMQEUJGpCf8", kty: "OKP" };
const JWKS = { keys: [{ crv: "Ed25519", x: JWK.x, kty: "OKP", kid: "test", alg: "EdDSA", use: "sig" }] };
const AUD = "https://hangar.odahcam.com";
const b64 = (s) => Buffer.from(s).toString("base64url");

let issuer, issuerUrl, relay, relayUrl, relayState;
const worlds = [], servers = [];
// A fresh account each run: the relay's storage would otherwise remember the last run's chain.
const SUB = `user-${crypto.randomUUID()}`;

function jwt(claims) {
  const head = b64(JSON.stringify({ alg: "EdDSA", kid: "test" }));
  const body = b64(JSON.stringify(claims));
  const key = crypto.createPrivateKey({ key: JWK, format: "jwk" });
  return `${head}.${body}.${crypto.sign(null, Buffer.from(`${head}.${body}`), key).toString("base64url")}`;
}

async function freePort() {
  const s = http.createServer().listen(0, "127.0.0.1");
  await new Promise((r) => s.once("listening", r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

before(async () => {
  if (skip) return;
  issuer = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const now = Math.floor(Date.now() / 1000);
      if (req.url === "/api/auth/oauth2/token") {
        const access = jwt({ iss: issuerUrl, aud: [AUD], azp: "hangar", sub: SUB, iat: now, exp: now + 3600 });
        res.end(JSON.stringify({ access_token: access, refresh_token: crypto.randomUUID(), token_type: "Bearer" }));
      } else if (req.url === "/api/oauth2/refresh-status") {
        res.end(JSON.stringify({ status: "current" }));
      } else {
        res.statusCode = 404;
        res.end("{}");
      }
    });
  }).listen(0, "127.0.0.1");
  await new Promise((r) => issuer.once("listening", r));
  issuerUrl = `http://127.0.0.1:${issuer.address().port}`;

  const port = await freePort();
  relayUrl = `ws://127.0.0.1:${port}/v1/connect`;
  const vars = { ISSUER: issuerUrl, JWKS: JSON.stringify(JWKS), ALLOWED_SUBS: "*" };
  relayState = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "hangar-relay-"));
  relay = spawn("npx", ["wrangler", "dev", "--local", "--ip", "127.0.0.1", "--port", String(port), "--show-interactive-dev-session=false", "--persist-to", relayState,
    ...Object.entries(vars).flatMap(([k, v]) => ["--var", `${k}:${v}`])], { cwd: CLOUD, stdio: ["ignore", "pipe", "pipe"], detached: true });
  let log = "";
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("relay did not start:\n" + log)), 60000);
    const on = (d) => { log += d; if (/Ready on/.test(log)) { clearTimeout(t); resolve(); } };
    relay.stdout.on("data", on);
    relay.stderr.on("data", on);
    relay.on("exit", (c) => { clearTimeout(t); reject(new Error(`relay exited ${c}:\n${log}`)); });
  });
});

after(async () => {
  for (const s of servers) await s.stop();
  for (const w of worlds) cleanup(w);
  if (relay) { relay.removeAllListeners("exit"); try { process.kill(-relay.pid, "SIGKILL"); } catch {} }
  if (relayState) fs.rmSync(relayState, { recursive: true, force: true });
  issuer?.close();
});

async function hangar() {
  const w = makeWorld();
  worlds.push(w);
  const secrets = fs.mkdtempSync(path.join(w.root, "secrets-"));
  const srv = await startServer(w, { HANGAR_TEST_CLOUD: "1", HANGAR_RELAY_URL: relayUrl, HANGAR_AUTH_ISSUER: issuerUrl, HANGAR_SECRETS_DIR: secrets });
  servers.push(srv);
  return { w, srv };
}

async function signIn(srv) {
  const { url } = (await srv.api("POST", "/api/cloud/login")).json;
  const state = new URL(url).searchParams.get("state");
  const cb = `hangar://auth/callback?code=c0de&state=${state}&iss=${encodeURIComponent(issuerUrl)}`;
  assert.deepEqual((await srv.api("POST", "/api/cloud/callback", { url: cb })).json, { ok: true });
}

async function until(srv, pred, what) {
  for (let i = 0; i < 150; i++) {
    const s = (await srv.api("GET", "/api/cloud")).json;
    if (pred(s)) return s;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out waiting for ${what}: ${JSON.stringify((await srv.api("GET", "/api/cloud")).json)}`);
}

test("the first machine roots the chain, the second pairs with a code, and one drives the other", { skip, timeout: 120000 }, async () => {
  const a = await hangar();
  const b = await hangar();
  const session = addSession(b.w, { turns: [{ user: "on b" }] });

  await signIn(a.srv);
  const sa = await until(a.srv, (s) => s.trust?.state === "member", "a to root the chain");
  assert.equal(sa.machines.length, 1);

  await signIn(b.srv);
  await until(b.srv, (s) => s.trust?.state === "not_paired", "b to see a chain it isn't in");

  // A wrong code first: refused, and b stays out.
  const { code } = (await a.srv.api("POST", "/api/cloud/offer")).json;
  const wrong = code === "000000" ? "111111" : "000000";
  await b.srv.api("POST", "/api/cloud/join", { code: wrong });
  await until(b.srv, (s) => !s.joining, "the wrong code to be refused");
  assert.equal((await b.srv.api("GET", "/api/cloud")).json.trust.state, "not_paired");

  await b.srv.api("POST", "/api/cloud/join", { code });
  const sb = await until(b.srv, (s) => s.trust?.state === "member", "b to be paired");
  assert.equal(sb.machines.length, 2);
  await until(a.srv, (s) => s.machines.length === 2 && s.machines.every((m) => m.online), "a to see b online");

  // b hasn't allowed remote control yet.
  const call = (method, p, body) => a.srv.api("POST", "/api/cloud/call", { device: sb.device, method, path: p, body });
  assert.deepEqual((await call("GET", "/api/sessions")).json, { error: "remote_off" });
  await b.srv.api("PATCH", "/api/remote", { enabled: true });
  const list = (await call("GET", "/api/sessions")).json;
  assert.deepEqual(list.map((s) => s.id), [session.id]);
  assert.equal((await call("PATCH", `/api/session/${session.id}`, { note: "from a" })).status, 200);
  assert.equal((await b.srv.session(session.id)).note, "from a");
  assert.deepEqual((await call("POST", "/api/classify")).json, { error: "remote_forbidden" });
  // b logged it under a's device key.
  const { log } = (await b.srv.api("GET", "/api/remote")).json;
  assert.deepEqual(log.map((e) => [e.device, e.method]), [[sa.device, "PATCH"]]);
});

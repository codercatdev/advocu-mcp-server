import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { expect, test } from "@playwright/test";
import { makeSignature } from "better-auth/crypto";
import { getPlatformProxy, unstable_dev, unstable_splitSqlQuery } from "wrangler";
import { type HostedEnv, createAuth } from "../src/hosted/auth.js";
import { loadCredentials, validateCredentials } from "../src/hosted/credentials.js";
import { UnifiedActivityReportingServer } from "../src/unifiedServer.js";

test.describe.configure({ mode: "serial", timeout: 120000 });

let worker: Awaited<ReturnType<typeof unstable_dev>>;
let proxy: Awaited<ReturnType<typeof getPlatformProxy<HostedEnv>>>;
let directory: string;
let origin: string;
const secret = randomBytes(32).toString("base64");
const encryptionKey = randomBytes(32).toString("base64");
const cookies: Record<string, string> = {};
const tokens: Record<string, string> = {};
const grants: Record<string, { access_token: string; refresh_token: string; clientId: string }> = {};

async function request(path: string, options: RequestInit = {}) {
  return fetch(`${origin}${path}`, { ...options, redirect: "manual" });
}

function jsonHeaders(user: string) {
  return { Origin: origin, Cookie: cookies[user], "Content-Type": "application/json" };
}

async function authorize(user: string, scope = "mcp offline_access") {
  const registration = await request("/api/auth/oauth2/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: `Test ${user}`,
      redirect_uris: ["http://localhost:9911/callback"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope,
    }),
  });
  expect(registration.status, await registration.clone().text()).toBe(201);
  const client = await registration.json();
  const verifier = randomBytes(32).toString("base64url");
  const query = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: "http://localhost:9911/callback",
    response_type: "code",
    scope,
    state: randomBytes(16).toString("hex"),
    resource: `${origin}/mcp`,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  });
  const authorization = await request(`/api/auth/oauth2/authorize?${query}`, {
    headers: { Cookie: cookies[user], Accept: "application/json" },
  });
  expect(authorization.status, await authorization.clone().text()).toBe(200);
  const consentUrl = new URL((await authorization.json()).url, origin);
  expect(consentUrl.pathname).toBe("/consent");
  const oauthQuery = consentUrl.search.slice(1);
  const details = await request("/api/authorization-request", {
    method: "POST",
    headers: jsonHeaders(user),
    body: JSON.stringify({ oauth_query: oauthQuery }),
  });
  expect(details.status, await details.clone().text()).toBe(200);
  expect((await details.json()).client).toBe(`Test ${user}`);
  const consent = await request("/api/auth/oauth2/consent", {
    method: "POST",
    headers: jsonHeaders(user),
    body: JSON.stringify({ accept: true, oauth_query: oauthQuery }),
  });
  expect(consent.status, await consent.clone().text()).toBe(200);
  const callback = new URL((await consent.json()).url);
  expect(callback.searchParams.get("state")).toBe(query.get("state"));
  const code = callback.searchParams.get("code");
  if (!code) throw new Error("Missing authorization code");
  const response = await request("/api/auth/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: client.client_id,
      code,
      redirect_uri: "http://localhost:9911/callback",
      code_verifier: verifier,
      resource: `${origin}/mcp`,
    }),
  });
  expect(response.status, await response.clone().text()).toBe(200);
  return { ...(await response.json()), clientId: client.client_id };
}

async function mcp(user: string, method: string, params?: unknown) {
  return request("/mcp", {
    method: "POST",
    headers: {
      Authorization: ["Bearer", tokens[user]].join(" "),
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "advocu-hosted-"));
  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  const port = address.port;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  origin = `http://localhost:${port}`;
  const config = resolve("wrangler.jsonc");
  proxy = await getPlatformProxy<HostedEnv>({ configPath: config, persist: { path: join(directory, "v3") } });
  for (const file of ["0001_auth.sql", "0002_provider_credentials.sql"]) {
    const sql = await readFile(resolve("migrations", file), "utf8");
    await proxy.env.DB.batch(unstable_splitSqlQuery(sql).map((statement) => proxy.env.DB.prepare(statement)));
  }
  for (const user of ["alice", "bob"]) {
    const token = randomBytes(32).toString("hex");
    const now = new Date().toISOString();
    await proxy.env.DB.prepare(
      "INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)",
    )
      .bind(user, user, `${user}@example.test`, now, now)
      .run();
    await proxy.env.DB.prepare(
      "INSERT INTO session (id, token, userId, expiresAt, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)",
    )
      .bind(user, token, user, new Date(Date.now() + 3600000).toISOString(), now, now)
      .run();
    cookies[user] = `better-auth.session_token=${encodeURIComponent(`${token}.${await makeSignature(token, secret)}`)}`;
  }
  worker = await unstable_dev(resolve("src/hosted/worker.ts"), {
    config,
    port,
    ip: "127.0.0.1",
    local: true,
    persistTo: directory,
    logLevel: "error",
    vars: {
      BETTER_AUTH_URL: origin,
      BETTER_AUTH_SECRET: secret,
      CREDENTIAL_ENCRYPTION_KEY: encryptionKey,
      GITHUB_CLIENT_ID: "test-client",
      GITHUB_CLIENT_SECRET: "test-only",
    },
    experimental: { disableExperimentalWarning: true, disableDevRegistry: true },
  });
});

test.afterAll(async () => {
  await worker?.stop();
  await proxy?.dispose();
  if (directory) await rm(directory, { recursive: true, force: true });
});

test("serves login and discovery, rejecting unauthenticated and cross-origin requests", async () => {
  const page = await request("/");
  expect(page.status).toBe(200);
  expect(await page.text()).toContain("Sign in with GitHub");
  expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  const metadata = await request("/.well-known/oauth-protected-resource/mcp");
  expect((await metadata.json()).resource).toBe(`${origin}/mcp`);
  const issuer = await request("/.well-known/oauth-authorization-server/api/auth");
  expect((await issuer.json()).issuer).toBe(`${origin}/api/auth`);
  expect((await request("/api/connections")).status).toBe(401);
  const unauthorized = await request("/mcp");
  expect(unauthorized.status).toBe(401);
  expect(unauthorized.headers.get("www-authenticate")).toContain("resource_metadata=");
  expect((await request("/mcp", { headers: { Cookie: cookies.alice } })).status).toBe(401);
  expect((await request("/api/connections", { headers: { Origin: "https://evil.example" } })).status).toBe(403);
  const login = await request("/api/auth/sign-in/social", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ provider: "github", callbackURL: `${origin}/` }),
  });
  expect(login.status).toBe(200);
  expect(new URL((await login.json()).url).hostname).toBe("github.com");
});

test("encrypts provider settings and binds ciphertext to its owner", async () => {
  for (const [user, credentials] of [
    ["alice", { gde: { accessToken: "alice-provider-token" } }],
    ["bob", { mvp: { accessToken: "bob-provider-token", userProfileId: 123 } }],
  ] as const) {
    const response = await request("/api/connections", {
      method: "PUT",
      headers: jsonHeaders(user),
      body: JSON.stringify(credentials),
    });
    expect(response.status).toBe(200);
  }
  const status = await request("/api/connections", { headers: { Cookie: cookies.alice } });
  expect(await status.json()).toEqual({ gde: true, mvp: false });
  const rows = await proxy.env.DB.prepare("SELECT * FROM provider_credentials").all();
  expect(JSON.stringify(rows)).not.toContain("provider-token");
  const env = { ...proxy.env, CREDENTIAL_ENCRYPTION_KEY: encryptionKey };
  expect(await loadCredentials(env, "alice")).toEqual({ gde: { accessToken: "alice-provider-token" } });
  const alice = await proxy.env.DB.prepare("SELECT ciphertext FROM provider_credentials WHERE user_id = ?")
    .bind("alice")
    .first<{ ciphertext: string }>();
  if (!alice) throw new Error("Missing credential row");
  await proxy.env.DB.prepare(
    "INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('mallory', 'mallory', 'mallory@example.test', 1, '2026-01-01', '2026-01-01')",
  ).run();
  await proxy.env.DB.prepare("INSERT INTO provider_credentials VALUES (?, ?)").bind("mallory", alice.ciphertext).run();
  await expect(loadCredentials(env, "mallory")).rejects.toThrow();
  expect(
    (
      await request("/api/connections", {
        method: "PUT",
        headers: { Cookie: cookies.alice, "Content-Type": "application/json" },
        body: "{}",
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await request("/api/connections", {
        method: "PUT",
        headers: jsonHeaders("alice"),
        body: JSON.stringify({ mvp: { accessToken: "test", userProfileId: -1 } }),
      })
    ).status,
  ).toBe(400);
  expect(validateCredentials({ gde: { accessToken: "test", baseUrl: "https://evil.example" } })).toEqual({
    gde: { accessToken: "test" },
  });
});

test("completes PKCE OAuth and isolates each user's tools and documentation", async () => {
  for (const user of ["alice", "bob"]) {
    grants[user] = await authorize(user);
    tokens[user] = grants[user].access_token;
  }
  const initialization = await mcp("alice", "initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  });
  expect(initialization.status).toBe(200);
  const alice = await (await mcp("alice", "tools/list")).json();
  const bob = await (await mcp("bob", "tools/list")).json();
  expect(alice.result.tools.map((tool: { name: string }) => tool.name)).toContain("submit_gde_content_creation");
  expect(alice.result.tools.map((tool: { name: string }) => tool.name)).not.toContain("submit_mvp_video");
  expect(bob.result.tools.map((tool: { name: string }) => tool.name)).toContain("submit_mvp_video");
  expect(bob.result.tools.map((tool: { name: string }) => tool.name)).not.toContain("submit_gde_content_creation");
  const docs = await (await mcp("alice", "resources/read", { uri: "docs://api-reference" })).json();
  expect(docs.result.contents[0].text).toContain("API");
  const forbidden = await (await mcp("alice", "tools/call", { name: "submit_mvp_video", arguments: {} })).json();
  expect(forbidden.error.message).toContain("not enabled");
  const tampered = await request("/api/authorization-request", {
    method: "POST",
    headers: jsonHeaders("alice"),
    body: JSON.stringify({ oauth_query: "client_id=attacker" }),
  });
  expect(tampered.status).toBe(400);
});

test("refreshes OAuth tokens and rejects invalid tokens, missing scopes, and oversized bodies", async () => {
  const refreshed = await request("/api/auth/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: grants.alice.clientId,
      refresh_token: grants.alice.refresh_token,
      resource: `${origin}/mcp`,
    }),
  });
  expect(refreshed.status, await refreshed.clone().text()).toBe(200);
  tokens.alice = (await refreshed.json()).access_token;
  expect((await mcp("alice", "tools/list")).status).toBe(200);
  tokens.invalid = "invalid";
  expect((await mcp("invalid", "tools/list")).status).toBe(401);
  const auth = createAuth({
    ...proxy.env,
    BETTER_AUTH_URL: origin,
    BETTER_AUTH_SECRET: secret,
    GITHUB_CLIENT_ID: "test-client",
    GITHUB_CLIENT_SECRET: "test-only",
  });
  const payload = {
    sub: "alice",
    iss: `${origin}/api/auth`,
    aud: `${origin}/mcp`,
    scope: "mcp",
    exp: Math.floor(Date.now() / 1000) + 300,
  };
  tokens.unscoped = (await auth.api.signJWT({ body: { payload: { ...payload, scope: "offline_access" } } })).token;
  const unscoped = await mcp("unscoped", "tools/list");
  expect(unscoped.status).toBe(403);
  expect(unscoped.headers.get("www-authenticate")).toContain("insufficient_scope");
  for (const invalid of [
    { ...payload, exp: Math.floor(Date.now() / 1000) - 60 },
    { ...payload, aud: "https://other.example/mcp" },
    { ...payload, iss: "https://other.example/api/auth" },
  ]) {
    tokens.invalid = (await auth.api.signJWT({ body: { payload: invalid } })).token;
    expect((await mcp("invalid", "tools/list")).status).toBe(401);
  }
  expect(
    (
      await request("/api/connections", {
        method: "PUT",
        headers: jsonHeaders("alice"),
        body: "x".repeat(65537),
      })
    ).status,
  ).toBe(413);
});

test("disconnect takes effect on the next request without affecting other users", async () => {
  expect((await request("/api/connections", { method: "DELETE", headers: jsonHeaders("alice") })).status).toBe(200);
  const alice = await (await mcp("alice", "tools/list")).json();
  expect(alice.result.tools).toHaveLength(2);
  const bob = await (await mcp("bob", "tools/list")).json();
  expect(bob.result.tools.map((tool: { name: string }) => tool.name)).toContain("submit_mvp_video");
});

test("shared submissions use only the injected provider token and MVP profile", async () => {
  const originalFetch = globalThis.fetch;
  const submissions: Array<{ authorization: string | null; profileId: number }> = [];
  const clients: Client[] = [];
  const servers: UnifiedActivityReportingServer[] = [];
  try {
    globalThis.fetch = async (_url, options) => {
      const body = JSON.parse(String(options?.body));
      submissions.push({
        authorization: new Headers(options?.headers).get("Authorization"),
        profileId: body.activity.userProfileId,
      });
      return Response.json({ id: 1 });
    };
    for (const profileId of [101, 202]) {
      const server = new UnifiedActivityReportingServer({
        credentials: { mvp: { accessToken: `provider-${profileId}`, userProfileId: profileId } },
        readDocumentation: async () => "Documentation",
      });
      const client = new Client({ name: "test", version: "1" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      servers.push(server);
      clients.push(client);
      await server.connect(serverTransport);
      await client.connect(clientTransport);
    }
    await Promise.all(
      clients.map((client) =>
        client.callTool({
          name: "submit_mvp_blog",
          arguments: { title: "Test", date: "2026-10-15", userProfileId: 999 },
        }),
      ),
    );
    expect(submissions).toEqual([
      { authorization: ["Bearer", "provider-101"].join(" "), profileId: 101 },
      { authorization: ["Bearer", "provider-202"].join(" "), profileId: 202 },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    await Promise.all(clients.map((client) => client.close()));
    await Promise.all(servers.map((server) => server.close()));
  }
});

test("local stdio entry point still initializes and serves tools and documentation", async () => {
  const client = new Client({ name: "stdio-test", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("dist/index.js")],
    env: {
      PATH: process.env.PATH || "",
      ADVOCU_ACCESS_TOKEN: "local-test-token",
      DOCS_DIR: resolve("docs"),
    },
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("submit_gde_content_creation");
    const documentation = await client.readResource({ uri: "docs://api-reference" });
    expect(documentation.contents[0].text).toContain("API");
  } finally {
    await client.close();
  }
});

test("web login offers fresh authentication instead of looping on reauthentication requests", async () => {
  const source = await readFile(resolve("public/app.js"), "utf8");
  const { clientId } = await authorize("alice");
  for (const requirement of ["prompt=login", "max_age=0"]) {
    const query = new URLSearchParams({
      client_id: clientId,
      redirect_uri: "http://localhost:9911/callback",
      response_type: "code",
      scope: "mcp",
      resource: `${origin}/mcp`,
      code_challenge: createHash("sha256").update(randomBytes(32)).digest("base64url"),
      code_challenge_method: "S256",
    });
    for (const [name, value] of new URLSearchParams(requirement)) query.set(name, value);
    const authorization = await request(`/api/auth/oauth2/authorize?${query}`, {
      headers: { Cookie: cookies.alice, Accept: "application/json" },
    });
    expect(authorization.status).toBe(200);
    const login = new URL((await authorization.json()).url, origin);
    expect(login.pathname).toBe("/");
    const elements = new Map<string, { hidden: boolean; textContent: string }>();
    const redirects: string[] = [];
    const context = {
      URL,
      URLSearchParams,
      document: {
        getElementById: (id: string) => {
          if (!elements.has(id)) elements.set(id, { hidden: true, textContent: "" });
          return elements.get(id);
        },
      },
      location: {
        origin,
        pathname: "/",
        search: login.search,
        assign: (url: string) => redirects.push(url),
      },
      fetch: (path: string, options: RequestInit) =>
        request(path, {
          ...options,
          headers: { ...Object.fromEntries(new Headers(options.headers)), Cookie: cookies.alice, Origin: origin },
        }),
    };
    await runInNewContext(source, context);
    expect(elements.get("login")?.hidden).toBe(false);
    expect(elements.get("message")?.textContent).toContain("fresh sign-in");
    expect(redirects).toEqual([]);
  }
});

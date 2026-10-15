import { requireMcpAuth } from "@better-auth/mcp";
import { oauthProviderAuthServerMetadata, verifyOAuthQueryParams } from "@better-auth/oauth-provider";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { UnifiedActivityReportingServer } from "../unifiedServer.js";
import { type HostedEnv, createAuth } from "./auth.js";
import { loadCredentials, saveCredentials, validateCredentials } from "./credentials.js";
import { readDocumentation } from "./documents.js";

interface Env extends HostedEnv {
  ASSETS: { fetch(request: Request): Promise<Response> };
  MCP_RATE_LIMITER: { limit(options: { key: string }): Promise<{ success: boolean }> };
}

const json = (data: unknown, status = 200) => Response.json(data, { status });

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const origin = new URL(env.BETTER_AUTH_URL).origin;
  if (url.origin !== origin) return json({ message: "Invalid host" }, 400);
  if (request.headers.has("origin") && request.headers.get("origin") !== origin) {
    return json({ message: "Origin not allowed" }, 403);
  }
  const auth = createAuth(env);
  if (
    url.pathname === "/.well-known/oauth-authorization-server" ||
    url.pathname === "/.well-known/oauth-authorization-server/api/auth"
  ) {
    return oauthProviderAuthServerMetadata(auth)(request);
  }
  if (
    url.pathname === "/.well-known/oauth-protected-resource" ||
    url.pathname === "/.well-known/oauth-protected-resource/mcp"
  ) {
    return auth.handler(request);
  }
  if (url.pathname.startsWith("/api/auth/")) return auth.handler(request);

  if (url.pathname === "/api/authorization-request" && request.method === "POST") {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) return json({ message: "Sign in required" }, 401);
    if (request.headers.get("origin") !== origin) return json({ message: "Origin required" }, 403);
    const body = (await request.json()) as { oauth_query?: unknown };
    if (
      typeof body.oauth_query !== "string" ||
      !(await verifyOAuthQueryParams(body.oauth_query, (await auth.$context).secret))
    ) {
      return json({ message: "Invalid authorization request. Reconnect your MCP client." }, 400);
    }
    const params = new URLSearchParams(body.oauth_query);
    const client = await auth.api.getOAuthClientPublic({
      headers: request.headers,
      query: { client_id: params.get("client_id") || "" },
    });
    return json({
      client: client.client_name || params.get("client_id"),
      scope: params.get("scope"),
      redirectUri: params.get("redirect_uri"),
    });
  }

  if (url.pathname === "/api/connections") {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) return json({ message: "Sign in required" }, 401);
    const userId = session.user.id;
    if (request.method === "GET") {
      const credentials = await loadCredentials(env, userId);
      return json({ gde: !!credentials.gde, mvp: !!credentials.mvp });
    }
    if (request.headers.get("origin") !== origin) return json({ message: "Origin required" }, 403);
    if (request.method === "DELETE") {
      await env.DB.prepare("DELETE FROM provider_credentials WHERE user_id = ?").bind(userId).run();
      return json({ success: true });
    }
    if (request.method === "PUT") {
      if (!request.headers.get("content-type")?.startsWith("application/json")) {
        return json({ message: "JSON required" }, 415);
      }
      let credentials: ReturnType<typeof validateCredentials>;
      try {
        credentials = validateCredentials(await request.json());
      } catch {
        return json({ message: "Provide valid tokens and a positive integer MVP profile ID." }, 400);
      }
      await saveCredentials(env, userId, credentials);
      return json({ success: true });
    }
    return json({ message: "Method not allowed" }, 405);
  }

  if (url.pathname === "/mcp") {
    return requireMcpAuth(
      auth,
      async (authenticatedRequest, claims) => {
        if (!claims.sub) return json({ message: "User identity required" }, 401);
        if (!(await env.MCP_RATE_LIMITER.limit({ key: claims.sub })).success) {
          return new Response("Too many requests", { status: 429, headers: { "Retry-After": "60" } });
        }
        const credentials = await loadCredentials(env, claims.sub);
        const server = new UnifiedActivityReportingServer({
          credentials,
          readDocumentation,
          exposeProviderErrors: false,
        });
        const transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
        try {
          await server.connect(transport);
          return await transport.handleRequest(authenticatedRequest);
        } finally {
          await server.close();
        }
      },
      { resource: `${origin}/mcp`, requiredScopes: ["mcp"] },
    )(request);
  }

  if (request.method === "GET" && ["/", "/consent", "/app.js"].includes(url.pathname)) {
    const asset = new URL(url.pathname === "/app.js" ? "/app.js" : "/index.html", origin);
    return env.ASSETS.fetch(new Request(asset, request));
  }
  return json({ message: "Not found" }, 404);
}

export default {
  async fetch(incoming: Request, env: Env): Promise<Response> {
    let request = incoming;
    let response: Response;
    try {
      if (request.body) {
        const reader = request.body.getReader();
        const chunks: Uint8Array[] = [];
        let length = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.length;
          if (length > 65536) {
            await reader.cancel();
            return json({ message: "Request too large" }, 413);
          }
          chunks.push(value);
        }
        const body = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) {
          body.set(chunk, offset);
          offset += chunk.length;
        }
        request = new Request(request, { body });
      }
      response = await route(request, env);
    } catch {
      response = json({ message: "Service unavailable. Please try again." }, 500);
    }
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", "no-store");
    headers.set("Referrer-Policy", "no-referrer");
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("X-Frame-Options", "DENY");
    headers.set(
      "Content-Security-Policy",
      "default-src 'none'; script-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    );
    if (new URL(request.url).protocol === "https:") {
      headers.set("Strict-Transport-Security", "max-age=31536000");
    }
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  },
};

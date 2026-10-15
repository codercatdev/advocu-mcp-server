import { mcp } from "@better-auth/mcp";
import type { D1Database } from "@cloudflare/workers-types";
import { betterAuth } from "better-auth";
import { jwt } from "better-auth/plugins";

export interface HostedEnv {
  DB: D1Database;
  BETTER_AUTH_URL: string;
  BETTER_AUTH_SECRET: string;
  CREDENTIAL_ENCRYPTION_KEY: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
}

export function createAuth(env: HostedEnv) {
  const origin = new URL(env.BETTER_AUTH_URL).origin;
  return betterAuth({
    database: env.DB,
    baseURL: origin,
    basePath: "/api/auth",
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: [origin],
    logger: { disabled: true },
    account: { encryptOAuthTokens: true },
    socialProviders: {
      github: {
        clientId: env.GITHUB_CLIENT_ID,
        clientSecret: env.GITHUB_CLIENT_SECRET,
      },
    },
    rateLimit: { enabled: true, storage: "database" },
    disabledPaths: ["/token"],
    plugins: [
      jwt(),
      mcp({
        resource: `${origin}/mcp`,
        loginPage: "/",
        consentPage: "/consent",
        scopes: ["mcp", "offline_access"],
        grantTypes: ["authorization_code", "refresh_token"],
        resources: [{ identifier: `${origin}/mcp`, allowedScopes: ["mcp"] }],
        clientRegistrationDefaultResources: [`${origin}/mcp`],
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        clientRegistrationDefaultApplicationType: "infer",
        accessTokenExpiresIn: 900,
      }),
    ],
  });
}

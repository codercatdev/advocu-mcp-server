#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import dotenv from "dotenv";
import { UnifiedActivityReportingServer } from "./unifiedServer.js";

// Load environment variables from .env file
dotenv.config();

/**
 * Entry point for the Unified Activity Reporting MCP Server
 * Supports both Google GDE (Advocu) and Microsoft MVP activity submissions
 *
 * Environment Variables:
 * - ADVOCU_ACCESS_TOKEN: Token for GDE submissions (optional)
 * - MVP_ACCESS_TOKEN: Bearer token for MVP submissions (optional)
 * - MVP_USER_PROFILE_ID: Your MVP profile ID (required if using MVP)
 *
 * At least one of GDE or MVP must be configured.
 */
async function main() {
  try {
    const gdeToken = process.env.ADVOCU_ACCESS_TOKEN;
    const mvpToken = process.env.MVP_ACCESS_TOKEN;
    const profileId = Number.parseInt(process.env.MVP_USER_PROFILE_ID || "", 10);
    if (!gdeToken && !(mvpToken && profileId)) {
      throw new Error("Neither GDE nor MVP credentials configured. At least one must be set.");
    }
    const docsDir = process.env.DOCS_DIR || join(process.cwd(), "docs");
    const server = new UnifiedActivityReportingServer({
      credentials: {
        gde: gdeToken ? { accessToken: gdeToken, baseUrl: process.env.ADVOCU_API_URL } : undefined,
        mvp:
          mvpToken && profileId
            ? { accessToken: mvpToken, userProfileId: profileId, baseUrl: process.env.MVP_API_URL }
            : undefined,
      },
      readDocumentation: (file) => readFile(join(docsDir, file), "utf-8"),
    });
    await server.connect(new StdioServerTransport());
    console.error("🚀 Unified Activity Reporting MCP Server running");
  } catch (error) {
    console.error("Failed to start Activity Reporting MCP Server:", error);
    process.exit(1);
  }
}

// Run the server
main().catch(console.error);

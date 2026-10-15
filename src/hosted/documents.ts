import api from "../../docs/API.md";
import fixes from "../../docs/CHANGELOG_MVP_FIXES.md";
import errors from "../../docs/ERROR_HANDLING_IMPROVEMENTS.md";
import resources from "../../docs/MCP_RESOURCES.md";
import mvp from "../../docs/MVP_API_REFERENCE.md";

const documents: Record<string, string> = {
  "API.md": api,
  "MVP_API_REFERENCE.md": mvp,
  "CHANGELOG_MVP_FIXES.md": fixes,
  "ERROR_HANDLING_IMPROVEMENTS.md": errors,
  "MCP_RESOURCES.md": resources,
};

export async function readDocumentation(file: string) {
  if (!(file in documents)) throw new Error("Unknown document");
  return documents[file];
}

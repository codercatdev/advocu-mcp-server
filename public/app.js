const element = (id) => document.getElementById(id);
const query = location.search.slice(1);
const oauthQuery = new URLSearchParams(query).get("oauth_query") || query;
const hasOAuthRequest = new URLSearchParams(oauthQuery).has("client_id");

async function api(path, body, method = "POST") {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || "Request failed. Please try again.");
  return data;
}

function report(error) {
  element("message").textContent = error.message || "Request failed.";
}

async function connections() {
  const data = await api("/api/connections", undefined, "GET");
  element("connections").textContent =
    `Advocu: ${data.gde ? "connected" : "not connected"}. MVP: ${data.mvp ? "connected" : "not connected"}.`;
}

async function authorize(accept) {
  const data = await api("/api/auth/oauth2/consent", { accept, oauth_query: oauthQuery });
  if (data.url) location.assign(data.url);
  else throw new Error("Authorization could not be completed. Reconnect your MCP client.");
}

element("login").onclick = async () => {
  try {
    const data = await api("/api/auth/sign-in/social", {
      provider: "github",
      callbackURL: `${location.origin}/${hasOAuthRequest ? `?${query}` : ""}`,
      ...(hasOAuthRequest ? { oauth_query: oauthQuery } : {}),
    });
    if (data.url) location.assign(data.url);
  } catch (error) {
    report(error);
  }
};

element("credentials").onsubmit = async (event) => {
  event.preventDefault();
  try {
    const credentials = {};
    if (element("gde").value.trim()) credentials.gde = { accessToken: element("gde").value.trim() };
    if (element("mvp").value.trim()) {
      credentials.mvp = { accessToken: element("mvp").value.trim(), userProfileId: Number(element("profile").value) };
    }
    await api("/api/connections", credentials, "PUT");
    element("credentials").reset();
    await connections();
    element("message").textContent = "Connections saved.";
  } catch (error) {
    report(error);
  }
};

element("disconnect").onclick = async () => {
  try {
    await api("/api/connections", undefined, "DELETE");
    element("credentials").reset();
    await connections();
  } catch (error) {
    report(error);
  }
};
element("approve").onclick = () => authorize(true).catch(report);
element("deny").onclick = () => authorize(false).catch(report);
element("logout").onclick = async () => {
  try {
    await api("/api/auth/sign-out", {});
    location.assign("/");
  } catch (error) {
    report(error);
  }
};

async function start() {
  element("endpoint").textContent = `${location.origin}/mcp`;
  const session = await api("/api/auth/get-session", undefined, "GET");
  if (!session?.user) {
    element("login").hidden = false;
    return;
  }
  element("account").hidden = false;
  element("identity").textContent = `Signed in as ${session.user.name}`;
  await connections();
  if (!hasOAuthRequest) return;
  if (location.pathname !== "/consent") {
    const data = await api("/api/auth/oauth2/continue", { postLogin: true, oauth_query: oauthQuery });
    if (data.url) {
      const destination = new URL(data.url, location.origin);
      if (destination.origin === location.origin && destination.pathname === "/") {
        element("login").hidden = false;
        element("message").textContent = "Your MCP client requires a fresh sign-in. Sign in with GitHub to continue.";
      } else {
        location.assign(data.url);
      }
    }
    return;
  }
  const authorization = await api("/api/authorization-request", { oauth_query: oauthQuery });
  element("request").textContent =
    `Client: ${authorization.client}. Requested scopes: ${authorization.scope || "(none)"}. Callback: ${authorization.redirectUri || "(none)"}`;
  element("consent").hidden = false;
}

start().catch(report);

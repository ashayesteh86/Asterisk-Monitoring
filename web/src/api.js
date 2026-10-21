// fetch wrapper: JSON in/out, Persian error messages from the server. Every call carries the selected PBX server.
let serverId = 0;
export const setApiServer = (id) => { serverId = Number(id) || 0; };
export const apiServer = () => serverId;
/** For plain links (CSV downloads) that can't send headers. */
export const withServer = (url) => (serverId ? `${url}${url.includes("?") ? "&" : "?"}server=${serverId}` : url);

export async function api(path, { method = "GET", body, raw } = {}) {
  const headers = body !== undefined && typeof body !== "string" ? { "Content-Type": "application/json" } : body ? { "Content-Type": "text/csv" } : {};
  if (serverId) headers["X-Pbx-Server"] = String(serverId);
  const res = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    credentials: "same-origin",
  });
  if (res.status === 401 && !path.endsWith("/login")) {
    window.dispatchEvent(new Event("auth:logout"));
  }
  if (raw) return res;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `خطا (${res.status})`);
  return data;
}

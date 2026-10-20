// fetch wrapper: JSON in/out, Persian error messages from the server.
export async function api(path, { method = "GET", body, raw } = {}) {
  const res = await fetch(path, {
    method,
    headers: body !== undefined && typeof body !== "string" ? { "Content-Type": "application/json" } : body ? { "Content-Type": "text/csv" } : {},
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

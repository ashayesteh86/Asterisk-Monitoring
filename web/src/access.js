// Client copy of the server's permission / scope rules (server/access.js) — used only to decide what to show;
// the server enforces every action again.
function dialplanRegex(p) {
  p = String(p || "").trim();
  const esc = (c) => c.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  if (!p.startsWith("_")) return new RegExp(`^${esc(p)}$`, "i");
  let re = "^";
  for (let i = 1; i < p.length; i++) {
    const c = p[i], u = c.toUpperCase();
    if (u === "X") re += "[0-9]"; else if (u === "Z") re += "[1-9]"; else if (u === "N") re += "[2-9]";
    else if (c === ".") re += ".+"; else if (c === "!") re += ".*";
    else if (c === "[") { const end = p.indexOf("]", i); if (end < 0) return /$^/; re += `[${p.slice(i + 1, end).replace(/[\\\]^]/g, "\\$&")}]`; i = end; }
    else re += esc(c);
  }
  return new RegExp(re + "$", "i");
}
function tokenMatch(tok, ext) {
  tok = tok.trim();
  if (!tok) return false;
  const r = /^(\d+)-(\d+)$/.exec(tok);
  if (r) return /^\d+$/.test(ext) && ext.length === r[1].length && +ext >= +r[1] && +ext <= +r[2];
  try { return dialplanRegex(tok).test(ext); } catch { return false; }
}
export const listMatch = (list, ext) => String(list || "").split(/[,\s]+/).some((t) => tokenMatch(t, String(ext)));

export function inScope(user, section, ext) {
  if (!user) return false;
  if (user.isAdmin) return true;
  const s = user.scopes?.[section] || { mode: "all" };
  if (ext === undefined || ext === null || ext === "") return s.mode === "all";
  switch (s.mode) {
    case "all": return true;
    case "self": return !!user.extension && String(ext) === String(user.extension);
    case "list": return listMatch(s.list, ext) || (section === "dial" && String(ext) === String(user.extension));
    case "except": return !listMatch(s.list, ext);
    default: return section === "dial" && !!user.extension && String(ext) === String(user.extension);
  }
}
export const can = (user, perm) => !!user && (user.isAdmin || (user.perms || []).includes(perm));
/** A call (list of extensions in it) is in scope when any of its extensions is. */
export const callInScope = (user, section, exts) => (exts.length ? exts.some((e) => inScope(user, section, e)) : inScope(user, section, ""));

// Small shared helpers: phone number normalisation, CSV, Jalali formatting.
import { toJalaali } from "jalaali-js";

/** Canonical form for matching caller IDs against the phonebook: Iranian numbers → 0XXXXXXXXXX. */
export function normalizeNumber(num) {
  let d = String(num || "").replace(/[^\d]/g, "");
  if (!d) return "";
  if (d.startsWith("0098")) d = "0" + d.slice(4);
  else if (d.startsWith("98") && d.length === 12) d = "0" + d.slice(2);
  else if (d.length === 10 && d.startsWith("9")) d = "0" + d;
  return d;
}

export function parseCsv(text) {
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === "," || c === ";" && !text.includes(",")) { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((f) => f.trim())) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim())) rows.push(row);
  return rows;
}

export function toCsv(rows) {
  return rows.map((r) => r.map((v) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(",")).join("\r\n");
}

/** "2026-10-20 14:05:00" (wall clock) → "1405/07/28 14:05:00" */
export function toJalaliString(dt) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}:\d{2}(?::\d{2})?))?/.exec(String(dt || ""));
  if (!m) return "";
  const j = toJalaali(Number(m[1]), Number(m[2]), Number(m[3]));
  const pad = (n) => String(n).padStart(2, "0");
  return `${j.jy}/${pad(j.jm)}/${pad(j.jd)}${m[4] ? " " + m[4] : ""}`;
}

/**
 * Asterisk dialplan pattern → RegExp source.
 * "_1XX" → ^1[0-9][0-9]$ ; X=0-9, Z=1-9, N=2-9, [15-7]=set, "."=one or more, "!"=zero or more.
 * Without a leading "_" the pattern is a literal (e.g. "101").
 */
export function dialplanToRegex(pattern) {
  const p = String(pattern || "").trim();
  const esc = (c) => c.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  if (!p.startsWith("_")) return `^${esc(p)}$`;
  let re = "^";
  for (let i = 1; i < p.length; i++) {
    const c = p[i];
    const u = c.toUpperCase();
    if (u === "X") re += "[0-9]";
    else if (u === "Z") re += "[1-9]";
    else if (u === "N") re += "[2-9]";
    else if (c === ".") re += ".+";
    else if (c === "!") re += ".*";
    else if (c === "[") {
      const end = p.indexOf("]", i);
      if (end < 0) throw new Error(`براکت بسته نشده در الگوی ${p}`);
      const set = p.slice(i + 1, end).replace(/[\\\]^]/g, "\\$&");
      if (!set) throw new Error(`براکت خالی در الگوی ${p}`);
      re += `[${set}]`;
      i = end;
    } else re += esc(c);
  }
  return re + "$";
}

/** Validate a comma/space separated list of dialplan patterns; throws a Persian error. */
export function checkDialplanList(list) {
  const items = String(list || "").split(/[,\s]+/).filter(Boolean);
  if (!items.length) throw new Error("حداقل یک الگو وارد کنید (مثلاً _XXX)");
  for (const it of items) {
    if (it.startsWith("_") ? !/^_[\w*#+.![\]-]+$/.test(it) : !/^[\w*#+-]+$/.test(it)) throw new Error(`الگوی «${it}» نامعتبر است`);
    new RegExp(dialplanToRegex(it));
  }
  return items.join(", ");
}

const patternCache = new Map();
/** Does value match any dialplan pattern in the list? Legacy values starting with "^" are treated as a regex. */
export function matchDialplan(list, value) {
  const key = String(list || "");
  let res = patternCache.get(key);
  if (!res) {
    try {
      res = key.trim().startsWith("^") ? [new RegExp(key.trim())]
        : key.split(/[,\s]+/).filter(Boolean).map((p) => new RegExp(dialplanToRegex(p), "i"));
    } catch { res = [/^\d{2,6}$/]; }
    if (patternCache.size > 200) patternCache.clear();
    patternCache.set(key, res);
  }
  return res.some((r) => r.test(String(value)));
}

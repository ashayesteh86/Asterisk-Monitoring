// Jalali (Shamsi) calendar helpers + Persian number formatting.
import { toJalaali, toGregorian, jalaaliMonthLength } from "jalaali-js";

export const MONTHS = ["فروردین", "اردیبهشت", "خرداد", "تیر", "مرداد", "شهریور", "مهر", "آبان", "آذر", "دی", "بهمن", "اسفند"];
export const WEEKDAYS = ["ش", "ی", "د", "س", "چ", "پ", "ج"];
export { jalaaliMonthLength };

const FA = "۰۱۲۳۴۵۶۷۸۹";
export const fa = (v) => String(v ?? "").replace(/\d/g, (d) => FA[d]);
export const toLatinDigits = (s) => String(s ?? "").replace(/[۰-۹]/g, (d) => FA.indexOf(d)).replace(/[٠-٩]/g, (d) => "٠١٢٣٤٥٦٧٨٩".indexOf(d));
export const faNum = (n) => fa(Number(n || 0).toLocaleString("en-US"));
const pad = (n) => String(n).padStart(2, "0");

/** Date → {jy,jm,jd} */
export const jOf = (d) => toJalaali(d.getFullYear(), d.getMonth() + 1, d.getDate());
/** {jy,jm,jd} → JS Date at local midnight */
export const fromJ = ({ jy, jm, jd }) => { const g = toGregorian(jy, jm, jd); return new Date(g.gy, g.gm - 1, g.gd); };
export const jString = (j) => `${j.jy}/${pad(j.jm)}/${pad(j.jd)}`;
export const parseJ = (s) => {
  const m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(toLatinDigits(s).trim());
  if (!m) return null;
  const j = { jy: +m[1], jm: +m[2], jd: +m[3] };
  if (j.jm < 1 || j.jm > 12 || j.jd < 1 || j.jd > jalaaliMonthLength(j.jy, j.jm)) return null;
  return j;
};
/** Date → "YYYY-MM-DD HH:mm:ss" wall clock (what the CDR table stores) */
export const sqlDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
/** "2026-10-20 14:05:00" → "۱۴۰۵/۰۷/۲۸" (+ time) */
export function jFromSql(s, withTime = true) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}:\d{2})(?::\d{2})?)?/.exec(String(s || ""));
  if (!m) return "";
  const j = toJalaali(+m[1], +m[2], +m[3]);
  return fa(jString(j) + (withTime && m[4] ? ` ${m[4]}` : ""));
}
export const weekdayName = (d) => ["یکشنبه", "دوشنبه", "سه‌شنبه", "چهارشنبه", "پنجشنبه", "جمعه", "شنبه"][d.getDay()];
export const todayLong = () => { const d = new Date(); const j = jOf(d); return fa(`${weekdayName(d)} ${j.jd} ${MONTHS[j.jm - 1]} ${j.jy}`); };

/** seconds → "۱:۰۵:۰۹" or "۰۵:۰۹" */
export function dur(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return fa(h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`);
}
/** seconds → "۳ ساعت و ۱۲ دقیقه" */
export function durLong(sec) {
  sec = Math.round(sec || 0);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  if (h) return fa(`${h.toLocaleString("en-US")} ساعت${m ? ` و ${m} دقیقه` : ""}`);
  if (m) return fa(`${m} دقیقه${s ? ` و ${s} ثانیه` : ""}`);
  return fa(`${s} ثانیه`);
}

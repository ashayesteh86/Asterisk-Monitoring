// Shamsi date input with a month-grid popover. value/onChange use "YYYY/MM/DD" (Latin digits).
import { useEffect, useRef, useState } from "react";
import { MONTHS, WEEKDAYS, fa, jOf, fromJ, jString, parseJ, jalaaliMonthLength } from "../jalali.js";
import { Icon } from "./ui.jsx";

export default function JalaliDatePicker({ value, onChange, placeholder = "۱۴۰۵/۰۱/۰۱", className = "" }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(value ? fa(value) : "");
  const sel = parseJ(value || "");
  const [view, setView] = useState(() => sel || jOf(new Date()));
  const box = useRef(null);
  useEffect(() => setText(value ? fa(value) : ""), [value]);
  useEffect(() => {
    if (!open) return;
    const h = (e) => box.current && !box.current.contains(e.target) && setOpen(false);
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);

  const days = jalaaliMonthLength(view.jy, view.jm);
  const firstDow = (fromJ({ jy: view.jy, jm: view.jm, jd: 1 }).getDay() + 1) % 7; // Saturday = 0
  const today = jOf(new Date());
  const move = (d) => setView((v) => { let jm = v.jm + d, jy = v.jy; if (jm < 1) { jm = 12; jy--; } if (jm > 12) { jm = 1; jy++; } return { jy, jm, jd: 1 }; });
  const pick = (jd) => { const s = jString({ jy: view.jy, jm: view.jm, jd }); onChange(s); setOpen(false); };

  return (
    <div className={`relative ${className}`} ref={box}>
      <div className="relative">
        <input className="input num pl-9" value={text} placeholder={placeholder} inputMode="numeric"
          onFocus={() => { setOpen(true); if (sel) setView(sel); }}
          onChange={(e) => { setText(e.target.value); const j = parseJ(e.target.value); if (j) { onChange(jString(j)); setView(j); } else if (!e.target.value) onChange(""); }} />
        <Icon name="calendar" className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-ink-3" />
      </div>
      {open && (
        <div className="card absolute z-40 mt-1 w-72 p-3 shadow-xl">
          <div className="mb-2 flex items-center justify-between">
            <button type="button" className="rounded-md p-1 hover:bg-surface-2" onClick={() => move(-1)} aria-label="ماه قبل"><Icon name="chevronR" className="size-4" /></button>
            <div className="text-sm font-semibold">{MONTHS[view.jm - 1]} {fa(view.jy)}</div>
            <button type="button" className="rounded-md p-1 hover:bg-surface-2" onClick={() => move(1)} aria-label="ماه بعد"><Icon name="chevronL" className="size-4" /></button>
          </div>
          <div className="grid grid-cols-7 gap-0.5 text-center text-xs">
            {WEEKDAYS.map((w, i) => <div key={w} className={`py-1 ${i === 6 ? "text-talk" : "text-ink-3"}`}>{w}</div>)}
            {Array.from({ length: firstDow }, (_, i) => <div key={`e${i}`} />)}
            {Array.from({ length: days }, (_, i) => {
              const jd = i + 1;
              const isSel = sel && sel.jy === view.jy && sel.jm === view.jm && sel.jd === jd;
              const isToday = today.jy === view.jy && today.jm === view.jm && today.jd === jd;
              const friday = (firstDow + i) % 7 === 6;
              return (
                <button type="button" key={jd} onClick={() => pick(jd)}
                  className={`num rounded-md py-1.5 text-sm ${isSel ? "bg-accent text-accent-ink" : isToday ? "bg-accent-soft text-accent" : friday ? "text-talk hover:bg-surface-2" : "hover:bg-surface-2"}`}>
                  {fa(jd)}
                </button>
              );
            })}
          </div>
          <div className="mt-2 flex justify-between border-t border-line pt-2">
            <button type="button" className="btn btn-sm" onClick={() => { onChange(jString(today)); setOpen(false); }}>امروز</button>
            <button type="button" className="btn btn-sm" onClick={() => { onChange(""); setOpen(false); }}>پاک کردن</button>
          </div>
        </div>
      )}
    </div>
  );
}

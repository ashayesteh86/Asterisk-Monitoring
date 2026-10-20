import { useEffect, useState, createContext, useContext, useCallback } from "react";
import { createPortal } from "react-dom";

export function Modal({ open, onClose, title, children, wide, footer }) {
  useEffect(() => {
    if (!open) return;
    const k = (e) => e.key === "Escape" && onClose?.();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 pt-[6vh]" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className={`card w-full ${wide ? "max-w-3xl" : "max-w-lg"} shadow-2xl`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
          <h3 className="text-base font-semibold">{title}</h3>
          <button className="rounded-lg p-1 text-ink-3 hover:bg-surface-2" onClick={onClose} aria-label="بستن"><Icon name="x" /></button>
        </div>
        <div className="p-5">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
      </div>
    </div>, document.body);
}

const ToastCtx = createContext(() => {});
export function ToastProvider({ children }) {
  const [items, setItems] = useState([]);
  const push = useCallback((text, kind = "ok") => {
    const id = Math.random();
    setItems((x) => [...x, { id, text, kind }]);
    setTimeout(() => setItems((x) => x.filter((i) => i.id !== id)), 4500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed bottom-4 left-4 z-[60] flex flex-col gap-2">
        {items.map((t) => (
          <div key={t.id} className={`pointer-events-auto card flex items-center gap-2 px-4 py-2.5 text-sm shadow-lg ${t.kind === "error" ? "border-talk text-talk" : ""}`}>
            <Icon name={t.kind === "error" ? "alert" : "check"} className={t.kind === "error" ? "text-talk" : "text-idle"} />
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

export function Field({ label, children, hint, className = "" }) {
  return (
    <label className={`block ${className}`}>
      <span className="label">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-ink-3">{hint}</span>}
    </label>
  );
}

export function Empty({ icon = "inbox", title, children }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-14 text-center text-ink-3">
      <Icon name={icon} className="size-9 opacity-60" />
      <div className="font-medium text-ink-2">{title}</div>
      {children && <div className="max-w-md text-sm">{children}</div>}
    </div>
  );
}

const PATHS = {
  grid: "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z",
  trunk: "M3 7h18M3 12h18M3 17h18M7 4v6M17 14v6",
  book: "M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3zM5 17a3 3 0 0 1 3-3h11M9 8h6",
  dialpad: "M6 5h.01M12 5h.01M18 5h.01M6 11h.01M12 11h.01M18 11h.01M6 17h.01M12 17h.01M18 17h.01M12 21h.01",
  chart: "M4 20V10M10 20V4M16 20v-7M22 20H2",
  settings: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z",
  phone: "M5 4h3l2 5-2.5 1.5a11 11 0 0 0 6 6L15 14l5 2v3a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2",
  phoneIn: "M16 3v5h5M21 3l-5 5M5 4h3l2 5-2.5 1.5a11 11 0 0 0 6 6L15 14l5 2v3a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2",
  phoneOut: "M16 3h5v5M15 9l6-6M5 4h3l2 5-2.5 1.5a11 11 0 0 0 6 6L15 14l5 2v3a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2",
  hangup: "M3 15.5c5-5 13-5 18 0l-2.5 2.5-3.5-2v-2.5a12 12 0 0 0-6 0V16l-3.5 2z",
  headset: "M3 14v-2a9 9 0 0 1 18 0v2M3 14a2 2 0 0 1 2-2h1v7H5a2 2 0 0 1-2-2zM21 14a2 2 0 0 0-2-2h-1v7h1a2 2 0 0 0 2-2zM18 19a4 4 0 0 1-4 3h-2",
  ear: "M7 9a5 5 0 0 1 10 0c0 3-3 4-3 7a3 3 0 0 1-6 0M10 9a2 2 0 0 1 4 0",
  whisper: "M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12zM8 12h.01M12 12h.01M16 12h.01",
  barge: "M17 20v-2a4 4 0 0 0-3-3.9M7 20v-2a4 4 0 0 1 4-4h2M12 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19 8v6M22 11h-6",
  transfer: "M7 7h13l-4-4M17 17H4l4 4",
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-5-5",
  x: "M6 6l12 12M18 6L6 18",
  check: "M5 12l5 5L20 7",
  alert: "M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z",
  plus: "M12 5v14M5 12h14",
  edit: "M4 20h4L19 9l-4-4L4 16zM14 6l4 4",
  trash: "M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3",
  star: "M12 3l2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9z",
  download: "M12 4v12M6 10l6 6 6-6M4 20h16",
  upload: "M12 20V8M6 14l6-6 6 6M4 4h16",
  refresh: "M20 11a8 8 0 0 0-14.8-4M4 4v4h4M4 13a8 8 0 0 0 14.8 4M20 20v-4h-4",
  logout: "M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4M10 17l-5-5 5-5M5 12h11",
  sun: "M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4",
  moon: "M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z",
  calendar: "M4 6h16v14H4zM4 10h16M8 3v4M16 3v4",
  chevronL: "M15 18l-6-6 6-6",
  chevronR: "M9 18l6-6-6-6",
  inbox: "M3 13h5l2 3h4l2-3h5M5 5h14l2 8v6H3v-6z",
  user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0",
  users: "M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2 21a7 7 0 0 1 14 0M16 3.5a4 4 0 0 1 0 7.5M22 21a7 7 0 0 0-4-6.3",
  wifi: "M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M12 19.5h.01M2 9a15 15 0 0 1 20 0",
  server: "M4 4h16v6H4zM4 14h16v6H4zM8 7h.01M8 17h.01",
  backspace: "M21 5H8l-6 7 6 7h13zM16 9l-5 5M11 9l5 5",
  play: "M7 4l13 8-13 8z",
  list: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
  shield: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z",
  menu: "M4 6h16M4 12h16M4 18h16",
  pulse: "M3 12h4l3-8 4 16 3-8h4",
};
export function Icon({ name, className = "size-5" }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[name] || PATHS.inbox} />
    </svg>
  );
}

export function Spinner({ className = "size-5" }) {
  return <svg className={`${className} animate-spin`} viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity=".25" strokeWidth="3" /><path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" /></svg>;
}

export function Tabs({ tabs, value, onChange }) {
  return (
    <div className="flex gap-1 overflow-x-auto border-b border-line">
      {tabs.map((t) => (
        <button key={t.id} onClick={() => onChange(t.id)}
          className={`-mb-px flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3.5 py-2.5 text-sm ${value === t.id ? "border-accent font-medium text-accent" : "border-transparent text-ink-2 hover:text-ink"}`}>
          {t.icon && <Icon name={t.icon} className="size-4" />}{t.label}
        </button>
      ))}
    </div>
  );
}

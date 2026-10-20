// Illustrated device by phone type: desk phone, softphone (PC), mobile, gateway, unknown.
const VENDOR_COLORS = {
  Yealink: "#0a6ebd", Grandstream: "#c0392b", Cisco: "#049fd9", Linksys: "#049fd9", Snom: "#5b6670", Panasonic: "#0041c0",
  Fanvil: "#e2231a", Htek: "#0e8a5f", Polycom: "#d2232a", Avaya: "#cc0000", Gigaset: "#2e7d32", MicroSIP: "#3a7bd5", Zoiper: "#f06a28",
  Linphone: "#ef7b23", "3CX": "#0a8fdc",
};

export default function PhoneIcon({ phone, status = "idle", className = "size-11" }) {
  const type = phone?.type || "unknown";
  const accent = VENDOR_COLORS[phone?.vendor] || "var(--ink-3)";
  const screen = status === "offline" || status === "unreachable" ? "var(--surface-3)" : `var(--st-${status === "talking" ? "talk" : status === "ringing" || status === "dialing" ? "ring" : status === "hold" ? "hold" : "idle"}-soft)`;
  const shake = status === "ringing" ? "shake" : "";
  if (type === "soft") return (
    <svg viewBox="0 0 48 48" className={className} aria-hidden="true">
      <rect x="5" y="8" width="38" height="25" rx="3" fill="var(--surface-2)" stroke="var(--ink-3)" strokeWidth="1.5" />
      <rect x="8.5" y="11.5" width="31" height="18" rx="1.5" fill={screen} />
      <path d="M18 40h12M24 33v7" stroke="var(--ink-3)" strokeWidth="1.8" strokeLinecap="round" />
      <g className={shake}><path d="M20.2 16.5c.4 0 .7.2.8.6l.4 1.7c.1.3 0 .6-.3.8l-.8.6a6 6 0 0 0 3.2 3.2l.6-.8c.2-.3.5-.4.8-.3l1.7.4c.4.1.6.4.6.8v1.4c0 .5-.4.8-.9.8-4.7-.1-8.3-3.7-8.4-8.4 0-.5.3-.9.8-.9z" fill={accent} /></g>
    </svg>
  );
  if (type === "mobile") return (
    <svg viewBox="0 0 48 48" className={className} aria-hidden="true">
      <rect x="14" y="4" width="20" height="40" rx="4" fill="var(--surface-2)" stroke="var(--ink-3)" strokeWidth="1.5" />
      <rect x="16.5" y="9" width="15" height="28" rx="1.5" fill={screen} />
      <circle cx="24" cy="40.5" r="1.4" fill="var(--ink-3)" />
      <rect x="20" y="6" width="8" height="1.2" rx=".6" fill={accent} />
    </svg>
  );
  if (type === "gateway") return (
    <svg viewBox="0 0 48 48" className={className} aria-hidden="true">
      <rect x="5" y="16" width="38" height="16" rx="3" fill="var(--surface-2)" stroke="var(--ink-3)" strokeWidth="1.5" />
      {[11, 17, 23, 29].map((x) => <rect key={x} x={x} y="24" width="4" height="4" rx=".8" fill="var(--ink-3)" />)}
      <circle cx="37" cy="22" r="1.6" fill={accent} />
      <path d="M14 16l-3-8M34 16l3-8" stroke="var(--ink-3)" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
  // desk phone (also used for unknown)
  return (
    <svg viewBox="0 0 48 48" className={className} aria-hidden="true">
      <path d="M6 20c0-2 1.5-3.5 3.5-3.5h29c2 0 3.5 1.5 3.5 3.5l1.5 18c.1 1.9-1.4 3.5-3.3 3.5H7.8C5.9 41.5 4.4 39.9 4.5 38z" fill="var(--surface-2)" stroke="var(--ink-3)" strokeWidth="1.5" />
      <g className={shake}>
        <path d="M7 9.5c0-1.7 1.3-3 3-3h4c1.7 0 3 1.3 3 3V30c0 1.7-1.3 3-3 3h-4c-1.7 0-3-1.3-3-3z" fill={type === "unknown" ? "var(--surface-3)" : accent} opacity=".92" />
      </g>
      <rect x="21" y="20" width="17" height="8" rx="1.3" fill={screen} stroke="var(--ink-3)" strokeWidth=".8" />
      {[0, 1, 2].map((r) => [0, 1, 2].map((c) => <rect key={`${r}${c}`} x={22.5 + c * 5} y={31 + r * 3.2} width="3.4" height="2.1" rx=".6" fill="var(--ink-3)" opacity=".7" />))}
    </svg>
  );
}

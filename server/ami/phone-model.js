// SIP User-Agent string → { vendor, model, firmware, type } for the operator panel.
// type: desk | soft | gateway | mobile | unknown
const RULES = [
  [/Yealink\s+(?:SIP[-\s]?)?([A-Z]{1,3}\d+[A-Z0-9]*(?:[_\s-]?E\d)?)\s*([\d.]+)?/i, "Yealink", "desk"],
  [/Grandstream\s+(GXP\d+\w*|GRP\d+\w*|GXV\d+\w*|DP\d+\w*|WP\d+\w*|HT\d+\w*|GXW\d+\w*)\s*([\d.]+)?/i, "Grandstream", "desk"],
  [/Cisco\/(SPA\d+\w*)-([\d.()a-z]+)/i, "Cisco", "desk"],
  [/Cisco[-\s](CP-\d+\w*|SPA\d+\w*)\/?([\d.()a-z]+)?/i, "Cisco", "desk"],
  [/Linksys\/(SPA\d+\w*)-([\d.()a-z]+)/i, "Linksys", "desk"],
  [/snom(\w+)[-/]([\d.]+)/i, "Snom", "desk"],
  [/Panasonic[_\s-]?(KX-?[A-Z0-9]+)\/?([\w.]+)?/i, "Panasonic", "desk"],
  [/Fanvil\s+([A-Z]?\d+\w*)\s*([\d.]+)?/i, "Fanvil", "desk"],
  [/Htek\s+(UC\d+\w*)\s*([\d.]+)?/i, "Htek", "desk"],
  [/Akuvox\s+(\w+)\s*([\d.]+)?/i, "Akuvox", "desk"],
  [/Escene\s+(\w+)\s*([\d.]+)?/i, "Escene", "desk"],
  [/OBIHAI\/(VVX\s?D?\d+\w*)-([\d.]+)/i, "Polycom", "desk"],
  [/OBIHAI\/(OBi\w+)-([\d.]+)/i, "Obihai", "gateway"],
  [/(?:Polycom|PolycomVVX|PolycomSoundPoint)[-\s]?(VVX[_\s-]?\d+|SoundPoint\w*[-_]?\w*|IP[_\s-]?\d+)\S*[-\s/]UA\/([\d.]+)/i, "Polycom", "desk"],
  [/Avaya\s*(?:SIP\s*)?(\w+)?\s*([\d.]+)?/i, "Avaya", "desk"],
  [/(?:Alcatel|ALE)\s*(\w+)?\s*([\d.]+)?/i, "Alcatel", "desk"],
  [/Gigaset\s*(\w+)?\s*([\d.]+)?/i, "Gigaset", "desk"],
  [/Mitel\s*(\w+)?\s*([\d.]+)?/i, "Mitel", "desk"],
  [/(?:Dinstar|DAG\d+)\s*(\w+)?\s*([\d.]+)?/i, "Dinstar", "gateway"],
  [/(?:OpenVox|VS-GW\w*)\s*(\w+)?\s*([\d.]+)?/i, "OpenVox", "gateway"],
  [/(?:Audiocodes|MP-?11\d)\S*\s*(\w+)?\s*([\d.]+)?/i, "AudioCodes", "gateway"],
  [/MicroSIP\/([\d.]+)/i, "MicroSIP", "soft", true],
  [/Zoiper\s*(?:rv|v)?([\d.]+)?/i, "Zoiper", "soft", true],
  [/Linphone(?:Android|iOS|Desktop)?[/\s]*([\d.]+)?/i, "Linphone", "soft", true],
  [/Bria\s*(\w+)?\s*([\d.]+)?/i, "Bria", "soft"],
  [/X-?Lite\s*([\d.]+)?/i, "X-Lite", "soft", true],
  [/3CX\w*\s*([\d.]+)?/i, "3CX", "soft", true],
  [/Telephone\s*([\d.]+)?/i, "Telephone", "soft", true],
  [/Jitsi\s*([\d.]+)?/i, "Jitsi", "soft", true],
  [/Blink\s*([\d.]+)?/i, "Blink", "soft", true],
  [/(?:Groundwire|Acrobits)\s*([\d.]+)?/i, "Acrobits", "mobile", true],
  [/CSipSimple|Sipdroid|SIPDroid/i, "Android SIP", "mobile"],
  [/(?:JsSIP|SIP\.js|sipjs)\s*([\d.]+)?/i, "WebRTC", "soft", true],
];

export function parsePhoneModel(userAgent) {
  const ua = String(userAgent || "").trim();
  if (!ua) return { vendor: "", model: "", firmware: "", type: "unknown", ua: "" };
  for (const [re, vendor, type, versionOnly] of RULES) {
    const m = re.exec(ua);
    if (!m) continue;
    if (versionOnly) return { vendor, model: vendor, firmware: m[1] || "", type, ua };
    const model = (m[1] || "").replace(/_/g, " ").trim();
    return { vendor, model: model ? `${vendor} ${model.toUpperCase()}` : vendor, firmware: m[2] || "", type, ua };
  }
  const first = ua.split(/[\s/]/)[0];
  return { vendor: first, model: ua.slice(0, 40), firmware: "", type: "unknown", ua };
}

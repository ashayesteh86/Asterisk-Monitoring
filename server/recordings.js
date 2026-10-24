// Where a CDR recording lives on the PBX. Issabel/FreePBX store either a bare file name
// (in <monitor>/YYYY/MM/DD/) or a full path; anything outside the monitor directory is refused.
import path from "node:path";

export const AUDIO_TYPES = { wav: "audio/wav", wav49: "audio/wav", gsm: "audio/x-gsm", mp3: "audio/mpeg", ogg: "audio/ogg", opus: "audio/ogg" };
const NAME = /^[\w.+@=-]+\.(wav|wav49|gsm|mp3|ogg|opus)$/i;

export function recordingPaths(base, recordingfile, calldate) {
  const root = path.posix.normalize(String(base || "/var/spool/asterisk/monitor")).replace(/\/+$/, "");
  const file = String(recordingfile || "").trim();
  if (!file) return [];
  if (file.startsWith("/")) {
    const p = path.posix.normalize(file);
    return p.startsWith(`${root}/`) && NAME.test(path.posix.basename(p)) ? [p] : [];
  }
  const name = path.posix.basename(file);
  if (!NAME.test(name) || name !== file.split("/").pop()) return [];
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(calldate || ""));
  const out = [];
  if (file.includes("/")) {
    const rel = path.posix.normalize(file);
    if (!rel.startsWith("..")) out.push(`${root}/${rel}`);
  }
  if (m) out.push(`${root}/${m[1]}/${m[2]}/${m[3]}/${name}`);
  out.push(`${root}/${name}`);
  // Issabel may write .wav while CDR says .WAV (or the reverse)
  for (const p of [...out]) out.push(p.replace(/\.(\w+)$/, (x, e) => `.${e === e.toLowerCase() ? e.toUpperCase() : e.toLowerCase()}`));
  return [...new Set(out)];
}

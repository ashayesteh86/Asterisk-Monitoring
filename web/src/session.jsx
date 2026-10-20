// Logged-in user, phonebook name lookup and click-to-dial shared across pages.
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { api } from "./api.js";
import { useToast } from "./components/ui.jsx";

export const SessionCtx = createContext(null);
export const useSession = () => useContext(SessionCtx);

const normalize = (num) => {
  let d = String(num || "").replace(/\D/g, "");
  if (d.startsWith("0098")) d = "0" + d.slice(4);
  else if (d.startsWith("98") && d.length === 12) d = "0" + d.slice(2);
  else if (d.length === 10 && d.startsWith("9")) d = "0" + d;
  return d;
};

export function useContactsLookup(user) {
  const [map, setMap] = useState({});
  const reload = useCallback(() => api("/api/contacts/lookup").then(setMap).catch(() => {}), []);
  useEffect(() => { if (user) reload(); }, [user, reload]);
  const lookup = useCallback((num) => (num ? map[normalize(num)] || "" : ""), [map]);
  return { lookup, reload };
}

export function useDial() {
  const toast = useToast();
  const { me } = useSession();
  return useCallback(async (number, label, from) => {
    const src = from || me.user.extension;
    if (!src) { toast("برای تماس، داخلی شما باید در تنظیمات کاربر ثبت شده باشد", "error"); return false; }
    try {
      await api("/api/calls/originate", { method: "POST", body: { number, label, from: src } });
      toast(`تماس با ${label || number} — ابتدا تلفن داخلی ${src} زنگ می‌خورد`);
      return true;
    } catch (e) { toast(e.message, "error"); return false; }
  }, [me, toast]);
}

export { can, inScope, callInScope } from "./access.js";

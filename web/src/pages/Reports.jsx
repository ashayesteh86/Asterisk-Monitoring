// CDR reports with Shamsi (Jalali) date ranges: summary, daily/hourly charts, call list, per-extension, CSV export.
import { useEffect, useMemo, useState } from "react";
import { api, withServer } from "../api.js";
import { useSession, useDial, can } from "../session.jsx";
import { useLive } from "../live.js";
import { fa, faNum, dur, durLong, jOf, fromJ, jString, parseJ, jFromSql, sqlDate, MONTHS, jalaaliMonthLength } from "../jalali.js";
import { Icon, Tabs, Empty, Spinner, useToast } from "../components/ui.jsx";
import JalaliDatePicker from "../components/JalaliDatePicker.jsx";
import BarChart from "../components/BarChart.jsx";

const DISP = {
  ANSWERED: { label: "پاسخ داده شده", color: "idle" }, "NO ANSWER": { label: "بی‌پاسخ", color: "ring" },
  BUSY: { label: "مشغول", color: "talk" }, FAILED: { label: "ناموفق", color: "off" }, CONGESTION: { label: "ازدحام", color: "off" },
};
const DIRS = { inbound: { label: "ورودی", icon: "phoneIn" }, outbound: { label: "خروجی", icon: "phoneOut" }, internal: { label: "داخلی", icon: "phone" }, other: { label: "سایر", icon: "phone" } };

function presets() {
  const today = new Date();
  const t = jOf(today);
  const daysAgo = (n) => jOf(new Date(today.getFullYear(), today.getMonth(), today.getDate() - n));
  const dow = (today.getDay() + 1) % 7; // Saturday = 0
  const prevM = t.jm === 1 ? { jy: t.jy - 1, jm: 12 } : { jy: t.jy, jm: t.jm - 1 };
  return [
    { id: "today", label: "امروز", from: t, to: t },
    { id: "yesterday", label: "دیروز", from: daysAgo(1), to: daysAgo(1) },
    { id: "week", label: "این هفته", from: daysAgo(dow), to: t },
    { id: "7d", label: "۷ روز اخیر", from: daysAgo(6), to: t },
    { id: "month", label: `${MONTHS[t.jm - 1]}`, from: { jy: t.jy, jm: t.jm, jd: 1 }, to: t },
    { id: "prev", label: `${MONTHS[prevM.jm - 1]}`, from: { ...prevM, jd: 1 }, to: { ...prevM, jd: jalaaliMonthLength(prevM.jy, prevM.jm) } },
    { id: "30d", label: "۳۰ روز اخیر", from: daysAgo(29), to: t },
  ];
}

export default function Reports() {
  const { me } = useSession();
  const toast = useToast();
  const ps = useMemo(presets, []);
  const [f, setF] = useState({ from: jString(ps[3].from), to: jString(ps[3].to), fromTime: "00:00", toTime: "23:59", direction: "", disposition: "", number: "", extension: "", minDuration: "", recorded: "" });
  const [applied, setApplied] = useState(f);
  const [tab, setTab] = useState("summary");
  const [stats, setStats] = useState(null);
  const [list, setList] = useState(null);
  const [page, setPage] = useState(0);
  const [err, setErr] = useState("");
  const PAGE = 50;

  const query = (x = applied) => {
    const p = new URLSearchParams();
    const a = parseJ(x.from), b = parseJ(x.to);
    if (a) p.set("from", `${sqlDate(fromJ(a)).slice(0, 10)} ${x.fromTime || "00:00"}:00`);
    if (b) p.set("to", `${sqlDate(fromJ(b)).slice(0, 10)} ${x.toTime || "23:59"}:59`);
    for (const k of ["direction", "disposition", "number", "extension", "minDuration", "recorded"]) if (x[k]) p.set(k, x[k]);
    return p;
  };

  useEffect(() => {
    setErr("");
    if (tab === "list") {
      setList(null);
      const p = query(); p.set("limit", PAGE); p.set("offset", page * PAGE);
      api(`/api/cdr?${p}`).then(setList).catch((e) => setErr(e.message));
    } else {
      setStats(null);
      api(`/api/cdr/stats?${query()}`).then(setStats).catch((e) => setErr(e.message));
    }
  }, [applied, tab, page]);

  const apply = (next = f) => { setPage(0); setApplied({ ...next }); };
  const preset = (p) => { const n = { ...f, from: jString(p.from), to: jString(p.to) }; setF(n); apply(n); };
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-lg font-bold">گزارش تماس‌ها</h1>
        <div className="flex-1" />
        {can(me.user, "reports.export") && <a className="btn btn-sm" href={withServer(`/api/cdr/export.csv?${query()}`)}><Icon name="download" className="size-4" />خروجی Excel (CSV)</a>}
      </div>

      <div className="card space-y-3 p-4">
        <div className="flex flex-wrap gap-1.5">
          {ps.map((p) => {
            const active = applied.from === jString(p.from) && applied.to === jString(p.to);
            return <button key={p.id} className={`btn btn-sm ${active ? "!border-accent !bg-accent-soft !text-accent" : ""}`} onClick={() => preset(p)}>{p.label}</button>;
          })}
        </div>
        <form className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8" onSubmit={(e) => { e.preventDefault(); apply(); }}>
          <div><span className="label">از تاریخ</span><JalaliDatePicker value={f.from} onChange={(v) => setF({ ...f, from: v })} /></div>
          <div><span className="label">ساعت</span><input type="time" className="input num" value={f.fromTime} onChange={set("fromTime")} /></div>
          <div><span className="label">تا تاریخ</span><JalaliDatePicker value={f.to} onChange={(v) => setF({ ...f, to: v })} /></div>
          <div><span className="label">ساعت</span><input type="time" className="input num" value={f.toTime} onChange={set("toTime")} /></div>
          <div><span className="label">نوع تماس</span>
            <select className="input" value={f.direction} onChange={set("direction")}><option value="">همه</option><option value="inbound">ورودی</option><option value="outbound">خروجی</option><option value="internal">داخلی</option></select></div>
          <div><span className="label">وضعیت</span>
            <select className="input" value={f.disposition} onChange={set("disposition")}><option value="">همه</option>{Object.entries(DISP).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></div>
          <div><span className="label">شماره</span><input className="input num ltr text-left" value={f.number} onChange={set("number")} placeholder="0912…" /></div>
          {me.user.scopes?.reports?.mode === "self" && !me.user.isAdmin ? (
            <div><span className="label">داخلی</span><input className="input num" disabled value={fa(me.user.extension)} /></div>
          ) : (
            <div><span className="label">داخلی (با , جدا کنید)</span><input className="input num ltr text-left" value={f.extension} onChange={set("extension")} placeholder="101,102" /></div>
          )}
          <div className="col-span-2 flex items-end gap-2 md:col-span-4 xl:col-span-8">
            <div className="w-40"><span className="label">حداقل مدت مکالمه (ثانیه)</span><input className="input num" value={f.minDuration} onChange={set("minDuration")} inputMode="numeric" /></div>
            <label className="mb-2 flex items-center gap-2 text-sm"><input type="checkbox" checked={f.recorded === "1"} onChange={(e) => setF({ ...f, recorded: e.target.checked ? "1" : "" })} />فقط تماس‌های ضبط‌شده</label>
            <div className="flex-1" />
            <button className="btn btn-primary"><Icon name="search" className="size-4" />نمایش گزارش</button>
          </div>
        </form>
      </div>

      <Tabs value={tab} onChange={(t) => { setTab(t); setPage(0); }} tabs={[
        { id: "summary", label: "خلاصه و نمودار", icon: "chart" },
        { id: "list", label: "لیست تماس‌ها", icon: "list" },
        { id: "ext", label: "بر اساس داخلی", icon: "users" },
      ]} />

      {err ? <div className="card"><Empty icon="alert" title="گزارش بارگذاری نشد">{err}{can(me.user, "settings.manage") && " — اتصال دیتابیس CDR را در تنظیمات بررسی کنید."}</Empty></div>
        : tab === "list" ? <CallList data={list} page={page} setPage={setPage} pageSize={PAGE} />
        : !stats ? <div className="card p-12 text-center"><Spinner /></div>
        : tab === "summary" ? <Summary stats={stats} applied={applied} /> : <ByExtension stats={stats} />}
    </div>
  );
}

function Tile({ label, value, sub, tone }) {
  return (
    <div className="card p-4">
      <div className="text-xs text-ink-3">{label}</div>
      <div className={`num mt-1 font-bold ${String(value).length > 12 ? "text-lg leading-8" : "text-2xl"} ${tone ? `text-${tone}` : ""}`}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-ink-3">{sub}</div>}
    </div>
  );
}

const pct = (a, b) => (b ? fa(`${Math.round((a / b) * 100)}٪`) : "—");

function Summary({ stats }) {
  const t = stats.totals;
  const { lookup } = useSession();
  const dial = useDial();
  const days = stats.byDay.map((d) => {
    const [y, m, dd] = d.day.split("-").map(Number);
    const j = jOf(new Date(y, m - 1, dd));
    return { label: fa(`${j.jm}/${j.jd}`), title: jFromSql(d.day, false), answered: d.answered, missed: d.total - d.answered };
  });
  const hours = Array.from({ length: 24 }, (_, h) => {
    const r = stats.byHour.find((x) => Number(x.hour) === h);
    return { label: fa(h), title: fa(`ساعت ${h}:۰۰ تا ${h + 1}:۰۰`), answered: r?.answered || 0, missed: (r?.total || 0) - (r?.answered || 0) };
  }).filter((_, h) => h >= 6 && h <= 23 || stats.byHour.some((x) => Number(x.hour) === h));
  const series = [{ key: "answered", label: "پاسخ داده شده", color: "var(--series-1)" }, { key: "missed", label: "بی‌پاسخ / مشغول / ناموفق", color: "var(--series-2)" }];

  if (!t.total) return <div className="card"><Empty icon="chart" title="در این بازه تماسی ثبت نشده" /></div>;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Tile label="کل تماس‌ها" value={faNum(t.total)} sub={`${faNum(t.inbound)} ورودی · ${faNum(t.outbound)} خروجی · ${faNum(t.internal)} داخلی`} />
        <Tile label="پاسخ داده شده" value={faNum(t.answered)} sub={`${pct(t.answered, t.total)} از کل`} tone="idle" />
        <Tile label="بی‌پاسخ" value={faNum(t.noAnswer)} sub={pct(t.noAnswer, t.total)} tone="ring" />
        <Tile label="مشغول / ناموفق" value={faNum(t.busy + t.failed)} sub={`${faNum(t.busy)} مشغول · ${faNum(t.failed)} ناموفق`} tone="talk" />
        <Tile label="مجموع مکالمه" value={durLong(t.talk)} />
        <Tile label="میانگین مکالمه" value={dur(t.avgTalk)} sub={`طولانی‌ترین: ${dur(t.maxTalk)}`} />
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <div className="card p-4">
          <h3 className="mb-3 text-sm font-semibold">تماس‌ها به تفکیک روز</h3>
          <BarChart data={days} series={series} />
        </div>
        <div className="card p-4">
          <h3 className="mb-3 text-sm font-semibold">توزیع ساعتی تماس‌ها</h3>
          <BarChart data={hours} series={series} labelEvery={1} />
        </div>
      </div>
      {stats.topNumbers.length > 0 && (
        <div className="card overflow-x-auto">
          <div className="border-b border-line px-4 py-3 text-sm font-semibold">بیشترین تماس‌گیرندگان (ورودی)</div>
          <table className="grid-table">
            <thead><tr><th>#</th><th>شماره</th><th>نام در دفترچه</th><th>تعداد تماس</th><th>مجموع مکالمه</th><th /></tr></thead>
            <tbody>{stats.topNumbers.map((r, i) => (
              <tr key={r.number}><td className="num text-ink-3">{fa(i + 1)}</td><td className="num ltr text-right">{fa(r.number)}</td><td>{lookup(r.number) || <span className="text-ink-3">—</span>}</td>
                <td className="num">{faNum(r.total)}</td><td className="num">{dur(r.talk)}</td>
                <td className="text-left"><button className="btn btn-sm" onClick={() => dial(r.number, lookup(r.number))}><Icon name="phone" className="size-4 text-idle" />تماس</button></td></tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function CallList({ data, page, setPage, pageSize }) {
  const { lookup } = useSession();
  const dial = useDial();
  const peers = useLive((s) => s.peers);
  const { me } = useSession();
  const [play, setPlay] = useState(null); // {src, row}
  const toast = useToast();
  const canRec = can(me.user, "reports.recordings");
  const mode = data?.recordings || "ssh";
  const recSrc = (r, download) => (mode === "url" ? r.recordingUrl : withServer(`/api/cdr/recording?uniqueid=${encodeURIComponent(r.uniqueid)}${download ? "&download=1" : ""}`));
  const hasRec = (r) => canRec && mode !== "off" && (mode === "url" ? !!r.recordingUrl : r.hasRecording);
  if (!data) return <div className="card p-12 text-center"><Spinner /></div>;
  if (!data.rows.length) return <div className="card"><Empty icon="list" title="تماسی با این فیلترها پیدا نشد" /></div>;
  const pages = Math.ceil(data.total / pageSize);
  const Num = ({ n }) => {
    const name = lookup(n) || peers[n]?.callerName;
    return (
      <div className="min-w-0">
        <button className="num ltr hover:text-accent" title="تماس" onClick={() => dial(n, name)}>{fa(n)}</button>
        {name && <div className="truncate text-[11px] text-ink-3">{name}</div>}
      </div>
    );
  };
  return (
    <div className="card">
      {play && (
        <div className="sticky top-14 z-10 flex flex-wrap items-center gap-3 border-b border-line bg-surface px-4 py-3">
          <Icon name="play" className="size-4 text-accent" />
          <div className="min-w-0 text-sm">
            <div className="font-medium"><span className="num ltr">{fa(play.row.src)}</span> ← <span className="num ltr">{fa(play.row.dst)}</span></div>
            <div className="num text-xs text-ink-3">{jFromSql(play.row.calldate)} · {dur(play.row.billsec)}</div>
          </div>
          <audio key={play.src} src={play.src} controls autoPlay className="h-9 min-w-64 flex-1" onError={() => toast("پخش فایل ضبط ممکن نشد (فایل روی سرور نیست یا کاربر SSH اجازه خواندن ندارد)", "error")} />
          <a className="btn btn-sm" href={recSrc(play.row, true)} download><Icon name="download" className="size-4" />دانلود</a>
          <button className="btn btn-sm" onClick={() => setPlay(null)} aria-label="بستن"><Icon name="x" className="size-4" /></button>
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="grid-table">
          <thead><tr><th>تاریخ و ساعت</th><th>نوع</th><th>مبدأ</th><th>مقصد</th><th>وضعیت</th><th>مدت مکالمه</th><th>مدت کل</th><th>مسیر</th><th>ضبط</th></tr></thead>
          <tbody>
            {data.rows.map((r, i) => {
              const d = DISP[r.disposition] || { label: r.disposition, color: "off" };
              const dir = DIRS[r.direction];
              return (
                <tr key={`${r.uniqueid}-${i}`}>
                  <td className="num whitespace-nowrap">{jFromSql(r.calldate)}</td>
                  <td><span className="flex items-center gap-1 text-ink-2"><Icon name={dir.icon} className="size-4" />{dir.label}</span></td>
                  <td><Num n={r.src} /></td>
                  <td><Num n={r.dst} /></td>
                  <td><span className={`chip bg-${d.color}-soft text-${d.color}`}>{d.label}</span></td>
                  <td className="num">{r.billsec ? dur(r.billsec) : "—"}</td>
                  <td className="num text-ink-3">{dur(r.duration)}</td>
                  <td className="max-w-48 truncate text-[11px] text-ink-3 ltr text-right" title={`${r.channel} → ${r.dstchannel}`}>{r.channel.split("-")[0]} → {r.dstchannel.split("-")[0] || "—"}</td>
                  <td className="whitespace-nowrap">
                    {hasRec(r) ? (
                      <span className="flex gap-1">
                        <button className={`btn btn-sm ${play?.row === r ? "!border-accent !bg-accent-soft !text-accent" : ""}`} onClick={() => setPlay({ src: recSrc(r), row: r })} aria-label="پخش ضبط" title="پخش"><Icon name="play" className="size-4" /></button>
                        <a className="btn btn-sm" href={recSrc(r, true)} download aria-label="دانلود ضبط" title="دانلود"><Icon name="download" className="size-4" /></a>
                      </span>
                    ) : <span className="text-ink-3">—</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-3 text-sm">
        <span className="text-ink-3">{faNum(data.total)} رکورد · صفحه {faNum(page + 1)} از {faNum(pages)}</span>
        <div className="flex-1" />
        <button className="btn btn-sm" disabled={page === 0} onClick={() => setPage(page - 1)}><Icon name="chevronR" className="size-4" />قبلی</button>
        <button className="btn btn-sm" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>بعدی<Icon name="chevronL" className="size-4" /></button>
      </div>
    </div>
  );
}

function ByExtension({ stats }) {
  const peers = useLive((s) => s.peers);
  const rows = stats.byExtension;
  const [sort, setSort] = useState("total");
  const sorted = [...rows].sort((a, b) => {
    if (sort === "ext") return a.ext.localeCompare(b.ext, "en", { numeric: true });
    if (sort === "talk") return b.inTalk + b.outTalk - a.inTalk - a.outTalk;
    if (sort === "missed") return (b.inTotal - b.inAnswered) - (a.inTotal - a.inAnswered);
    return b.inTotal + b.outTotal - a.inTotal - a.outTotal;
  });
  if (!rows.length) return <div className="card"><Empty icon="users" title="داده‌ای برای داخلی‌ها نیست" /></div>;
  const maxTalk = Math.max(1, ...rows.map((r) => r.inTalk + r.outTalk));
  const H = ({ id, children }) => <th><button className={sort === id ? "text-accent" : ""} onClick={() => setSort(id)}>{children}</button></th>;
  return (
    <div className="card overflow-x-auto">
      <table className="grid-table">
        <thead><tr><H id="ext">داخلی</H><th>نام</th><th>ورودی (پاسخ/کل)</th><H id="missed">بی‌پاسخ ورودی</H><th>خروجی (موفق/کل)</th><H id="total">کل تماس</H><H id="talk">مجموع مکالمه</H></tr></thead>
        <tbody>{sorted.map((r) => {
          const talk = r.inTalk + r.outTalk;
          return (
            <tr key={r.ext}>
              <td className="num font-semibold">{fa(r.ext)}</td>
              <td className="text-ink-2">{peers[r.ext]?.callerName || "—"}</td>
              <td className="num">{faNum(r.inAnswered)} / {faNum(r.inTotal)}</td>
              <td className={`num ${r.inTotal - r.inAnswered ? "text-ring" : "text-ink-3"}`}>{faNum(r.inTotal - r.inAnswered)}</td>
              <td className="num">{faNum(r.outAnswered)} / {faNum(r.outTotal)}</td>
              <td className="num font-medium">{faNum(r.inTotal + r.outTotal)}</td>
              <td className="min-w-48">
                <div className="flex items-center gap-2">
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-surface-2"><div className="h-full rounded-full" style={{ width: `${(talk / maxTalk) * 100}%`, background: "var(--series-1)" }} /></div>
                  <span className="num w-20 text-left text-xs">{dur(talk)}</span>
                </div>
              </td>
            </tr>
          );
        })}</tbody>
      </table>
    </div>
  );
}

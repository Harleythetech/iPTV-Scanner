(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const STATES = ["online", "reachable", "offline", "skipped"];
  const LABEL = {
    online: "Online",
    reachable: "Reachable",
    offline: "Offline",
    skipped: "Skipped",
    pending: "Pending",
    checking: "Checking",
  };
  let channels = [],
    ctrl = null,
    running = false,
    filter = "all",
    dupes = 0;

  // ---- Parsing -------------------------------------------------------------
  function parseM3U(text) {
    const out = [],
      seen = new Set();
    let meta = null,
      dup = 0;
    for (const raw of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith("#EXTINF")) {
        const masked = line.replace(/"[^"]*"/g, (m) => "_".repeat(m.length)); // ignore commas inside attributes
        const i = masked.indexOf(",");
        meta = {
          info: line,
          name: i >= 0 ? line.slice(i + 1).trim() : "",
          group: (line.match(/group-title="([^"]*)"/i) || [])[1] || "",
        };
      } else if (!line.startsWith("#")) {
        if (seen.has(line)) {
          dup++;
          meta = null;
          continue;
        }
        seen.add(line);
        out.push({
          name: meta?.name || line,
          group: meta?.group || "",
          url: line,
          info: meta?.info || `#EXTINF:-1,${line}`,
          status: "pending",
          code: "",
          note: "",
        });
        meta = null;
      }
    }
    return { list: out, dup };
  }

  // ---- Checking ------------------------------------------------------------
  async function probe(url, signal, cfg) {
    if (!/^https?:\/\//i.test(url))
      return {
        status: "skipped",
        code: "–",
        note: `Not testable in a browser (${url.split(":")[0]})`,
      };
    if (location.protocol === "https:" && /^http:/i.test(url) && !cfg.proxy)
      return {
        status: "skipped",
        code: "–",
        note: "HTTP stream blocked on an HTTPS page",
      };
    const target = cfg.proxy ? cfg.proxy + encodeURIComponent(url) : url;
    const t = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      t.abort();
    }, cfg.timeout);
    const onStop = () => t.abort();
    signal.addEventListener("abort", onStop);
    try {
      let res;
      try {
        res = await fetch(target, { signal: t.signal, cache: "no-store" });
      } catch {
        if (t.signal.aborted) throw 0;
        // CORS blocked the read. A resolved no-cors fetch still proves the server answered.
        await fetch(target, {
          mode: "no-cors",
          signal: t.signal,
          cache: "no-store",
        });
        return {
          status: "reachable",
          code: "?",
          note: "Server responded; CORS hides the result",
        };
      }
      if (!res.ok)
        return { status: "offline", code: res.status, note: "HTTP error" };
      const type = res.headers.get("content-type") || "";
      const reader = res.body?.getReader();
      const { value } = reader ? await reader.read() : {};
      if (/html/i.test(type))
        return {
          status: "offline",
          code: res.status,
          note: "Returned a web page, not a stream",
        };
      const head = value ? new TextDecoder().decode(value.slice(0, 2048)) : "";
      const hls =
        /mpegurl/i.test(type) ||
        /\.m3u8?(\?|$)/i.test(url) ||
        head.startsWith("#EXTM3U");
      if (hls && !head.startsWith("#EXTM3U"))
        return {
          status: "offline",
          code: res.status,
          note: "Invalid HLS playlist",
        };
      if (!value?.length)
        return { status: "offline", code: res.status, note: "Empty response" };
      return {
        status: "online",
        code: res.status,
        note: hls ? "HLS playlist OK" : "Stream data received",
      };
    } catch {
      return {
        status: "offline",
        code: "–",
        retry: !signal.aborted,
        note: timedOut ? "Timed out" : "Unreachable (DNS, refused or blocked)",
      };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onStop);
      t.abort(); // stop downloading the live stream
    }
  }

  async function check(url, signal, cfg) {
    let r = await probe(url, signal, cfg);
    if (r.retry && !signal.aborted) r = await probe(url, signal, cfg); // one retry for flaky hosts
    return r;
  }

  async function runPool(signal) {
    const cfg = {
      timeout: Number($("timeout").value),
      proxy: $("proxy").value.trim(),
    };
    const queue = channels.filter((c) => c.status === "pending");
    let next = 0;
    const worker = async () => {
      while (!signal.aborted) {
        const c = queue[next++];
        if (!c) return;
        c.status = "checking";
        paint(c);
        const r = await check(c.url, signal, cfg);
        if (signal.aborted) {
          c.status = "pending";
          paint(c);
          return;
        }
        Object.assign(c, { status: r.status, code: r.code, note: r.note });
        paint(c);
        stats();
      }
    };
    await Promise.all(Array.from({ length: Number($("conc").value) }, worker));
  }

  // ---- Rendering -----------------------------------------------------------
  const cell = (text) => {
    const td = document.createElement("td");
    td.textContent = text ?? "";
    return td;
  };

  function render() {
    const frag = document.createDocumentFragment();
    channels.forEach((c, i) => {
      const tr = document.createElement("tr");
      const name = cell("");
      const b = document.createElement("b");
      b.textContent = c.name;
      b.style.fontWeight = "500";
      name.append(b);
      if (c.group) {
        const g = document.createElement("small");
        g.textContent = c.group;
        name.append(g);
      }
      c.cells = { st: cell(""), code: cell(""), note: cell("") };
      c.tr = tr;
      tr.append(cell(i + 1), name, c.cells.st, c.cells.code, c.cells.note);
      frag.append(tr);
      paint(c);
    });
    $("rows").replaceChildren(frag);
    $("results").hidden = false;
  }

  function applyFilter(c) {
    const q = $("q").value.trim().toLowerCase();
    const okStatus = filter === "all" || c.status === filter;
    c.tr.hidden = !(
      okStatus &&
      (!q || `${c.name} ${c.group}`.toLowerCase().includes(q))
    );
  }

  function paint(c) {
    c.tr.dataset.s = c.status;
    c.cells.st.textContent = LABEL[c.status];
    c.cells.code.textContent = c.code;
    c.cells.note.textContent = c.note;
    applyFilter(c);
  }

  function stats() {
    const n = { online: 0, reachable: 0, offline: 0, skipped: 0 };
    let done = 0;
    for (const c of channels)
      if (c.status in n) {
        n[c.status]++;
        done++;
      }
    document
      .querySelectorAll(".meter i[data-s]")
      .forEach((i) => (i.style.flexGrow = n[i.dataset.s]));
    $("pend").style.flexGrow = channels.length - done;
    STATES.forEach((k) => ($("n-" + k).textContent = n[k]));
    $("n-all").textContent = channels.length;
    $("export").disabled = !(n.online || ($("incl").checked && n.reachable));
    if (running)
      $("status").textContent = `Checked ${done} of ${channels.length}…`;
    return n;
  }

  function setRunning(on) {
    running = on;
    const b = $("scan");
    b.textContent = on ? "Stop" : "Scan playlist";
    b.classList.toggle("running", on);
  }

  // ---- Actions -------------------------------------------------------------
  async function loadText(signal) {
    const f = $("file").files[0];
    if (f) return f.text();
    const u = $("url").value.trim();
    if (!u) throw new Error("Enter a playlist URL or choose an M3U file.");
    const p = $("proxy").value.trim();
    let r;
    try {
      r = await fetch(p ? p + encodeURIComponent(u) : u, { signal });
    } catch (e) {
      if (e.name === "AbortError") throw e;
      throw new Error(
        "Could not download the playlist. The host may block browser requests: save the file and upload it, or set a proxy in Scan settings.",
      );
    }
    if (!r.ok) throw new Error(`The playlist server returned ${r.status}.`);
    return r.text();
  }

  async function scan() {
    ctrl = new AbortController();
    const signal = ctrl.signal;
    setRunning(true);
    $("status").textContent = "Loading playlist…";
    try {
      const { list, dup } = parseM3U(await loadText(signal));
      if (!list.length)
        throw new Error(
          "No channels found. Check that this is an M3U playlist.",
        );
      channels = list;
      dupes = dup;
      render();
      stats();
      await runPool(signal);
      const n = stats();
      const extra = dupes
        ? ` ${dupes} duplicate URL${dupes > 1 ? "s" : ""} removed.`
        : "";
      setRunning(false);
      $("status").textContent =
        (signal.aborted ? "Stopped. " : "Finished. ") +
        `${n.online} online, ${n.reachable} reachable, ${n.offline} offline, ${n.skipped} skipped.${extra}`;
    } catch (e) {
      setRunning(false);
      $("status").textContent =
        e.name === "AbortError" ? "Stopped." : e.message;
    }
  }

  function exportM3U() {
    const keep = channels.filter(
      (c) =>
        c.status === "online" ||
        (c.status === "reachable" && $("incl").checked),
    );
    const body =
      "#EXTM3U\n" + keep.map((c) => `${c.info}\n${c.url}`).join("\n") + "\n";
    const a = document.createElement("a");
    const href = URL.createObjectURL(
      new Blob([body], { type: "audio/x-mpegurl" }),
    );
    a.href = href;
    a.download = `playlist-working-${new Date().toISOString().slice(0, 10)}.m3u`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(href), 1000);
  }

  function clearAll() {
    ctrl?.abort();
    channels = [];
    dupes = 0;
    $("rows").replaceChildren();
    $("results").hidden = true;
    $("file").value = "";
    $("url").value = "";
    $("q").value = "";
    $("export").disabled = true;
    setRunning(false);
    $("status").textContent = "Add a playlist URL or M3U file to begin.";
  }

  document.addEventListener("DOMContentLoaded", () => {
    $("scan").addEventListener("click", () =>
      running ? ctrl.abort() : scan(),
    );
    $("export").addEventListener("click", exportM3U);
    $("clear").addEventListener("click", clearAll);
    $("incl").addEventListener("change", stats);
    $("url").addEventListener("input", () => ($("file").value = "")); // newest input wins
    $("file").addEventListener("change", () => ($("url").value = ""));
    $("q").addEventListener("input", () => channels.forEach(applyFilter));
    document.querySelectorAll(".filters button").forEach((b) =>
      b.addEventListener("click", () => {
        filter = b.dataset.f;
        document
          .querySelectorAll(".filters button")
          .forEach((x) => x.setAttribute("aria-pressed", x === b));
        channels.forEach(applyFilter);
      }),
    );
  });
})();

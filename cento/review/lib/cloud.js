/* 雲端同步 (TEST BUILD, branch feature/cloud-sync): the board's notes, statuses
 * and annotations shared through one Google Sheet.
 *
 * Sign-in: the panel opens the user's own browser at Google (Google does not
 * allow signing in inside an embedded browser) and listens on 127.0.0.1 for
 * the answer -- the installed-app flow with PKCE. The refresh token is kept in
 * localStorage, so it is one sign-in per computer. The OAuth client is read
 * from cloud.local.json next to index.html, which is not in git:
 *   { "clientId": "...apps.googleusercontent.com", "clientSecret": "...",
 *     "apiKey": "...", "appId": "<project number>" }
 *
 * Scope: drive.file only -- CENTO reaches the sheets it made, and the ones a
 * user hands it. A colleague's sheet is handed over once through Google's
 * file picker, shown in the user's own browser (signed in there already).
 *
 * The sheet ("CENTO · <board>"):
 *   工作表「卡」     卡號 | id | 建立者 -- the cut list, written once by whoever started
 *   工作表「紀錄」   時間 | 名字 | 動作 | 卡號 | 格 | 內容 | 人 | 卡 | 資料 -- rows only appended
 * Each person's notes, marks and statuses are the replay of their own rows,
 * so nobody overwrites anybody. The sheet id is kept on the board (P.cloud).
 *
 *   工作表「片」     what 雲端看片 shows (G.film): row 1  video | file id | version | fps,
 *                    row 2  board | the board as JSON, cut over the columns,
 *                    then   thumb | cut id | the cut's still as a data: URL
 *
 * In After Effects Google is reached through Node (https), so nothing depends
 * on CORS. In 雲端看片 (lib/cloud-view.js, a plain browser) it is fetch, and
 * signing in is Google's own pop-up (a token for an hour, no refresh token).
 */
(function () {
  var CLOUDV = typeof CLOUD !== "undefined" && CLOUD;
  if (typeof WEB !== "undefined" && WEB && !CLOUDV) return;      // a 網頁看片 viewer: the computer running AE does the syncing
  var SCOPE = "https://www.googleapis.com/auth/drive.file";
  var SHEETS = "https://sheets.googleapis.com/v4/spreadsheets", DRIVE = "https://www.googleapis.com/drive/v3";
  var LOG = "紀錄", CUTS = "卡", FILM = "片", CELL = 40000, EVERY = 3000;
  var AUTH_LS = "cento.cloud.auth", TOKEN_LS = "cento.cloud.token";
  var cfg = null, auth = null, access = null, accessUntil = 0;
  try { auth = JSON.parse(localStorage.getItem(AUTH_LS) || "null"); } catch (e) {}
  if (auth && auth.scope !== SCOPE) auth = null;       // signed in for other permissions: sign in again
  if (auth && !!auth.browser !== CLOUDV) auth = null;  // the other kind of sign-in
  if (CLOUDV) try {
    var tk0 = JSON.parse(localStorage.getItem(TOKEN_LS) || "null");
    if (tk0 && tk0.until > Date.now()) { access = tk0.t; accessUntil = tk0.until; }
  } catch (e) {}

  function node(name) { return window.CEP && CEP.nodeRequire ? CEP.nodeRequire(name) : null; }
  function config() {
    if (cfg) return cfg;
    if (CLOUDV) {                       // the public half of the client, written into the page when it is published
      cfg = window.CENTO_CLOUD_CFG;
      if (!cfg || !cfg.webClientId) throw new Error("這個網頁還沒設定 Google 登入");
      return cfg;
    }
    var base = window.CEP && CEP.extensionPath && CEP.extensionPath();
    var text = base ? CEP.readText(base + "/cloud.local.json") : null;
    if (!text) throw new Error("找不到 cloud.local.json（測試版需要它）");
    return (cfg = JSON.parse(text));
  }

  // ---- HTTPS through Node ---------------------------------------------------
  function request(method, url, headers, body) {
    if (CLOUDV) return fetch(url, { method: method, headers: headers || {}, body: body || undefined }).then(function (r) {
      return r.text().then(function (t) { return { status: r.status, text: t }; });
    }, function (e) { throw new Error("連不到 Google（" + e.message + "）"); });
    return new Promise(function (ok, no) {
      var https = node("https");
      if (!https) return no(new Error("這個環境不能連網（要在 AE 裡用）"));
      var u = new URL(url);
      var r = https.request({ method: method, hostname: u.hostname, path: u.pathname + u.search, headers: headers || {} }, function (res) {
        var chunks = [];
        res.on("data", function (c) { chunks.push(c); });
        res.on("end", function () {
          var text = Buffer_concat(chunks);
          ok({ status: res.statusCode, text: text, headers: res.headers });
        });
      });
      r.on("error", function (e) { no(new Error("連不到 Google（" + e.message + "）")); });
      r.setTimeout(30000, function () { r.destroy(new Error("逾時")); });
      if (body) r.write(body);
      r.end();
    });
  }
  function Buffer_concat(chunks) {          // Node's Buffer lives in the Node context; join before decoding
    var B = node("buffer").Buffer;
    return B.concat(chunks).toString("utf8");
  }
  function form(o) {
    return Object.keys(o).map(function (k) { return encodeURIComponent(k) + "=" + encodeURIComponent(o[k]); }).join("&");
  }
  function b64url(buf) { return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }

  // ---- sign in: the user's browser, an answer on 127.0.0.1 -------------------
  var waiting = null;
  function script(src) {
    return new Promise(function (ok, no) {
      var s = document.createElement("script");
      s.src = src; s.onload = ok; s.onerror = function () { no(new Error("連不到 Google")); };
      document.head.appendChild(s);
    });
  }
  // 雲端看片: Google's pop-up hands over a token for an hour. Must be called from a tap.
  function loginBrowser() {
    var c = config();
    return (window.google && google.accounts && google.accounts.oauth2 ? Promise.resolve() : script("https://accounts.google.com/gsi/client"))
      .then(function () {
        return new Promise(function (ok, no) {
          google.accounts.oauth2.initTokenClient({
            client_id: c.webClientId, scope: SCOPE, login_hint: auth ? auth.email : undefined,
            callback: function (t) {
              if (!t || !t.access_token) return no(new Error((t && t.error) || "沒有登入"));
              access = t.access_token; accessUntil = Date.now() + (Number(t.expires_in) - 120) * 1000;
              try { localStorage.setItem(TOKEN_LS, JSON.stringify({ t: access, until: accessUntil })); } catch (e) {}
              api("GET", DRIVE + "/about?fields=user(emailAddress)").then(function (a) {
                auth = { email: a.user.emailAddress, scope: SCOPE, browser: true };
                try { localStorage.setItem(AUTH_LS, JSON.stringify(auth)); } catch (e) {}
                ok(auth.email);
              }, no);
            },
            error_callback: function (e) { no(new Error(e && e.type === "popup_closed" ? "登入視窗關掉了" : (e && (e.message || e.type)) || "沒有登入")); }
          }).requestAccessToken({ prompt: auth ? "" : "consent" });
        });
      });
  }
  // 雲端看片: Google's file picker, in this page, showing only these files
  function pickBrowser(ids) {
    var c = config();
    return token().then(function (tk) {
      return (window.gapi ? Promise.resolve() : script("https://apis.google.com/js/api.js")).then(function () {
        return new Promise(function (ok) {
          gapi.load("picker", function () {
            var v = new google.picker.DocsView(google.picker.ViewId.DOCS).setFileIds(ids.join(",")).setMode(google.picker.DocsViewMode.LIST);
            new google.picker.PickerBuilder().addView(v).enableFeature(google.picker.Feature.MULTISELECT_ENABLED)
              .setOAuthToken(tk).setDeveloperKey(c.apiKey).setAppId(String(c.appId)).setTitle("兩個都勾起來，按「選取」")
              .setCallback(function (d) {
                if (d.action === "picked") ok((d.docs || []).map(function (x) { return x.id; }));
                else if (d.action === "cancel") ok(null);
              }).build().setVisible(true);
          });
        });
      });
    });
  }
  // 雲端看片: the film, as a Blob, saying how far along it is
  async function media(id, progress) {
    var tk = await token();
    var r = await fetch(DRIVE + "/files/" + id + "?alt=media", { headers: { Authorization: "Bearer " + tk } });
    if (r.status === 401) { access = null; var e = new Error("auth"); e.auth = true; throw e; }
    if (!r.ok) { var e2 = new Error("Google " + r.status); e2.status = r.status; throw e2; }
    var all = Number(r.headers.get("Content-Length")) || 0, got = 0, parts = [], rd = r.body && r.body.getReader();
    if (!rd) return r.blob();
    for (;;) {
      var x = await rd.read();
      if (x.done) break;
      parts.push(x.value); got += x.value.length;
      if (progress) progress(got, all);
    }
    return new Blob(parts, { type: "video/mp4" });
  }
  function login() {
    if (CLOUDV) return loginBrowser();
    if (waiting) return waiting;
    waiting = new Promise(function (ok, no) {
      var http = node("http"), crypto = node("crypto");
      if (!http || !crypto) return no(new Error("這個環境不能登入（要在 AE 裡用）"));
      var c = config();
      var verifier = b64url(crypto.randomBytes(32));
      var challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
      var state = b64url(crypto.randomBytes(12)), port = 0, done = false;
      var server = http.createServer(function (q, s) {
        var u = new URL(q.url, "http://127.0.0.1");
        if (u.pathname !== "/") { s.statusCode = 404; s.end(); return; }
        var code = u.searchParams.get("code"), err = u.searchParams.get("error");
        s.setHeader("Content-Type", "text/html; charset=utf-8");
        s.end('<!doctype html><meta charset="utf-8"><body style="font:16px sans-serif;background:#232323;color:#ddd;padding:40px">' +
          (code ? "登入完成，可以回到 After Effects 了。" : "沒有登入（" + (err || "取消") + "）。") + "</body>");
        if (done) return;
        done = true; server.close();
        if (!code || u.searchParams.get("state") !== state) return no(new Error(err || "沒有登入"));
        request("POST", "https://oauth2.googleapis.com/token", { "Content-Type": "application/x-www-form-urlencoded" }, form({
          code: code, client_id: c.clientId, client_secret: c.clientSecret, code_verifier: verifier,
          redirect_uri: "http://127.0.0.1:" + port, grant_type: "authorization_code"
        })).then(function (r) {
          var t = JSON.parse(r.text);
          if (!t.refresh_token) return no(new Error("Google 沒有給長期登入（" + (t.error || r.status) + "）"));
          access = t.access_token; accessUntil = Date.now() + (t.expires_in - 120) * 1000;
          return api("GET", DRIVE + "/about?fields=user(emailAddress)").then(function (a) {
            auth = { refresh: t.refresh_token, email: a.user.emailAddress, scope: SCOPE };
            try { localStorage.setItem(AUTH_LS, JSON.stringify(auth)); } catch (e) {}
            ok(auth.email);
          });
        }).catch(no);
      });
      server.listen(0, "127.0.0.1", function () {
        port = server.address().port;
        CEP.openURL("https://accounts.google.com/o/oauth2/v2/auth?" + form({
          client_id: c.clientId, redirect_uri: "http://127.0.0.1:" + port, response_type: "code", scope: SCOPE,
          code_challenge: challenge, code_challenge_method: "S256", state: state, access_type: "offline", prompt: "consent"
        }));
      });
      setTimeout(function () { if (!done) { done = true; try { server.close(); } catch (e) {} no(new Error("等太久了，請再按一次")); } }, 5 * 60 * 1000);
    });
    var w = waiting;
    w.then(function () { waiting = null; }, function () { waiting = null; });
    return w;
  }
  /* Google's file picker, in the user's own browser: a page served here on
     127.0.0.1 shows only this sheet; picking it gives CENTO that one file. */
  function pickSheet(id) {
    return new Promise(async function (ok, no) {
      var http = node("http"), c = config();
      if (!c.apiKey || !c.appId) return no(new Error("cloud.local.json 少了 apiKey 或 appId"));
      var tk;
      try { tk = await token(); } catch (e) { return no(e); }
      var done = false;
      var page = '<!doctype html><meta charset="utf-8"><title>CENTO：選擇試算表</title>' +
        '<body style="font:16px sans-serif;background:#232323;color:#ddd;padding:40px"><p id="t">正在打開 Google 的檔案選擇視窗…</p>' +
        '<script src="https://apis.google.com/js/api.js"></' + 'script><script>' +
        'var say=function(x){document.getElementById("t").textContent=x};' +
        'gapi.load("picker",function(){' +
        'var v=new google.picker.DocsView(google.picker.ViewId.SPREADSHEETS).setFileIds(' + JSON.stringify(id) + ').setMode(google.picker.DocsViewMode.LIST);' +
        'new google.picker.PickerBuilder().addView(v).setOAuthToken(' + JSON.stringify(tk) + ').setDeveloperKey(' + JSON.stringify(c.apiKey) + ')' +
        '.setAppId(' + JSON.stringify(String(c.appId)) + ').setOrigin(location.origin).setTitle("點選這個看板的試算表，按「選取」")' +
        '.setCallback(function(d){if(d.action==="picked"){fetch("/picked?id="+encodeURIComponent(d.docs[0].id)).then(function(){say("完成，可以回到 After Effects 了。")})}' +
        'else if(d.action==="cancel"){fetch("/picked?id=").then(function(){say("已取消，可以回到 After Effects 了。")})}}).build().setVisible(true)});' +
        "</" + "script></body>";
      var server = http.createServer(function (q, s) {
        var u = new URL(q.url, "http://127.0.0.1");
        if (u.pathname === "/") { s.setHeader("Content-Type", "text/html; charset=utf-8"); s.end(page); return; }
        if (u.pathname === "/picked") {
          s.end("ok");
          if (done) return;
          done = true; setTimeout(function () { server.close(); }, 500);
          ok(u.searchParams.get("id") || null);
          return;
        }
        s.statusCode = 404; s.end();
      });
      server.listen(0, "127.0.0.1", function () { CEP.openURL("http://127.0.0.1:" + server.address().port + "/"); });
      setTimeout(function () { if (!done) { done = true; try { server.close(); } catch (e) {} ok(null); } }, 5 * 60 * 1000);
    });
  }
  function signedIn() { return !!(auth && (auth.refresh || (auth.browser && access && Date.now() < accessUntil))); }
  function signOut() { auth = null; access = null; try { localStorage.removeItem(AUTH_LS); localStorage.removeItem(TOKEN_LS); } catch (e) {} }
  async function token() {
    if (access && Date.now() < accessUntil) return access;
    if (CLOUDV) { var e0 = new Error("auth"); e0.auth = true; throw e0; }    // a new token needs a tap
    if (!signedIn()) { var e = new Error("auth"); e.auth = true; throw e; }
    var c = config();
    var r = await request("POST", "https://oauth2.googleapis.com/token", { "Content-Type": "application/x-www-form-urlencoded" },
      form({ client_id: c.clientId, client_secret: c.clientSecret, refresh_token: auth.refresh, grant_type: "refresh_token" }));
    var t = JSON.parse(r.text || "{}");
    if (!t.access_token) { signOut(); var e2 = new Error("auth"); e2.auth = true; throw e2; }
    access = t.access_token; accessUntil = Date.now() + (t.expires_in - 120) * 1000;
    return access;
  }
  async function api(method, url, body) {
    var tk = await token();
    var r = await request(method, url, { Authorization: "Bearer " + tk, "Content-Type": "application/json" },
      body ? JSON.stringify(body) : null);
    if (r.status === 401) { access = null; var e = new Error("auth"); e.auth = true; throw e; }
    if (r.status >= 300) { var e2 = new Error("Google " + r.status); e2.status = r.status; e2.text = r.text; throw e2; }
    return r.text ? JSON.parse(r.text) : {};
  }
  var R = function (sheet, a1) { return encodeURIComponent("'" + sheet + "'!" + a1); };

  // ---- one person's record is the replay of their rows -----------------------
  function blank(id, name) { return { id: id, name: name, notes: {}, marks: {}, status: {} }; }
  function apply(p, kind, cut, key, data, at) {
    if (kind === "note") { var l = (p.notes[cut] = (p.notes[cut] || []).filter(function (n) { return n.id !== data.id; })); l.push(data); }
    else if (kind === "notedel") { if (p.notes[cut]) p.notes[cut] = p.notes[cut].filter(function (n) { return n.id !== key; }); }
    else if (kind === "status") p.status[cut] = { s: data, at: at };
    else if (kind === "mark") (p.marks[cut] = p.marks[cut] || {})[key] = data;
    else if (kind === "markdel") { if (p.marks[cut]) delete p.marks[cut][key]; }
    else if (kind === "stroke" || kind === "markmeta") {
      var ms = p.marks[cut] = p.marks[cut] || {};
      var m = ms[key] = ms[key] || { strokes: [], styles: [] };
      if (kind === "stroke") { m.strokes = (m.strokes || []).concat(data.strokes); m.styles = (m.styles || []).concat(data.styles || []); }
      ["hold", "text", "who", "by", "at"].forEach(function (f) { if (data.meta && f in data.meta) { if (data.meta[f] == null) delete m[f]; else m[f] = data.meta[f]; } });
    }
  }
  // annotations: only what was added, and no row bigger than a cell
  function meta(m) { var o = {}; ["hold", "text", "who", "by", "at"].forEach(function (f) { o[f] = m[f] === undefined ? null : m[f]; }); return o; }
  function pieces(st) {
    var max = Math.floor(CELL / 9 / 2) * 2, out = [];
    if (st.length <= max) return [st];
    for (var k = 0; k < st.length - 2; k += max - 2) out.push(st.slice(k, k + max));
    return out;
  }
  function strokeRows(strokes, styles) {
    var rows = [], cur = { strokes: [], styles: [] }, size = 0;
    strokes.forEach(function (st, k) {
      pieces(st).forEach(function (pc) {
        var n = JSON.stringify(pc).length + 40;
        if (cur.strokes.length && size + n > CELL) { rows.push(cur); cur = { strokes: [], styles: [] }; size = 0; }
        cur.strokes.push(pc); cur.styles.push((styles || [])[k] || { c: "red", w: 1 }); size += n;
      });
    });
    if (cur.strokes.length) rows.push(cur);
    return rows;
  }
  function diff(was, now, cutNo) {
    var out = [], now0 = Date.now();
    var row = function (kind, label, cut, key, text, data, when) {
      var at = when || now0;
      out.push([new Date(at).toLocaleString(), now.name, label, cutNo[cut] || "", /^(mark|stroke)/.test(kind) ? Number(key) + 1 : "",
                text || "", now.id, cut, JSON.stringify({ k: kind, key: key, d: data, at: at })]);
    };
    var same = function (a, b) { return JSON.stringify(a) === JSON.stringify(b); };
    var cuts = {};
    [was, now].forEach(function (r) { ["notes", "marks", "status"].forEach(function (f) { Object.keys(r[f] || {}).forEach(function (c) { cuts[c] = 1; }); }); });
    Object.keys(cuts).forEach(function (c) {
      var a = {}, b = {};
      ((was.notes || {})[c] || []).forEach(function (n) { a[n.id] = n; });
      ((now.notes || {})[c] || []).forEach(function (n) { b[n.id] = n; });
      Object.keys(b).forEach(function (id) { if (!same(a[id], b[id])) row("note", "留言", c, id, b[id].text, b[id]); });
      Object.keys(a).forEach(function (id) { if (!b[id]) row("notedel", "刪除留言", c, id, a[id].text, null); });
      var ma = (was.marks || {})[c] || {}, mb = (now.marks || {})[c] || {};
      Object.keys(mb).forEach(function (k) {
        var w = ma[k], n = mb[k];
        if (same(w, n)) return;
        var ws = (w && w.strokes) || [], ns = n.strokes || [];
        var grows = w && ws.length <= ns.length && ws.every(function (st, j) { return same(st, ns[j]) && same((w.styles || [])[j], (n.styles || [])[j]); });
        if (grows) {
          var add = strokeRows(ns.slice(ws.length), (n.styles || []).slice(ws.length));
          add.forEach(function (d, j) { d.meta = meta(n); row("stroke", "批註", c, k, j ? "" : n.text, d); });
          if (!add.length) row("markmeta", "批註", c, k, n.text, { meta: meta(n) });
          return;
        }
        var all = strokeRows(ns, n.styles), first = all.shift() || { strokes: [], styles: [] };
        var full = JSON.parse(JSON.stringify(n)); full.strokes = first.strokes; full.styles = first.styles;
        row("mark", "批註", c, k, n.text, full);
        all.forEach(function (d) { d.meta = meta(n); row("stroke", "批註（續）", c, k, "", d); });
      });
      Object.keys(ma).forEach(function (k) { if (!mb[k]) row("markdel", "清除批註", c, k, "", null); });
      var sa = (was.status || {})[c], sb = (now.status || {})[c];
      if (sb && (!sa || sa.s !== sb.s)) row("status", "審片結果", c, "", { ok: "通過", fix: "重修", talk: "保留", "": "未審" }[sb.s], sb.s, sb.at);
    });
    return out;
  }

  var sheets = {};           // id -> { rows read, people: {id: record}, published: my record as last written }
  async function readNew(id) {
    var st = sheets[id];
    var r = await api("GET", SHEETS + "/" + id + "/values/" + R(LOG, "A" + (st.rows + 2) + ":I"));
    (r.values || []).forEach(function (v) {
      st.rows++;
      var pid = v[6], cut = v[7], j = {};
      try { j = JSON.parse(v[8] || "{}"); } catch (e) {}
      if (!pid || !j.k) return;
      var p = st.people[pid] = st.people[pid] || blank(pid, v[1]);
      p.name = v[1] || p.name;
      apply(p, j.k, cut, j.key, j.d, j.at || 0);
    });
  }
  var G = {
    create: async function (title, cuts) {
      var s = await api("POST", SHEETS, { properties: { title: "CENTO · " + title },
        sheets: [{ properties: { title: LOG } }, { properties: { title: CUTS } }] });
      await api("PUT", SHEETS + "/" + s.spreadsheetId + "/values/" + R(LOG, "A1:I1") + "?valueInputOption=RAW",
        { values: [["時間", "名字", "動作", "卡號", "格", "內容", "人", "卡", "資料"]] });
      await api("PUT", SHEETS + "/" + s.spreadsheetId + "/values/" + R(CUTS, "A1:C" + (cuts.length + 1)) + "?valueInputOption=RAW",
        { values: [["卡號", "id", "建立者"]].concat(cuts.map(function (c, k) { return [c.no, c.id, k ? "" : auth.email]; })) });
      return s.spreadsheetId;
    },
    cuts: async function (id) {
      var r = await api("GET", SHEETS + "/" + id + "/values/" + R(CUTS, "A2:C"));
      var rows = r.values || [];
      return rows.length ? { cuts: rows.map(function (v) { return { no: v[0], id: v[1] }; }), owner: rows[0][2] || "" } : null;
    },
    sync: async function (id, me, peek) {
      var st = sheets[id] = sheets[id] || { rows: 0, people: {}, published: null };
      await readNew(id);
      if (me.id && !st.published) st.published = JSON.parse(JSON.stringify(st.people[me.id] || blank(me.id, me.name)));
      if (!peek && me.id) {
        var cutNo = {};
        P.cuts.forEach(function (c) { cutNo[c.id] = c.no; });
        var rows = diff(st.published, me, cutNo);
        if (rows.length) {
          await api("POST", SHEETS + "/" + id + "/values/" + R(LOG, "A:I") + ":append?valueInputOption=RAW&insertDataOption=INSERT_ROWS", { values: rows });
          await readNew(id);
          st.published = JSON.parse(JSON.stringify(me));
        }
      }
      return Object.keys(st.people).map(function (k) { return st.people[k]; });
    },
    // 雲端看片's board, stills and film; light: only the film's row (is there a new one?)
    film: async function (id, light) {
      var r = await api("GET", SHEETS + "/" + id + "/values/" + R(FILM, light ? "A1:D1" : "A1:ZZ"));
      var out = { board: "", thumbs: {}, video: null };
      (r.values || []).forEach(function (v) {
        if (v[0] === "video") out.video = { id: v[1], ver: v[2], fps: Number(v[3]) || 0 };
        else if (v[0] === "board") out.board += v.slice(1).join("");
        else if (v[0] === "thumb") out.thumbs[v[1]] = v[2];
      });
      if (light) return out;
      if (!out.board) return null;
      out.board = JSON.parse(out.board);
      return out;
    },
    // a video into Drive in one piece (Google's resumable upload); id: replace that file's content
    upload: async function (id, data, name) {
      var tk = await token();
      var url = "https://www.googleapis.com/upload/drive/v3/files" + (id ? "/" + id : "") + "?uploadType=resumable&fields=id";
      var r = await request(id ? "PATCH" : "POST", url, { Authorization: "Bearer " + tk, "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": "video/mp4", "X-Upload-Content-Length": String(data.length) }, JSON.stringify(id ? {} : { name: name, mimeType: "video/mp4" }));
      if (r.status >= 300 || !r.headers || !r.headers.location) { var e = new Error("Google " + r.status); e.status = r.status; throw e; }
      var r2 = await request("PUT", r.headers.location, { "Content-Type": "video/mp4", "Content-Length": String(data.length) }, data);
      if (r2.status >= 300) { var e2 = new Error("上傳失敗（Google " + r2.status + "）"); e2.status = r2.status; throw e2; }
      return JSON.parse(r2.text).id;
    },
    // the 「片」 tab, written over: the film's row, the board, the stills
    publish: async function (id, video, board, thumbs) {
      var s = await api("GET", SHEETS + "/" + id + "?fields=sheets.properties.title");
      if (!(s.sheets || []).some(function (x) { return x.properties.title === FILM; }))
        await api("POST", SHEETS + "/" + id + ":batchUpdate", { requests: [{ addSheet: { properties: { title: FILM } } }] });
      var json = JSON.stringify(board), row = ["board"];
      for (var k = 0; k < json.length; k += CELL) row.push(json.slice(k, k + CELL));
      var rows = [["video", video.id, video.ver, String(video.fps)], row];
      Object.keys(thumbs).forEach(function (cid) { rows.push(["thumb", cid, thumbs[cid]]); });
      await api("POST", SHEETS + "/" + id + "/values/" + R(FILM, "A1:ZZ") + ":clear", {});
      await api("PUT", SHEETS + "/" + id + "/values/" + R(FILM, "A1") + "?valueInputOption=RAW", { values: rows });
    },
    // the sheet to write notes in, the film to watch; Google's mail carries the link
    invite: async function (sheet, video, to, url) {
      await api("POST", DRIVE + "/files/" + video + "/permissions?sendNotificationEmail=false", { type: "user", role: "reader", emailAddress: to });
      await api("POST", DRIVE + "/files/" + sheet + "/permissions?sendNotificationEmail=true&emailMessage=" +
        encodeURIComponent("用這個連結看片、寫意見（不用裝任何東西）：\n" + url), { type: "user", role: "writer", emailAddress: to });
    },
    share: function (id, to) {
      return api("POST", DRIVE + "/files/" + id + "/permissions?sendNotificationEmail=true", { type: "user", role: "writer", emailAddress: to });
    }
  };
  var link = function (id) { return "https://docs.google.com/spreadsheets/d/" + id + "/edit"; };
  var parse = function (s) { return (/spreadsheets\/d\/([\w-]+)/.exec(s) || [])[1]; };

  // ---- the panel side --------------------------------------------------------
  var busy = false, pushT = 0, lastSync = 0, lastErr = "", people0 = [], myStatus = {}, statusOf = "";
  var sheetId = function () { return P && P.cloud && P.cloud.sheet; };

  function css() {
    var s = document.createElement("style");
    s.textContent =
      ".cl{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--ink2);margin-right:4px;white-space:nowrap}" +
      ".cl .ico{font-size:13px;color:var(--ok2)} .cl .ico.off{color:var(--fix)} .cl .ico.no{color:var(--mute)}" +
      ".clvotes{font-size:11.5px;color:var(--ink2);padding:6px 2px 0;line-height:1.6}" +
      ".clvotes b{font-weight:600;color:var(--ink)} .clvotes .x{color:var(--fix)}" +
      ".clm .opt{display:block;width:100%;text-align:left;border:1px solid var(--edge2);padding:10px 12px;margin:6px 0;color:var(--ink)}" +
      ".clm .opt:hover{border-color:var(--accent-dim);background:var(--accent-ghost)} .clm .opt small{display:block;color:var(--mute)}" +
      ".clm .row{display:flex;gap:6px;margin:8px 0} .clm .row input{flex:1;background:var(--panel);border:1px solid var(--edge);color:var(--ink);padding:6px 9px;font-size:12.5px}" +
      ".clm .row button{padding:5px 12px;border:1px solid var(--edge2);color:var(--ink);white-space:nowrap}" +
      ".clm .row button.pri{background:var(--accent);border-color:var(--accent);color:#fff}" +
      ".clm .err{color:var(--fix);font-size:12px;min-height:18px} .clm p{color:var(--ink2);margin:4px 0 10px;line-height:1.7}";
    document.head.appendChild(s);
  }
  function modal(title, html) {
    openModal(title, '<div class="clm">' + html + "</div>", "", null);
    return document.querySelector("#modalBody .clm");
  }
  function closeModalNow() { closeModal(); }

  function bar() {
    var box = document.getElementById("cloudBox");
    if (!box) return;
    if (!sheetId()) {
      box.innerHTML = ""; statusOf = "";       // a board starts going to the cloud from 分享 ▾ → 邀請別人來看
      return;
    }
    if (!signedIn()) {
      box.innerHTML = '<span class="ico no">☁</span><span>需要登入 Google</span><button class="btn" id="clRe">登入</button>';
      document.getElementById("clRe").onclick = function () { login().then(function () { sync(true); }, function (e) { toast("沒有登入：" + e.message, true); }); };
      return;
    }
    if (publishing) {
      var p0 = '<span class="ico">☁</span><span>' + esc(publishNote || "更新片子…") + "</span>";
      if (p0 !== statusOf) { statusOf = p0; box.innerHTML = p0; }
      return;
    }
    var ago = lastSync ? Math.round((Date.now() - lastSync) / 1000) : null;
    var others = people0.filter(function (p) { return p.id !== myId(); }).map(function (p) { return p.name; });
    var txt = lastErr ? "同步失敗：" + lastErr
      : (ago === null ? "同步中…" : ago < 3 ? "已同步" : ago < 60 ? ago + " 秒前同步" : Math.round(ago / 60) + " 分鐘前同步") +
        (others.length ? " · 和 " + others.join("、") : " · 還沒有同事加入");
    var s = '<span class="ico ' + (lastErr ? "off" : "") + '">☁</span><span title="' + esc(auth.email) + '">' + esc(txt) + "</span>" +
      (lastErr ? '<button class="btn" id="clNow">重試</button>' : "");    // it syncs by itself every few seconds
    if (s === statusOf) return;
    statusOf = s; box.innerHTML = s;
    if (lastErr) document.getElementById("clNow").onclick = function () { sync(true); };
  }

  async function start() {
    if (!inAE) { toast("雲端同步要在 After Effects 裡使用", true); return; }
    if (!myId()) { toast("先在下方選一個署名", true); openWhoPop(false); return; }
    if (!signedIn()) {
      var m = modal("雲端同步（測試版）", "<p>意見、審片結果和批註會存在你的 Google 雲端硬碟裡的一份試算表，同事登入後就能一起看。</p>" +
        "<p>按下面的按鈕會打開瀏覽器，登入後回到這裡。</p><div class=\"err\" id=\"clErr\"></div>" +
        '<div class="row" style="justify-content:flex-end"><button id="clIn">用 Google 登入</button></div>');
      m.querySelector("#clIn").onclick = async function () {
        m.querySelector("#clErr").textContent = "請在瀏覽器裡登入…";
        try { await login(); closeModalNow(); choose(); }
        catch (e) { m.querySelector("#clErr").textContent = "沒有登入成功（" + e.message + "）"; }
      };
      return;
    }
    choose();
  }
  function choose() {
    var m = modal("這個看板要和誰一起看？", "<p>已登入 " + esc(auth.email) + "</p>" +
      '<button class="opt" id="clNew">我先開始<small>在雲端硬碟建立這個看板的共用試算表，再分享給同事</small></button>' +
      '<button class="opt" id="clJoin">同事分享給我了<small>貼上同事傳來的連結</small></button><div class="err" id="clErr"></div>');
    m.querySelector("#clNew").onclick = async function () {
      if (!P.cuts.length) { m.querySelector("#clErr").textContent = "看板是空的，先讀入合成"; return; }
      m.querySelector("#clErr").textContent = "建立中…";
      try {
        var id = await G.create(P.title || "看板", P.cuts.map(function (c) { return { id: c.id, no: c.no }; }));
        P.cloud = { sheet: id }; markDirty();
        closeModalNow(); share(true); sync();
      } catch (e) { m.querySelector("#clErr").textContent = "建立失敗：" + e.message; }
    };
    m.querySelector("#clJoin").onclick = function () {
      var m2 = modal("貼上分享連結", '<p>同事按「分享」後傳給你的連結</p><div class="row"><input id="clLink" placeholder="https://docs.google.com/spreadsheets/…"></div>' +
        '<div class="err" id="clErr"></div><div class="row" style="justify-content:flex-end"><button id="clGo">加入</button></div>');
      var go = async function () {
        var id = parse(m2.querySelector("#clLink").value);
        if (!id) { m2.querySelector("#clErr").textContent = "看起來不是 CENTO 試算表的連結"; return; }
        m2.querySelector("#clErr").textContent = "連線中…";
        try {
          var b;
          try { b = await G.cuts(id); }
          catch (e) {
            if (e.status !== 403 && e.status !== 404) throw e;
            // not handed to CENTO yet: the user picks it once in the browser
            m2.querySelector("#clErr").textContent = "瀏覽器裡會出現 Google 的選擇視窗：點選這份試算表，按「選取」…";
            var got = await pickSheet(id);
            if (!got) { m2.querySelector("#clErr").textContent = "沒有選試算表"; return; }
            id = got;
            b = await G.cuts(id);
          }
          if (!b) { m2.querySelector("#clErr").textContent = "這份試算表不是 CENTO 看板"; return; }
          if (b.cuts.length !== P.cuts.length) { m2.querySelector("#clErr").textContent = "卡數不同（試算表 " + b.cuts.length + "、這裡 " + P.cuts.length + "），請先讀入同一個合成"; return; }
          b.cuts.forEach(function (c, k) { P.cuts[k].id = c.id; });          // the same cuts on every computer
          P.cloud = { sheet: id }; markDirty();
          closeModalNow(); toast("已加入 " + (b.owner || "同事") + " 的看板"); sync(true);
        } catch (e) {
          m2.querySelector("#clErr").textContent = e.status === 403 || e.status === 404 ? "還是打不開：請確認同事已經分享給你的 Google 帳號（" + auth.email + "）" : "打不開（" + e.message + "）";
        }
      };
      m2.querySelector("#clGo").onclick = go;
      m2.querySelector("#clLink").onkeydown = function (e) { if (e.key === "Enter") go(); };
      m2.querySelector("#clLink").focus();
    };
  }
  function share(first) {
    var url = link(sheetId());
    var m = modal(first ? "共用試算表建好了" : "分享這個看板",
      "<p>① 輸入同事的 Google email 邀請他（沒邀請的人打不開）<br>② 再把連結傳給他，對方按「☁ 雲端同步 → 同事分享給我了」貼上。</p>" +
      '<div class="row"><input id="clMail" placeholder="同事的 Google email"><button id="clInvite">① 邀請</button></div>' +
      '<div class="row"><input id="clUrl" readonly value="' + esc(url) + '"><button id="clCopy">② 複製連結</button></div>' +
      '<p style="margin-top:16px">不想再同步這個看板：<button id="clLeave" style="color:var(--fix);border:1px solid var(--edge2);padding:3px 10px">停止同步</button>（試算表和這裡的資料都會留著）</p>');
    m.querySelector("#clLeave").onclick = function () {
      delete P.cloud; markDirty(); people0 = []; statusOf = ""; closeModalNow(); bar(); votes();
      toast("這個看板不再同步");
    };
    m.querySelector("#clCopy").onclick = function () { copyText(url).then(function () { toast("連結已複製"); }); };
    m.querySelector("#clInvite").onclick = function () {
      var v = m.querySelector("#clMail").value.trim(); if (!v) return;
      G.share(sheetId(), v).then(function () { toast("已分享給 " + v); m.querySelector("#clMail").value = ""; },
        function (e) { toast("分享失敗：" + e.message, true); });
    };
  }

  // ---- 邀請別人來看: the film and the link (雲端看片) ------------------------------
  var REVIEW = "https://hsuhaocheng.github.io/cento/review/";
  var publishing = null, publishNote = "", publishAgain = false;
  function reviewUrl() {
    var c = {};
    try { c = config(); } catch (e) {}
    return (c.reviewUrl || REVIEW) + "#s=" + sheetId() + "&v=" + ((P.cloud.film && P.cloud.film.id) || "");
  }
  // what the film is made of: when none of it changed, 讀入 does not make a new one
  function filmSig() {
    return JSON.stringify([P.fps, P.cuts.map(function (c) {
      return [c.id, c.no, c.frames, c.media && c.media.t, (c.seqHave || []).length, c.aeInF];
    })]);
  }
  function publish(onNote) {
    if (publishing) { publishAgain = true; return publishing; }
    var say = function (t) { publishNote = t; if (onNote) onNote(t); bar(); };
    publishing = (async function () {
      var sheet = sheetId(), f = await makeFilm(say);
      if (sheetId() !== sheet) throw new Error("看板換了");
      say("上傳片子…");
      var data = node("fs").readFileSync(f.path), film = P.cloud.film || {}, vid;
      try { vid = await G.upload(film.id || null, data, "CENTO · " + (P.title || "看板") + " · 片.mp4"); }
      catch (e) {
        if (!film.id || e.status !== 404) throw e;
        vid = await G.upload(null, data, "CENTO · " + (P.title || "看板") + " · 片.mp4");    // the old one was deleted
      }
      say("更新看板…");
      var ver = String(Date.now());
      await G.publish(sheet, { id: vid, ver: ver, fps: fps() }, filmBoard(f.vStart), await filmThumbs());
      P.cloud.film = { id: vid, ver: ver, sig: filmSig(), invited: film.invited || [] };
      markDirty();
    })();
    var p = publishing;
    p.then(done, done);
    function done(e) {
      publishing = null; publishNote = "";
      if (e instanceof Error) { lastErr = "片子沒有更新（" + e.message + "）"; toast(lastErr, true); }
      bar();
      if (publishAgain) { publishAgain = false; publishSoon(); }
    }
    return p;
  }
  var publishT = 0;
  function publishSoon() {
    clearTimeout(publishT);
    publishT = setTimeout(function () {
      if (sheetId() && P.cloud.film && signedIn() && filmSig() !== P.cloud.film.sig) publish().catch(function () {});
    }, 1500);
  }
  async function invite() {
    if (!inAE) { toast("邀請要在 After Effects 裡用", true); return; }
    if (!P.cuts.length) { toast("看板是空的，先讀入合成", true); return; }
    if (!myId()) { toast("先選一個署名", true); openWhoPop(false); return; }
    if (!signedIn()) {
      var m0 = modal("邀請別人來看", "<p>片子和意見會放在你自己的 Google 雲端硬碟，只有你邀請的人看得到。</p>" +
        "<p>按下面的按鈕會打開瀏覽器，登入後回到這裡。</p><div class=\"err\" id=\"clErr\"></div>" +
        '<div class="row" style="justify-content:flex-end"><button id="clIn">用 Google 登入</button></div>');
      m0.querySelector("#clIn").onclick = async function () {
        m0.querySelector("#clErr").textContent = "請在瀏覽器裡登入…";
        try { await login(); invite(); }
        catch (e) { m0.querySelector("#clErr").textContent = "沒有登入成功（" + e.message + "）"; }
      };
      return;
    }
    if (!sheetId() || !P.cloud.film) {
      var m1 = modal("邀請別人來看", '<p>第一次要把片子放上你的雲端硬碟（之後每次讀入會自動更新）。</p><p id="clStep">準備中…</p><div class="err" id="clErr"></div>');
      try {
        if (!sheetId()) {
          var id = await G.create(P.title || "看板", P.cuts.map(function (c) { return { id: c.id, no: c.no }; }));
          P.cloud = { sheet: id }; markDirty(); sync();
        }
        await publish(function (t) { var x = m1.querySelector("#clStep"); if (x) x.textContent = t; });
      } catch (e) { var x = m1.querySelector("#clErr"); if (x) x.textContent = "沒有完成：" + e.message; return; }
    }
    inviteForm();
  }
  function inviteForm() {
    var url = reviewUrl(), who = P.cloud.film.invited || [];
    var m = modal("邀請別人來看",
      "<p>輸入對方的 Gmail。Google 會寄信給他，信裡有看片的連結；他用瀏覽器就能看片、寫意見。</p>" +
      '<div class="row"><input id="clMail" placeholder="對方的 Gmail"><button id="clInvite" class="pri">送出邀請</button></div><div class="err" id="clErr"></div>' +
      (who.length ? '<p style="margin-top:10px">已邀請：' + who.map(esc).join("、") + "</p>" : "") +
      '<div class="row" style="margin-top:14px"><input id="clUrl" readonly value="' + esc(url) + '"><button id="clCopy">複製連結</button></div>' +
      '<p style="font-size:11.5px;color:var(--mute)">連結只有被邀請的帳號打得開。改了分鏡後按「讀入」，片子會自動更新。</p>' +
      '<p style="margin-top:12px"><button id="clLeave" style="color:var(--fix);border:1px solid var(--edge2);padding:3px 10px">停止分享這個看板</button></p>');
    m.querySelector("#clCopy").onclick = function () { copyText(url).then(function () { toast("連結已複製"); }); };
    var go = async function () {
      var v = m.querySelector("#clMail").value.trim();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) { m.querySelector("#clErr").textContent = "看起來不是 email"; return; }
      m.querySelector("#clErr").textContent = "送出中…";
      try {
        await G.invite(sheetId(), P.cloud.film.id, v, url);
        if (who.indexOf(v) < 0) who.push(v);
        P.cloud.film.invited = who; markDirty();
        toast("已邀請 " + v); inviteForm();
      } catch (e) { m.querySelector("#clErr").textContent = "沒有送出：" + e.message; }
    };
    m.querySelector("#clInvite").onclick = go;
    m.querySelector("#clMail").onkeydown = function (e) { if (e.key === "Enter") go(); };
    m.querySelector("#clLeave").onclick = function () {
      delete P.cloud; markDirty(); people0 = []; statusOf = ""; closeModalNow(); bar(); votes();
      toast("這個看板不再分享。雲端硬碟上的檔案還在，要刪請到雲端硬碟。");
    };
    m.querySelector("#clMail").focus();
  }

  function mine() {
    var me = myId(), rec = { id: me, name: myName(), notes: {}, marks: {}, status: myStatus };
    P.cuts.forEach(function (c) {
      var n = (c.notes || []).filter(function (x) { return x.by === me; });
      if (n.length) rec.notes[c.id] = n;
      Object.keys(c.marks || {}).forEach(function (k) {
        var m = c.marks[k];
        if (m && m.by === me) (rec.marks[c.id] = rec.marks[c.id] || {})[k] = m;
      });
    });
    return rec;
  }
  // everyone's records into the board; my own only where the board has lost it
  function merge(people) {
    var me = myId(), byId = {};
    P.cuts.forEach(function (c) { byId[c.id] = c; });
    people.forEach(function (p) {
      if (p.id === me) return;
      P.cuts.forEach(function (c) { if (c.notes) c.notes = c.notes.filter(function (x) { return x.by !== p.id; }); });
      Object.keys(p.notes || {}).forEach(function (cid) {
        var c = byId[cid]; if (!c) return;
        var have = {};
        (c.notes || []).forEach(function (n) { have[n.id] = 1; });
        c.notes = (c.notes || []).concat(p.notes[cid].filter(function (n) { return !have[n.id]; }));
      });
      Object.keys(p.marks || {}).forEach(function (cid) {
        var c = byId[cid]; if (!c) return;
        c.marks = c.marks || {};
        Object.keys(p.marks[cid]).forEach(function (k) {
          var have = c.marks[k], got = p.marks[cid][k];
          if (!have || have.by === p.id || (got.at || 0) > (have.at || 0)) c.marks[k] = got;
        });
        Object.keys(c.marks).forEach(function (k) { if (c.marks[k].by === p.id && !p.marks[cid][k]) delete c.marks[k]; });
      });
    });
    P.cuts.forEach(function (c) { if (c.notes) c.notes.sort(function (a, b) { return (a.at || 0) - (b.at || 0); }); });
    P.cuts.forEach(function (c) {
      var best = null;
      people.forEach(function (p) {
        var v = (p.id === me ? myStatus : p.status || {})[c.id];
        if (v && (!best || v.at > best.at)) best = v;
      });
      if (best) c.status = best.s;
    });
  }
  function votes() {
    var box = document.getElementById("clVotes"), c = P && P.cuts[i];
    if (!box) return;
    if (!c || !sheetId()) { box.textContent = ""; return; }
    var NAMES = { ok: "通過", fix: "重修", talk: "保留", "": "未審" }, list = [];
    people0.concat([{ id: myId(), name: myName() }]).forEach(function (p) {
      var v = (p.id === myId() ? myStatus : p.status || {})[c.id];
      if (v && !list.some(function (x) { return x.id === p.id; })) list.push({ id: p.id, who: p.id === myId() ? myName() + "（我）" : p.name, s: v.s });
    });
    if (list.length < 2) { box.textContent = ""; return; }
    var differ = list.some(function (v) { return v.s !== list[0].s; });
    box.innerHTML = (differ ? '<span class="x">意見不同：</span>' : "") + list.map(function (v) { return esc(v.who) + "：<b>" + NAMES[v.s] + "</b>"; }).join("　｜　");
  }

  var restored = {};
  async function sync(force) {
    var id = sheetId();
    if (!id || !myId() || busy) return;
    if (!signedIn()) { bar(); return; }
    busy = true;
    try {
      if (!restored[id]) {                    // first time on this sheet: take back what I wrote here before
        var pre = await G.sync(id, { id: myId(), name: myName() }, true);
        var me0 = pre.filter(function (p) { return p.id === myId(); })[0];
        if (me0) {
          myStatus = me0.status || {};
          merge([Object.assign({}, me0, { id: "__me" })]);
        }
        restored[id] = true;
      }
      people0 = await G.sync(id, mine());
      var before = JSON.stringify(P.cuts.map(function (c) { return [c.status, c.notes, c.marks]; }));
      merge(people0);
      var after = JSON.stringify(P.cuts.map(function (c) { return [c.status, c.notes, c.marks]; }));
      if (before !== after) {
        var cur = P.cuts[i], typing = document.activeElement && /TEXTAREA|INPUT/.test(document.activeElement.tagName);
        renderList(); renderStrip(); renderHead();
        if (cur) { renderNotes(cur); if (!typing) renderInspector(); }
        try { drawMarks(); renderFrameBar(); } catch (e) {}
        dirtyQuiet();
        if (force) toast("已同步，有新的內容");
      } else if (force) toast("已同步");
      lastSync = Date.now(); lastErr = "";
    } catch (e) {
      lastErr = e.auth ? "" : e.message;
      if (e.auth) toast("Google 登入過期了，請重新登入", true);
    }
    busy = false;
    bar(); votes();
  }
  // what came from the sheet is saved to the board file like anything else
  function dirtyQuiet() { if (typeof save === "function") { dirty = true; clearTimeout(saveTimer); saveTimer = setTimeout(save, 1200); } }
  function soon() { if (!sheetId()) return; clearTimeout(pushT); pushT = setTimeout(sync, 1500); }

  function hook() {
    var set = window.setStatus;
    window.setStatus = function (s) {
      var c = P.cuts[i];
      set(s);
      if (c && myId()) { myStatus[c.id] = { s: c.status || "", at: Date.now() }; soon(); votes(); }
    };
    var dirt = window.markDirty;
    window.markDirty = function () { dirt.apply(this, arguments); soon(); };
    var sel = window.select;
    window.select = function () { var r = sel.apply(this, arguments); votes(); return r; };
    if (!CLOUDV && window.aeScan) {
      var scan = window.aeScan;
      window.aeScan = function () {
        var r = scan.apply(this, arguments);
        Promise.resolve(r).then(publishSoon, function () {});
        return r;
      };
    }
  }
  function ui() {
    css();
    var box = document.createElement("div");
    box.className = "cl"; box.id = "cloudBox";
    var at = document.getElementById("shareBtn");
    document.querySelector("header.bar").insertBefore(box, at ? at.parentNode : null);
    var v = document.createElement("div");
    v.className = "clvotes"; v.id = "clVotes";
    var sb = document.querySelector(".statbar");
    sb.parentNode.insertBefore(v, sb.nextSibling);
    bar();
  }
  if (!CLOUDV) window.CentoInvite = invite;
  window.CentoCloud = {
    login: login, token: token, signedIn: signedIn, G: G, media: media,
    pick: function (ids) { return pickBrowser(ids); },
    known: function () { return !!(auth && auth.email); },
    email: function () { return auth ? auth.email : ""; }
  };
  (function wait() {
    if (typeof P === "undefined" || !P || !document.getElementById("shareBtn")) return setTimeout(wait, 200);
    hook(); ui();
    var lastBoard = null;
    setInterval(function () {
      if (P !== lastBoard) { lastBoard = P; myStatus = {}; people0 = []; statusOf = ""; restored = {}; bar(); }   // another board
      if (sheetId() && signedIn()) sync();
      else bar();
    }, EVERY);
    setInterval(bar, 1000);
    if (sheetId()) sync();
  })();
})();

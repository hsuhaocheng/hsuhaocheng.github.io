/* 網頁看片, the browser side: the panel opened from the computer running AE.
 *
 * The host's board comes in (lib/web-cep.js fetched it before boot); after
 * that this keeps asking for the next change and sends, after each change
 * made here, one record of what this viewer wrote (lib/web-core.js). Nothing
 * is saved in the browser except who you are.
 */
(function () {
  if (!WEB) return;
  var me0 = function () { return { "X-Cento-Viewer": myId() || "anon", "X-Cento-Name": encodeURIComponent(myName() || "") }; };
  var st0 = window.CENTO_WEB.state || {};        // 雲端看片: not in yet
  var v = st0.v || 0, votes = st0.votes || {};
  var myStatus = {}, pushT = 0, sending = false, again = false, stash = null, lost = false;

  // ---- what this viewer has said before (after a reload) -----------------
  function restoreStatus() {
    myStatus = {};
    Object.keys(votes).forEach(function (cid) {
      (votes[cid] || []).forEach(function (x) { if (x.id === myId()) myStatus[cid] = { s: x.s, at: x.at }; });
    });
  }

  // ---- send what I wrote ---------------------------------------------------
  async function push() {
    pushT = 0;
    if (!myId()) return;
    if (sending) { again = true; return; }
    sending = true;
    try {
      var r = await fetch("/api/sync", { method: "POST", headers: Object.assign({ "Content-Type": "application/json" }, me0()),
        body: JSON.stringify({ me: CentoWeb.record(P, myId(), myName(), myStatus) }) });
      if (!r.ok) throw new Error(String(r.status));
      saveState("已同步");
    } catch (e) {
      saveState("沒有送出");
      toast("沒有送到開著 AE 的電腦，連上後會再送一次", true);
      again = true;
    }
    sending = false;
    if (again) { again = false; clearTimeout(pushT); pushT = setTimeout(push, lost ? 3000 : 300); }
  }
  function soon() { saveState("同步中…"); clearTimeout(pushT); pushT = setTimeout(push, 300); }

  // ---- take the host's board, keeping where I am and what I have not sent yet
  function take(st) {
    if (writing()) { stash = st; return; }          // not while writing a reply or a mark's text
    stash = null;
    var keepId = P.cuts[i] && P.cuts[i].id, keepF = curFrame;
    var b = st.board;
    if (sending || pushT) CentoWeb.fold(b, CentoWeb.record(P, myId(), myName(), myStatus));   // still on its way
    P = b; normalizeBoard(P); votes = st.votes || {};
    var k = P.cuts.findIndex(function (c) { return c.id === keepId; });
    i = k >= 0 ? k : Math.min(i, P.cuts.length - 1);
    renderAll();
    if (P.cuts[i]) showFrame(Math.min(keepF, cutFrames(P.cuts[i]) - 1));
    showVotes();
  }
  var writing = function () { var a = document.activeElement; return !!(a && a.closest && a.closest("#noteList") && /INPUT|TEXTAREA/.test(a.tagName)); };
  document.addEventListener("focusout", function () { setTimeout(function () { if (stash && !writing()) take(stash); }, 0); });

  async function loop() {
    for (;;) {
      try {
        // after losing the host, ask without waiting, so being back shows at once
        var r = await fetch("/api/state?" + (lost ? "" : "wait=1&") + "v=" + v, { headers: me0() });
        if (!r.ok) throw new Error(String(r.status));
        var st = await r.json();
        if (lost) { lost = false; clearBanner(); toast("和開著 AE 的電腦接上了"); }
        if (st.v !== v) { v = st.v; take(st); }
      } catch (e) {
        if (!lost) { lost = true; banner("和開著 AE 的電腦斷線了，正在重新連線…（AE 那邊可能關掉了網頁看片）"); }
        await new Promise(function (r) { setTimeout(r, 3000); });
      }
    }
  }
  function clearBanner() { $("banner").hidden = true; }

  // ---- 意見不同：… under the status buttons --------------------------------
  function showVotes() {
    var box = $("webVotes"), c = P.cuts[i];
    if (!box) return;
    var t = c && CentoWeb.votesText(votes[c.id], myId());
    box.innerHTML = !t ? "" : (t.differ ? '<span class="x">意見不同：</span>' : "") +
      t.parts.map(function (x) { return esc(x.who) + "：<b>" + esc(x.s) + "</b>"; }).join("　｜　");
  }

  // ---- a phone: the picture, then the 卡／意見 tabs (index.html) ---------------
  function phone() {
    var css = document.createElement("style");
    css.textContent =
      ".webvotes{font-size:11.5px;color:var(--ink2);padding:6px 2px 0;line-height:1.6}.webvotes b{color:var(--ink);font-weight:600}.webvotes .x{color:var(--fix)}" +
      "#capBtn{display:none;width:100%;text-align:left;padding:8px 16px;color:var(--ink2);font-size:13px;border-top:1px solid var(--edge)}" +
      ".webname{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0}.webname button{border:1px solid var(--edge2);padding:6px 12px;border-radius:4px}" +
      ".webname input{flex:1 1 100%;background:var(--panel);border:1px solid var(--edge);color:var(--ink);padding:9px;font-size:16px;margin-top:6px}" +
      "@media (max-width:700px){" +
      " body.web .brand{font-size:13px} body.web .build{display:none}" +
      // the filter row and the cut's text fold away
      " body.web .insp{overflow:visible}" +
      " body.web .insp .filt{display:none} body.web .insp-body{overflow:visible}" +
      " body.web .cap{display:none} body.web.capopen .cap{display:grid} #capBtn{display:block}" +
      " body.web .transport .tbtn.ico{min-width:44px;height:40px} body.web .transport .tbtn.ico svg{width:16px;height:16px}" +
      " body.web .statbar button{padding:12px 0;font-size:15px}" +
      " body.web .noteadd{position:sticky;bottom:0;background:var(--panel);z-index:5} body.web #noteText{font-size:16px}" +
      " body.web #drawCv{touch-action:none}" +
      "}";
    document.head.appendChild(css);
    var cb = document.createElement("button");
    cb.id = "capBtn"; cb.textContent = "▸ 畫面／內容／對白";
    var cap = document.querySelector(".cap");
    cap.parentNode.insertBefore(cb, cap);
    cb.addEventListener("click", function () {
      var on = document.body.classList.toggle("capopen");
      cb.textContent = (on ? "▾" : "▸") + " 畫面／內容／對白";
    });
  }

  // ---- who you are: asked once, in the middle of the screen --------------------
  function askName() {
    var names = boardNames().slice(0, 6);
    openModal("你的名字", '<div class="row2">會顯示在你的意見旁邊，大家才知道是誰說的。</div><div class="webname">' +
      names.map(function (n) { return '<button data-n="' + esc(n) + '">' + esc(n) + "</button>"; }).join("") +
      '<input id="webName" placeholder="輸入名字，例如：導演"></div>', "開始看片", function () {
        var v = $("webName").value.trim();
        if (!v) { $("webName").focus(); return; }
        pickName(v); closeModal();
      });
    document.querySelectorAll(".webname button").forEach(function (b) { b.onclick = function () { pickName(b.dataset.n); closeModal(); }; });
    $("webName").addEventListener("keydown", function (e) { if (e.key === "Enter" && $("webName").value.trim()) { pickName($("webName").value.trim()); closeModal(); } });
  }

  // ---- start ------------------------------------------------------------------
  // the cuts themselves are the host's: they can be read here, not changed
  ["fPic", "fAct", "fSe", "fSeg"].forEach(function (id) { var e = $(id); if (e) { e.readOnly = true; e.title = "卡的內容在 After Effects 裡改"; } });
  document.addEventListener("dragstart", function (e) { if (e.target.closest && e.target.closest(".list")) e.preventDefault(); }, true);
  if (CLOUD) {                     // 雲端看片: the same screen and name; lib/cloud.js does the syncing
    phone();
    window.CENTO_WEB.cloud.ready.then(function () {          // the board is in once the sheet answered
      $("dot").title = "雲端看片：意見存在邀請你的人的 Google 試算表";
      if (!myId()) askName();
    });
    return;
  }
  var set = window.setStatus;
  window.setStatus = function (s) {
    var c = P.cuts[i];
    set(s);
    if (c && myId()) { myStatus[c.id] = { s: c.status || "", at: Date.now() }; }
  };
  var dirt = window.markDirty;
  window.markDirty = function () { dirt.apply(this, arguments); soon(); };
  var sel = window.select;
  window.select = function () { var r = sel.apply(this, arguments); showVotes(); return r; };
  var vb = document.createElement("div");
  vb.className = "webvotes"; vb.id = "webVotes";
  var sb = document.querySelector(".statbar");
  sb.parentNode.insertBefore(vb, sb.nextSibling);
  phone();
  restoreStatus();
  showVotes();
  $("dot").title = "網頁看片：意見會送到開著 AE 的電腦";
  if (!myId()) askName();
  showFrame(curFrame || 0);                 // fetch this cut's frame now, not on the first click
  loop();
})();

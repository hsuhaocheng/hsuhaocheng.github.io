/* 雲端看片: the panel opened from a link, in anybody's browser, with no After
 * Effects and no computer of ours to talk to. It stands in for lib/cep.js.
 *
 * The link is  review/#s=<sheet id>&v=<video id> . The host shared those two
 * files with this person's Google account. CENTO only asks for drive.file, so
 * the first time the person also picks the two files once in Google's picker;
 * after that the link opens straight into the board.
 *
 * The board comes from the sheet's 「片」 tab (lib/cloud.js G.film); notes,
 * marks and statuses from its 「紀錄」 tab, as for every computer that syncs.
 * Pictures: each cut's still from the sheet at once, then the film -- one
 * video of the whole board -- once it is downloaded. A paused frame is the
 * video sought to that frame; playing is the video playing, sound and all.
 *
 * Tests set window.CENTO_CLOUD_MOCK = { board, video } (a board and a video
 * URL) before this file and nothing goes to Google.
 */
(function (root) {
  var q = new URLSearchParams((root.location.hash || "").slice(1));
  var mock = root.CENTO_CLOUD_MOCK || null;
  var sheet = q.get("s") || "", videoId = q.get("v") || "";
  var FPS = 24;

  // ---- the film ---------------------------------------------------------------
  var video = document.createElement("video");
  video.preload = "auto"; video.playsInline = true; video.setAttribute("playsinline", "");
  var ready = false, playing = false, shown = -1, want = -1;
  function at(g) { return (g + 0.5) / FPS; }
  function seek(g) {
    want = g;
    if (!video.seeking) video.currentTime = at(g);
  }
  video.addEventListener("seeked", function () {
    shown = Math.floor(video.currentTime * FPS + 1e-4);
    if (want >= 0 && want !== shown && !playing) { video.currentTime = at(want); return; }
    if (cloud.redraw) cloud.redraw();
  });
  video.addEventListener("ended", function () { playing = false; });

  var cloud = {
    sheet: sheet, video: video, redraw: null,
    // the picture for frame g of the film: the video, when it is there. While
    // it seeks, the frame it shows now stands in, so stepping does not flicker.
    frame: function (g) {
      if (!ready) return null;
      if (playing) return video;
      if (g !== shown) seek(g);
      return shown >= 0 ? video : null;
    },
    play: function (g) {
      if (!ready) return false;
      want = -1; video.currentTime = at(g);
      playing = true;
      var p = video.play();
      if (p && p.catch) p.catch(function () { video.muted = true; video.play().catch(function () {}); });   // no sound before a tap: play muted
      return true;
    },
    pause: function () {
      if (!playing) return;
      playing = false; video.pause();
      shown = -1; want = -1;
    },
    playing: function () { return playing; },
    now: function () { return Math.floor(video.currentTime * FPS + 1e-4); },
    ready: null
  };

  function useVideo(url) {
    return new Promise(function (ok) {
      video.addEventListener("loadeddata", function () { ready = true; ok(); if (cloud.redraw) cloud.redraw(); }, { once: true });
      video.addEventListener("error", function () { ok(); }, { once: true });
      video.src = url;
    });
  }

  // ---- first time here: sign in, pick the two files ---------------------------
  var css = document.createElement("style");
  css.textContent =
    ".cvg{position:fixed;inset:0;z-index:100;background:#1d1d1d;color:#d6d6d6;display:flex;align-items:center;justify-content:center;font:15px/1.6 'Microsoft JhengHei',system-ui,sans-serif;padding:24px}" +
    ".cvg .in{max-width:360px;width:100%;text-align:center}.cvg .brand{letter-spacing:.3em;font-weight:bold;color:#fff;margin-bottom:28px}" +
    ".cvg .st{color:#8a8a8a;font-size:13px;margin-bottom:6px}.cvg .t{font-size:17px;color:#fff;margin-bottom:6px}.cvg .s{color:#9a9a9a;font-size:13px;margin-bottom:22px}" +
    ".cvg button{background:#4a8fe0;color:#fff;border:0;border-radius:22px;padding:11px 28px;font-size:16px;cursor:pointer}" +
    ".cvg .err{color:#e08a3a;font-size:13px;margin-top:14px;min-height:20px}" +
    ".cvload{position:fixed;left:0;right:0;top:0;height:3px;z-index:60}.cvload i{display:block;height:100%;width:0;background:#4a8fe0;transition:width .3s}";
  document.head.appendChild(css);
  var gate = null;
  function ask(step, title, sub, label) {
    return new Promise(function (ok) {
      if (!gate) {
        gate = document.createElement("div"); gate.className = "cvg";
        gate.innerHTML = '<div class="in"><div class="brand">CENTO</div><div class="st"></div><div class="t"></div><div class="s"></div><button></button><div class="err"></div></div>';
        document.body.appendChild(gate);
      }
      gate.querySelector(".st").textContent = step;
      gate.querySelector(".t").textContent = title;
      gate.querySelector(".s").textContent = sub;
      var b = gate.querySelector("button");
      b.textContent = label; b.disabled = false; b.hidden = !label;
      b.onclick = function () { b.disabled = true; say(""); ok(); };
    });
  }
  function say(t) { if (gate) gate.querySelector(".err").textContent = t; }
  function done() { if (gate) { gate.remove(); gate = null; } }

  function lib() {          // lib/cloud.js loads after the panel
    return new Promise(function (ok) {
      (function w() { if (root.CentoCloud) ok(root.CentoCloud); else setTimeout(w, 50); })();
    });
  }

  async function signIn(C) {
    for (;;) {
      if (C.signedIn()) { try { await C.token(); return; } catch (e) {} }
      var again = C.known();
      await ask(again ? "" : "1／2", again ? "繼續看片" : "用 Google 登入",
        again ? "Google 要你再確認一次，按一下就好。" : "邀請你的人只分享給你的 Google 帳號，要先登入才能看。", again ? "繼續" : "登入");
      try { await C.login(); return; }
      catch (e) { say("沒有登入（" + e.message + "），再按一次"); }
    }
  }
  async function readFilm(C) {
    for (var tries = 0; ; tries++) {
      try { var f = await C.G.film(sheet); if (f) return f; throw new Error("這不是 CENTO 的看板"); }
      catch (e) {
        if (e.auth) { await signIn(C); continue; }
        if (e.status !== 403 && e.status !== 404) throw e;
        if (tries) say("還是打不開。請確認邀請信寄到的是 " + (C.email() || "你登入的帳號") + "。");
        await ask("2／2", "選取這兩個檔", "Google 會列出邀請你的人分享的「看板」和「片」。兩個都勾起來，按「選取」。", "打開選取視窗");
        var got = await C.pick([sheet, videoId].filter(Boolean));
        if (!got) say("沒有選到檔案，再按一次");
      }
    }
  }
  async function download(C, id) {
    var bar = document.createElement("div"); bar.className = "cvload"; bar.innerHTML = "<i></i>";
    bar.title = "片子下載中"; document.body.appendChild(bar);
    try {
      var r = await C.media(id, function (got, all) { bar.firstChild.style.width = (all ? Math.round(100 * got / all) : 50) + "%"; });
      await useVideo(URL.createObjectURL(r));
    } catch (e) {
      if (root.toast) root.toast("片子載入失敗（" + e.message + "），先顯示每卡的代表圖", true);
    }
    bar.remove();
  }
  // the host published a new film: say so, and reload when asked
  function watch(C, ver) {
    setInterval(async function () {
      try {
        var f = await C.G.film(sheet, true);
        if (f && f.video && f.video.ver !== ver && !document.getElementById("cvNew")) {
          var b = document.createElement("div");
          b.id = "cvNew";
          b.style.cssText = "position:fixed;left:50%;top:10px;transform:translateX(-50%);z-index:70;background:#24324a;border:1px solid #4a8fe0;color:#fff;padding:7px 10px 7px 14px;font-size:13px;border-radius:4px";
          b.innerHTML = '有新版片子　<button style="background:#4a8fe0;color:#fff;border:0;padding:3px 12px;border-radius:3px">重新載入</button>';
          b.querySelector("button").onclick = function () { root.location.reload(); };
          document.body.appendChild(b);
        }
      } catch (e) {}
    }, 30000);
  }

  function board(f) {
    var b = f.board;
    if (b.fps) FPS = Math.max(1, Number(b.fps) || 24);
    b.cuts.forEach(function (c) { c.media = f.thumbs[c.id] ? { kind: "data", uri: f.thumbs[c.id] } : null; });
    if (sheet) b.cloud = { sheet: sheet };
    return { board: b, votes: {} };
  }

  cloud.ready = (async function () {
    await new Promise(function (ok) { if (document.readyState !== "loading") ok(); else document.addEventListener("DOMContentLoaded", ok); });
    if (mock) {
      var st = board({ board: mock.board, thumbs: mock.thumbs || {} });
      useVideo(mock.video);
      return st;
    }
    if (!sheet) throw new Error("這個連結不完整：少了看板的編號。請向邀請你的人要一次連結。");
    var C = await lib();
    await signIn(C);
    var f = await readFilm(C);
    done();
    var vid = (f.video && f.video.id) || videoId;
    if (vid) setTimeout(function () { download(C, vid); }, 0);
    watch(C, f.video && f.video.ver);
    return board(f);
  })();

  root.CENTO_WEB = { cloud: cloud, state: null };

  // ---- no After Effects here ------------------------------------------------
  var no = function () { return Promise.reject(new Error("雲端看片不能使用 After Effects 的功能")); };
  root.CEP = {
    available: function () { return false; },
    run: no, kill: function () {}, canRun: function () { return false; },
    openURL: function (url) { try { return !!root.open(url, "_blank"); } catch (e) { return false; } },
    osName: function () { return root.navigator ? root.navigator.platform : ""; },
    call: no,
    extensionPath: function () { return null; },
    readText: function () { return null; },
    writeBinary: function () { return false; },
    writeText: function () { throw new Error("雲端看片不會存檔"); },
    makeDir: function () { return false; },
    fileURL: function (path) { return String(path); },
    nodeRequire: function () { return null; }
  };
})(window);

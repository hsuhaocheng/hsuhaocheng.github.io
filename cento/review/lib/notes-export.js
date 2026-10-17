/* ⋯ → 匯出 PDF／試算表: the board's review, to read away from the panel.
 *
 * PDF: the board's name, the date and how many cuts are in each status on
 * one line; the cuts to redo or still talked over, one line each; then those
 * cuts in full -- passed cuts are done and left out. Each annotation is a
 * row: its frame with the drawing on the left, the words on the right, so
 * long feedback reads well.
 * It is a page made to be printed -- the browser's 另存為 PDF makes the PDF. CSV: one row per note, for Excel (with a BOM so it reads UTF-8).
 *
 * In After Effects the files go next to the board file and open in your
 * browser; in 網頁看片 the page opens in a new tab and the CSV downloads.
 */
(function () {
  var LABEL = { ok: "通過", fix: "重修", talk: "保留", "": "未審" };
  var stamp = function (at) {
    var d = new Date(at || Date.now());
    return d.getFullYear() + "/" + (d.getMonth() + 1) + "/" + d.getDate() + " " + String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  };
  var title = function () { return P.title || "CENTO"; };
  var day = function () { var d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };

  // a cut's review in order: notes and annotations by time, replies under what they answer
  function items(c) {
    var notes = c.notes || [];
    var keys = Object.keys(c.marks || {}).filter(function (k) { return c.marks[k] && (c.marks[k].strokes || []).length; }).map(Number);
    var parents = {};
    notes.forEach(function (n) { parents[n.id] = 1; });
    keys.forEach(function (k) { parents["m" + k] = 1; });
    var replies = function (key) { return notes.filter(function (n) { return n.re === key; }).sort(function (a, b) { return (a.at || 0) - (b.at || 0); }); };
    return notes.filter(function (n) { return !n.re || !parents[n.re]; }).map(function (n) { return { at: n.at || 0, n: n, re: replies(n.id) }; })
      .concat(keys.map(function (k) { return { at: c.marks[k].at || 0, k: k, m: c.marks[k], re: replies("m" + k) }; }))
      .sort(function (a, b) { return a.at - b.at; });
  }
  var span = function (it) { var end = it.k + ((it.m.hold) | 0); return (it.k + 1) + (end > it.k ? "–" + (end + 1) : ""); };

  // ---- CSV ------------------------------------------------------------------
  function csv() {
    var rows = [["卡號", "名稱", "審片結果", "種類", "格", "誰", "時間", "內容", "回覆給"]];
    P.cuts.forEach(function (c) {
      if (isBlank(c)) return;
      var base = [c.no, c.aeName || "", LABEL[c.status || ""]], list = items(c);
      if (!list.length) rows.push(base.concat(["", "", "", "", "", ""]));
      list.forEach(function (it) {
        if (it.n) rows.push(base.concat(["意見", "", it.n.who || "", stamp(it.n.at), it.n.text, ""]));
        else rows.push(base.concat(["批註", span(it), it.m.who || "", stamp(it.m.at), it.m.text || "（畫在畫面上）", ""]));
        it.re.forEach(function (r) { rows.push(base.concat(["回覆", it.n ? "" : span(it), r.who || "", stamp(r.at), r.text, it.n ? (it.n.who || "") : (it.m.who || "") + " 的批註"])); });
      });
    });
    var cell = function (v) { v = String(v == null ? "" : v); return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    return "﻿" + rows.map(function (r) { return r.map(cell).join(","); }).join("\r\n");
  }

  // ---- pictures for the PDF ---------------------------------------------------
  // a frame as a JPEG, with the annotation drawn on it; pos is where its numbered disc goes (percent)
  async function picture(n, f, mark, W) {
    var c = P.cuts[n], src = null;
    try {
      if (hasSeqFrame(n, f)) src = await loadSeqFrame(n, f);
      if (!src) src = await loadStill(c);
    } catch (e) {}
    W = W || 480;
    var H = Math.round(W * 9 / 16);
    var cv = document.createElement("canvas"); cv.width = W; cv.height = H;
    var cx = cv.getContext("2d");
    cx.fillStyle = "#e8e8e5"; cx.fillRect(0, 0, W, H);
    var box = { x: 0, y: 0, w: W, h: H };
    if (src) {
      var iw = src.width || src.naturalWidth, ih = src.height || src.naturalHeight;
      if (iw && ih) {
        var k = Math.min(W / iw, H / ih), dw = Math.round(iw * k), dh = Math.round(ih * k);
        box = { x: Math.round((W - dw) / 2), y: Math.round((H - dh) / 2), w: dw, h: dh };
        cx.drawImage(src, box.x, box.y, dw, dh);
      }
    }
    var pos = null;
    if (mark) {
      paintMarks(cx, [mark], box);
      // the disc sits at the end of the first stroke, kept inside the picture
      var st = (mark.strokes || [])[0] || [];
      if (st.length >= 2) {
        var x = st[st.length - 2], y = st[st.length - 1];
        pos = [Math.max(4, Math.min(96, (box.x + x * box.w) / W * 100)), Math.max(6, Math.min(94, (box.y + y * box.h) / H * 100))];
      }
    }
    var url = null;
    try { url = cv.toDataURL("image/jpeg", 0.82); } catch (e) {}       // a picture the browser will not let us read
    return { url: url, pos: pos };
  }

  // ---- the page: one line on top, then the cuts still to work on -------------
  // A status is a small coloured square with its glyph -- colour and shape, so
  // it survives black-and-white printing.
  var GLYPH = { ok: "✓", fix: "↻", talk: "‖", "": "–" };
  var badge = function (s) { s = s || ""; return '<span class="sg ' + (s || "none") + '" title="' + LABEL[s] + '">' + GLYPH[s] + "</span>"; };
  var pic = function (p, no) {
    if (!p || !p.url) return '<div class="pic nopic">沒有畫面</div>';
    return '<div class="pic"><img src="' + p.url + '">' + (no && p.pos ? '<span class="mk on" style="left:' + p.pos[0].toFixed(1) + "%;top:" + p.pos[1].toFixed(1) + '%">' + no + "</span>" : "") + "</div>";
  };
  var replies = function (list) {
    return list.map(function (r) { return '<div class="re"><div class="who"><b>' + esc(r.who || "匿名") + "</b>　" + stamp(r.at) + "</div><p>" + esc(r.text) + "</p></div>"; }).join("");
  };
  // one row: a small picture on the left, the words on the right -- long feedback gets the full width
  function row(p, no, who, at, f, text, re) {
    return '<div class="row">' + (p ? pic(p, no) : '<div></div>') + '<div class="body"><div class="who">' + (no ? '<span class="mk">' + no + "</span>" : "") +
      "<b>" + esc(who || "匿名") + "</b>　" + stamp(at) + (f ? '　<span class="f">✎ ' + f + "f</span>" : "") + "</div><p>" + esc(text) + "</p>" + replies(re) + "</div></div>";
  }
  var CSS =
    ':root{--ok:#5F7DA6;--fix:#CF7A3E;--talk:#8f8f8c;--red:#E1503C;--ink:#1d1d1f;--ink2:#555;--ink3:#8a8a8a;--rule:#e2e2df}' +
    '*{box-sizing:border-box}html{background:#e9e9e6}' +
    'body{background:#fff;color:var(--ink);font:12.5px/1.6 "Microsoft JhengHei","Noto Sans TC","PingFang TC",sans-serif;margin:0 auto;width:210mm;padding:12mm;' +
    '-webkit-print-color-adjust:exact;print-color-adjust:exact}' +
    '.mono{font-family:Consolas,"Roboto Mono",monospace}img{display:block}p{margin:0;white-space:pre-wrap}' +
    '.sg{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:4px;color:#fff;font:700 13px/1 sans-serif;flex:none}' +
    '.sg.ok{background:var(--ok)}.sg.fix{background:var(--fix)}.sg.talk{background:var(--talk)}.sg.none{background:#fff;color:#888;border:1.5px dashed #aaa}' +
    '.top{display:flex;align-items:baseline;justify-content:space-between;gap:10px;border-bottom:2px solid var(--ink);padding-bottom:5px;margin-bottom:4mm}' +
    '.top h1{font-size:18px;margin:0;line-height:1.3}.top .d{font-size:11px;color:var(--ink3);font-weight:400;margin-left:8px}' +
    '.cnt{display:flex;gap:12px;align-items:center;font:12px Consolas,monospace;white-space:nowrap}.cnt span.n{margin-left:4px}' +
    '.todo{list-style:none;margin:0 0 6mm;padding:0}.todo li{display:flex;gap:8px;align-items:center;padding:3px 0;border-bottom:1px dotted #ddd;font-size:12px}' +
    '.todo b{font:700 13px Consolas,monospace}.todo .q{color:#555;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}' +
    '.dc{border-top:1px solid #cfcfcb;padding-top:3mm;margin-bottom:5mm}.dc .hd{display:flex;align-items:center;gap:8px;margin-bottom:2mm;break-after:avoid}' +
    '.dc .no{font:700 24px/1 Consolas,monospace}' +
    '.row{display:grid;grid-template-columns:46mm 1fr;gap:4mm;padding:2.5mm 0;border-top:1px solid var(--rule);break-inside:avoid;page-break-inside:avoid}.row:first-of-type{border-top:0}' +
    '.pic{position:relative;border:1px solid #cfcfcb}.pic img{width:100%}.nopic{aspect-ratio:16/9;display:flex;align-items:center;justify-content:center;color:#999;background:#f2f2f0;font-size:11px}' +
    '.mk{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:50%;background:var(--red);color:#fff;font:700 11px/1 Consolas,monospace;margin-right:6px;vertical-align:-3px}' +
    '.mk.on{position:absolute;transform:translate(-50%,-50%);margin:0;border:1.5px solid #fff;box-shadow:0 0 0 1px var(--red)}' +
    '.who{color:var(--ink3);font-size:10.5px;margin-bottom:1px}.who b{color:var(--ink)}.f{color:#2f5d9a;font-weight:700}' +
    '.body p{font-size:13px}.re{margin:5px 0 0 2px;padding-left:10px;border-left:2px solid #cfcfcb}.re p{font-size:12.5px;color:#333}' +
    '@page{size:A4 portrait;margin:10mm}@media screen{body{box-shadow:0 1px 6px rgba(0,0,0,.15);margin:16px auto}}' +
    '@media print{html{background:#fff}body{width:auto;padding:0;box-shadow:none}}';

  async function page(say) {
    var real = P.cuts.filter(function (c) { return !isBlank(c); });
    var count = { ok: 0, fix: 0, talk: 0, "": 0 };
    real.forEach(function (c) { count[c.status || ""]++; });
    var h = '<div class="top"><h1>' + esc(title()) + '<span class="d">' + day().replace(/-/g, "/") + '</span></h1><div class="cnt">' +
      ["ok", "fix", "talk", ""].map(function (k) { return '<span>' + badge(k) + '<span class="n">' + count[k] + "</span></span>"; }).join("") + "</div></div>";
    // what is left to do: one line per cut to redo or still being talked over
    var first = function (c) {
      var it = items(c)[0];
      return it ? String(it.n ? it.n.text : (it.m.text || "✎ " + span(it) + "f 的批註")).split("\n")[0] : "";
    };
    var todo = real.filter(function (c) { return c.status === "fix" || c.status === "talk"; });
    if (todo.length) h += '<ul class="todo">' + todo.map(function (c) {
      return "<li><b>" + esc(c.no) + "</b>" + badge(c.status) + '<span class="q">' + esc(first(c)) + "</span></li>";
    }).join("") + "</ul>";
    // the cuts still to work on: passed ones are done, whatever was said on them
    for (var n = 0; n < P.cuts.length; n++) {
      var c = P.cuts[n];
      if (isBlank(c) || c.status === "ok") continue;
      var list = items(c);
      if (!list.length) continue;
      if (say) say("整理中 " + c.no);
      h += '<section class="dc"><div class="hd"><span class="no">' + esc(c.no) + "</span>" + badge(c.status) + "</div>";
      var no = 0, cover = null;
      for (var j = 0; j < list.length; j++) {
        var it = list[j];
        if (it.m) {
          no++;
          var p = await picture(n, it.k, it.m, 420);
          h += row(p, no, it.m.who, it.m.at, span(it), it.m.text || "（畫在畫面上）", it.re);
        } else {
          // a note on its own: beside the cut's picture, once
          var p0 = null;
          if (!cover) { cover = await picture(n, 0, null, 420); p0 = cover; }
          h += row(p0, 0, it.n.who, it.n.at, "", it.n.text, it.re);
        }
      }
      h += "</section>";
    }
    return '<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' +
      esc(title()) + " " + day() + "</title><style>" + CSS + "</style></head><body>" + h +
      "<script>window.onload=function(){setTimeout(function(){print()},400)}<\/script></body></html>";
  }

  // ---- where it goes ------------------------------------------------------------
  function folder() {
    var p = typeof savePath === "string" && savePath ? slashes(savePath) : "";
    return p ? p.slice(0, p.lastIndexOf("/")) : null;
  }
  function download(name, text, type) {
    var a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: type }));
    a.download = name; document.body.appendChild(a); a.click(); a.remove();
  }
  async function exportPdf() {
    var tab = WEB ? window.open("", "_blank") : null;          // opened on the click, so the browser lets it
    if (WEB && tab) tab.document.write('<p style="font:14px sans-serif">整理中…</p>');
    var html = await page(function (t) { saveState(t); });
    saveState(WEB ? "網頁看片" : "已存檔");
    if (WEB) {
      if (!tab) return toast("瀏覽器擋住了新視窗，請允許這個網站開新視窗", true);
      tab.document.open(); tab.document.write(html); tab.document.close();
      return;
    }
    var dir = folder();
    if (!dir) return toast("找不到看板存在哪裡", true);
    var path = dir + "/" + title() + " " + day() + ".html";
    try { CEP.writeText(path, html); } catch (e) { return showError("存不了：" + e.message); }
    CEP.openURL(CEP.fileURL(path));
    toast("已存在 " + path + "，在瀏覽器的列印視窗選「另存為 PDF」");
  }
  function exportCsv() {
    var name = title() + " " + day() + ".csv";
    if (WEB) return download(name, csv(), "text/csv;charset=utf-8");
    var dir = folder();
    if (!dir) return toast("找不到看板存在哪裡", true);
    try { CEP.writeText(dir + "/" + name, csv()); } catch (e) { return showError("存不了：" + e.message); }
    toast("已存成 " + dir + "/" + name);
  }
  function dialog() {
    openModal("匯出 PDF／試算表",
      '<div class="row2"><button class="btn" id="nxPdf">PDF</button>　<span style="color:var(--mute)">還要改的卡和它們的意見、批註（附畫面）；通過的卡不列。在列印視窗選「另存為 PDF」</span></div>' +
      '<div class="row2"><button class="btn" id="nxCsv">試算表（CSV）</button>　<span style="color:var(--mute)">全部的卡和意見，一則一列，Excel 打得開</span></div>', "", null);
    $("nxPdf").onclick = function () { closeModal(); exportPdf(); };
    $("nxCsv").onclick = function () { closeModal(); exportCsv(); };
  }

  (function wait() {
    if (typeof P === "undefined" || !P || !document.getElementById("keysBtn")) return setTimeout(wait, 200);
    var b = document.createElement("button");
    b.id = "notesBtn"; b.textContent = "匯出 PDF／試算表…";
    var keys = $("keysBtn");
    keys.parentNode.insertBefore(b, keys);
    b.addEventListener("click", dialog);
  })();
  window.CentoNotesCsv = csv;          // for tests
  window.CentoNotesPage = page;
})();

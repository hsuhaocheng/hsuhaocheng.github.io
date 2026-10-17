/* 網頁看片: how a board is shared between the computer running After Effects
 * (the host) and the people looking at it in a browser.
 *
 * The host's board is the one that counts. Every viewer sends one record --
 * only what they wrote -- and the host folds it into its board:
 *
 *   record = { id, name, notes: {cutId: [note]}, marks: {cutId: {frame: mark}},
 *              status: {cutId: {s, at}} }
 *
 * Nobody's record touches anybody else's notes or marks, so nothing is
 * overwritten. A cut's status is the latest one anybody gave it; everyone's
 * own answer is kept as a vote, to show where people disagree.
 *
 * Plain functions with no globals: the panel loads this, and node tests it.
 */
(function (root) {
  var clone = function (o) { return JSON.parse(JSON.stringify(o)); };

  // what one person wrote on a board
  function record(P, id, name, status) {
    var rec = { id: id, name: name, notes: {}, marks: {}, status: status || {} };
    P.cuts.forEach(function (c) {
      var n = (c.notes || []).filter(function (x) { return x.by === id; });
      if (n.length) rec.notes[c.id] = n;
      Object.keys(c.marks || {}).forEach(function (k) {
        var m = c.marks[k];
        if (m && m.by === id) (rec.marks[c.id] = rec.marks[c.id] || {})[k] = m;
      });
    });
    return rec;
  }

  // put one person's record into a board: their notes and marks replace what
  // the board had from them; nobody else's are touched
  function fold(P, rec) {
    var byId = {};
    P.cuts.forEach(function (c) { byId[c.id] = c; });
    P.cuts.forEach(function (c) {
      if (c.notes) c.notes = c.notes.filter(function (x) { return x.by !== rec.id; });
      if (c.marks) Object.keys(c.marks).forEach(function (k) {
        if (c.marks[k] && c.marks[k].by === rec.id && !((rec.marks || {})[c.id] || {})[k]) delete c.marks[k];
      });
    });
    Object.keys(rec.notes || {}).forEach(function (cid) {
      var c = byId[cid]; if (!c) return;
      var ids = {};
      rec.notes[cid].forEach(function (n) { ids[n.id] = 1; });
      c.notes = (c.notes || []).filter(function (n) { return !ids[n.id]; }).concat(clone(rec.notes[cid]));
      c.notes.sort(function (a, b) { return (a.at || 0) - (b.at || 0); });
    });
    Object.keys(rec.marks || {}).forEach(function (cid) {
      var c = byId[cid]; if (!c) return;
      c.marks = c.marks || {};
      Object.keys(rec.marks[cid]).forEach(function (k) {
        var have = c.marks[k], got = rec.marks[cid][k];
        // one annotation per frame: the newer drawing wins the frame
        if (!have || have.by === rec.id || (got.at || 0) >= (have.at || 0)) c.marks[k] = clone(got);
      });
    });
  }

  // everyone's latest answer per cut decides the cut's status
  function settle(P, votes) {
    P.cuts.forEach(function (c) {
      var best = null;
      Object.keys(votes).forEach(function (pid) {
        var v = (votes[pid].status || {})[c.id];
        if (v && (!best || v.at > best.at)) best = v;
      });
      if (best) c.status = best.s;
    });
  }

  // the board as a viewer gets it: no paths from this computer, and who said what about each cut
  function snapshot(P, votes) {
    var b = clone(P);
    delete b.cloud;                    // which Google sheet this board syncs with stays on the host
    b.cuts.forEach(function (c) {
      delete c.seqDir; delete c.aeSrc;
      if (c.media) c.media = c.media.kind === "path" || c.media.kind === "data"
        ? { kind: "web", url: "/still?cut=" + encodeURIComponent(c.id) + "&t=" + (c.media.t || 0) } : null;
    });
    var v = {};
    Object.keys(votes).forEach(function (pid) {
      Object.keys(votes[pid].status || {}).forEach(function (cid) {
        (v[cid] = v[cid] || []).push({ id: pid, who: votes[pid].name || "", s: votes[pid].status[cid].s, at: votes[pid].status[cid].at });
      });
    });
    return { board: b, votes: v };
  }

  // "意見不同：導演：通過｜小王：重修" -- empty unless two or more people answered
  function votesText(list, meId) {
    if (!list || list.length < 2) return null;
    var NAMES = { ok: "通過", fix: "重修", talk: "保留", "": "未審" };
    var differ = list.some(function (x) { return x.s !== list[0].s; });
    return { differ: differ, parts: list.slice().sort(function (a, b) { return a.at - b.at; })
      .map(function (x) { return { who: x.who + (x.id === meId ? "（我）" : ""), s: NAMES[x.s] || x.s }; }) };
  }

  var api = { record: record, fold: fold, settle: settle, snapshot: snapshot, votesText: votesText };
  if (root) root.CentoWeb = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : null);

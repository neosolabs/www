/**
 * Distributed trace, live.
 *
 * Most service maps show aggregate flow; most tracing UIs show a static
 * waterfall. This shows both at once and keeps them in lockstep: a sampled
 * request is born at the gateway and propagates hop-by-hop through the mesh
 * while its span waterfall builds underneath in the same clock. You watch the
 * request move through space (topology) and accrue time (waterfall) together.
 *
 * Timings are in microseconds. Spans nest strictly inside their parents; a
 * parent's duration is derived to cover its children, so the tree is always
 * consistent. Occasionally the order-book match runs slow and the whole trace
 * (path + bar + status) turns red.
 */
(function () {
  "use strict";

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  /* ── Topology (tiered: ingress → edge → core → state → persistence) ── */

  var NODES = [
    { id: "gateway", label: "gateway", nx: 0.5, ny: 0.08 },
    { id: "market-data", label: "market-data", nx: 0.17, ny: 0.34 },
    { id: "auth", label: "auth", nx: 0.83, ny: 0.34 },
    { id: "engine", label: "matching-engine", nx: 0.5, ny: 0.43 },
    { id: "order-book", label: "order-book", nx: 0.16, ny: 0.74 },
    { id: "risk", label: "risk", nx: 0.5, ny: 0.74 },
    { id: "ledger", label: "ledger", nx: 0.84, ny: 0.74 },
    { id: "journal", label: "journal", nx: 0.34, ny: 0.96 },
    { id: "audit", label: "audit", nx: 0.68, ny: 0.96 },
  ];

  var NODE_INDEX = {};
  NODES.forEach(function (n, i) {
    NODE_INDEX[n.id] = i;
  });

  // Directed edges for the ambient mesh; arc bows the curve to avoid overlap.
  var EDGES = [
    { from: "gateway", to: "engine", rps: 5200, arc: 0.0 },
    { from: "gateway", to: "auth", rps: 1200, arc: 0.14 },
    { from: "auth", to: "engine", rps: 980, arc: -0.12 },
    { from: "market-data", to: "engine", rps: 2800, arc: 0.08 },
    { from: "engine", to: "market-data", rps: 620, arc: -0.16 },
    { from: "engine", to: "order-book", rps: 3600, arc: -0.05 },
    { from: "engine", to: "risk", rps: 2400, arc: 0.0 },
    { from: "engine", to: "ledger", rps: 1900, arc: 0.05 },
    { from: "order-book", to: "risk", rps: 1100, arc: -0.07 },
    { from: "ledger", to: "journal", rps: 900, arc: 0.0 },
    { from: "engine", to: "audit", rps: 460, arc: 0.06 },
    { from: "risk", to: "audit", rps: 320, arc: -0.05 },
  ];

  var MAX_RPS = EDGES.reduce(function (m, e) {
    return Math.max(m, e.rps);
  }, 1);

  // arc lookup for arbitrary (from,to) pairs used by the trace tokens
  var ARC = {};
  EDGES.forEach(function (e) {
    ARC[e.from + ">" + e.to] = e.arc;
    if (ARC[e.to + ">" + e.from] === undefined) ARC[e.to + ">" + e.from] = -e.arc;
  });

  var INGRESS_RPS = 118000;

  /*
   * Trace template (µs). Real limit-order flow, causally scheduled:
   *   gateway → auth (authenticate)
   *           → matching-engine
   *                → risk        (PRE-TRADE margin/credit check — gates the match)
   *                → order-book  (match, only after risk clears)
   *                → ledger      (settle, only after the match completes)
   *                     → journal (append settlement event)
   *                → market-data (publish the resulting tick, after the match)
   *                → audit       (compliance log, after the match)
   *
   * A span either starts at an offset from its parent (`t0`) or strictly after
   * a dependency finishes (`after` + `gap`). So a slow match pushes settle,
   * publish, and audit later too — exactly as a real dependency chain behaves.
   */
  var TRACE_TEMPLATE = [
    { id: 0, service: "gateway", parent: -1, depth: 0, t0: 0, container: true },
    { id: 1, service: "auth", parent: 0, depth: 1, t0: 45, dur: 170 },
    { id: 2, service: "engine", parent: 0, depth: 1, after: 1, gap: 20, container: true },
    { id: 3, service: "risk", parent: 2, depth: 2, t0: 15, dur: 150 },
    { id: 4, service: "order-book", parent: 2, depth: 2, after: 3, gap: 12, dur: 500 },
    { id: 5, service: "ledger", parent: 2, depth: 2, after: 4, gap: 25, dur: 300 },
    { id: 6, service: "journal", parent: 5, depth: 3, t0: 40, dur: 150 },
    { id: 7, service: "market-data", parent: 2, depth: 2, after: 4, gap: 10, dur: 90 },
    { id: 8, service: "audit", parent: 2, depth: 2, after: 4, gap: 30, dur: 80 },
  ];

  var TRAVEL_US = 60; // request/response hop time shown as a moving token

  function generateTrace(rng) {
    var slow = rng() < 0.22;

    var spans = TRACE_TEMPLATE.map(function (s) {
      return {
        id: s.id,
        service: s.service,
        parent: s.parent,
        depth: s.depth,
        container: !!s.container,
        _t0: s.t0,
        _after: s.after === undefined ? null : s.after,
        _gap: s.gap || 0,
        dur: (s.dur || 0) * (0.85 + rng() * 0.3),
        crit: false,
      };
    });

    if (slow) spans[4].dur *= 2 + rng(); // order-book match stalls

    var byId = {};
    spans.forEach(function (s) {
      byId[s.id] = s;
    });

    // Template is ordered so every dependency precedes its dependents.
    spans.forEach(function (s) {
      if (s.parent < 0) {
        s.start = 0;
        return;
      }
      var base = s._after !== null ? byId[s._after].end : byId[s.parent].start;
      var off = (s._after !== null ? s._gap : s._t0) * (0.9 + rng() * 0.2);
      s.start = base + off;
      if (!s.container) s.end = s.start + s.dur;
    });

    // Container spans (engine before gateway) enclose their children.
    [2, 0].forEach(function (cid) {
      var c = byId[cid];
      var end = c.start;
      spans.forEach(function (s) {
        if (s.parent === cid && s.end !== undefined && s.end > end) end = s.end;
      });
      c.dur = end - c.start + 28 * (0.8 + rng() * 0.4);
      c.end = c.start + c.dur;
    });

    var crit = null;
    spans.forEach(function (s) {
      if (!s.container && (!crit || s.dur > crit.dur)) crit = s;
    });
    if (crit) crit.crit = true;

    var id = Math.floor(rng() * 0xffffff).toString(16);
    while (id.length < 6) id = "0" + id;

    return {
      spans: spans,
      byId: byId,
      duration: byId[0].end,
      critical: crit,
      slow: slow,
      id: id,
    };
  }

  function selfTest() {
    var t = generateTrace(function () {
      return 0.42;
    });
    if (t.duration <= 0) throw new Error("trace duration must be positive");
    t.spans.forEach(function (s) {
      if (s.dur <= 0) throw new Error("span dur must be positive");
      if (s.parent >= 0) {
        var p = t.byId[s.parent];
        if (s.start < p.start - 1e-6 || s.end > p.end + 1e-6) {
          throw new Error("span " + s.id + " escapes its parent");
        }
      }
    });
    if (!t.critical) throw new Error("critical span not identified");
  }

  selfTest();

  /* ── Geometry ── */

  function bezier(x1, y1, x2, y2, arc, t) {
    var cx = (x1 + x2) / 2 + (y2 - y1) * arc;
    var cy = (y1 + y2) / 2 - (x2 - x1) * arc;
    var mt = 1 - t;
    return {
      x: mt * mt * x1 + 2 * mt * t * cx + t * t * x2,
      y: mt * mt * y1 + 2 * mt * t * cy + t * t * y2,
    };
  }

  function fmtUs(us) {
    if (us >= 1000) return (us / 1000).toFixed(2) + "ms";
    return Math.round(us) + "µs";
  }

  /* ── Visualization ── */

  var TARGET_PX_PER_MS = 0.05; // ambient dot speed (px per ms of wall clock)
  var PLAY_MS = 3200; // wall time to play a trace start→finish
  var HOLD_MS = 1500; // wall time to hold the completed trace
  var MONO = '"IBM Plex Mono", ui-monospace, monospace';

  function ObservabilityViz(root) {
    this.root = root;
    this.canvas = root.querySelector(".obs-viz__canvas");
    this.ctx = this.canvas.getContext("2d");
    this.elThroughput = root.querySelector("[data-obs-throughput]");
    this.elTrace = root.querySelector("[data-obs-trace]");
    this.elDuration = root.querySelector("[data-obs-duration]");
    this.elCrit = root.querySelector("[data-obs-crit]");

    this.trace = generateTrace(Math.random);
    this.phase = "playing";
    this.playElapsed = 0;
    this.holdElapsed = 0;
    this.clock = 0;
    this.ambientClock = 0;
    this.frame = 0;

    this.running = false;
    this.started = false;
    this.raf = null;
    this.lastTs = 0;
    this.width = 0;
    this.height = 0;
    this.nodePos = [];
    this.edgeGeom = [];

    this.prefersReducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    ).matches;

    var self = this;
    if ("ResizeObserver" in window) {
      new ResizeObserver(function () {
        self.resize();
        self.draw();
      }).observe(this.canvas);
    } else {
      window.addEventListener("resize", function () {
        self.resize();
        self.draw();
      });
    }

    this._onVisibility = function () {
      if (document.hidden) {
        self.running = false;
        if (self.raf) cancelAnimationFrame(self.raf);
        self.raf = null;
      } else if (self.started && !self.prefersReducedMotion) {
        self.running = true;
        self.lastTs = 0;
        self.raf = requestAnimationFrame(self._boundStep);
      }
    };
    document.addEventListener("visibilitychange", this._onVisibility);
  }

  ObservabilityViz.prototype.resize = function () {
    var rect = this.canvas.getBoundingClientRect();
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var w = Math.max(rect.width, 300);
    var h = Math.max(rect.height, 340);
    this.canvas.width = Math.floor(w * dpr);
    this.canvas.height = Math.floor(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.width = w;
    this.height = h;
    this.computeLayout();
  };

  ObservabilityViz.prototype.computeLayout = function () {
    var w = this.width;
    var h = this.height;

    // Split: topology on top, span waterfall below.
    this.topoTop = 16;
    this.topoBottom = h * 0.54;
    this.waterTop = h * 0.6;
    this.waterBottom = h - 20;
    this.labelW = Math.min(150, w * 0.26);

    var padX = 46;
    var innerW = w - padX * 2;
    var self = this;
    this.nodePos = NODES.map(function (n) {
      return {
        x: padX + n.nx * innerW,
        y: self.topoTop + n.ny * (self.topoBottom - self.topoTop),
      };
    });

    // Precompute edge polylines + length (for constant-speed ambient dots).
    this.edgeGeom = EDGES.map(function (e) {
      var a = self.nodePos[NODE_INDEX[e.from]];
      var b = self.nodePos[NODE_INDEX[e.to]];
      var pts = [];
      var len = 0;
      var ppx, ppy;
      for (var s = 0; s <= 16; s++) {
        var p = bezier(a.x, a.y, b.x, b.y, e.arc, s / 16);
        if (s > 0) len += Math.hypot(p.x - ppx, p.y - ppy);
        ppx = p.x;
        ppy = p.y;
        pts.push(p.x, p.y);
      }
      var norm = e.rps / MAX_RPS;
      var count = clamp(1 + Math.round(norm * 4), 1, 6);
      var dots = [];
      for (var d = 0; d < count; d++) dots.push((d + 0.5) / count);
      return {
        pts: pts,
        norm: norm,
        len: Math.max(40, len),
        tSpeed: TARGET_PX_PER_MS / Math.max(40, len),
        dots: dots,
      };
    });
  };

  ObservabilityViz.prototype.node = function (id) {
    return this.nodePos[NODE_INDEX[id]];
  };

  ObservabilityViz.prototype.newTrace = function () {
    this.trace = generateTrace(Math.random);
    this.clock = 0;
    this.playElapsed = 0;
    this.holdElapsed = 0;
    this.phase = "playing";
  };

  ObservabilityViz.prototype.advance = function (dt) {
    this.ambientClock += dt;
    var i, j, g;
    for (i = 0; i < this.edgeGeom.length; i++) {
      g = this.edgeGeom[i];
      for (j = 0; j < g.dots.length; j++) {
        g.dots[j] = (g.dots[j] + g.tSpeed * dt) % 1;
      }
    }

    var tr = this.trace;
    if (this.phase === "playing") {
      this.playElapsed += dt;
      this.clock = clamp((this.playElapsed / PLAY_MS) * tr.duration, 0, tr.duration);
      if (this.playElapsed >= PLAY_MS) {
        this.clock = tr.duration;
        this.phase = "hold";
        this.holdElapsed = 0;
      }
    } else {
      this.holdElapsed += dt;
      if (this.holdElapsed >= HOLD_MS) this.newTrace();
    }
  };

  ObservabilityViz.prototype.updateMeta = function () {
    var tr = this.trace;
    var ing = Math.round(
      INGRESS_RPS * (1 + 0.035 * Math.sin(this.ambientClock * 0.0006))
    );
    if (this.elThroughput) {
      this.elThroughput.textContent = Math.round(ing / 1000) + "k rps";
    }
    if (this.elTrace) this.elTrace.textContent = tr.id;
    if (this.elDuration) {
      this.elDuration.textContent = fmtUs(this.clock);
      this.elDuration.classList.toggle("is-neg", tr.slow);
      this.elDuration.classList.toggle("is-pos", !tr.slow && this.clock >= tr.duration);
    }
    if (this.elCrit && tr.critical) {
      var lbl = NODES[NODE_INDEX[tr.critical.service]].label;
      this.elCrit.textContent =
        lbl + " · " + fmtUs(tr.critical.dur) + (tr.slow ? " · slow" : "");
      this.elCrit.classList.toggle("is-neg", tr.slow);
    }
  };

  ObservabilityViz.prototype.waterX = function (us) {
    var tr = this.trace;
    var x0 = this.labelW;
    var x1 = this.width - 16;
    return x0 + (us / tr.duration) * (x1 - x0);
  };

  ObservabilityViz.prototype.draw = function () {
    var ctx = this.ctx;
    var w = this.width;
    var h = this.height;
    if (!this.nodePos.length) return;

    ctx.clearRect(0, 0, w, h);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    this.drawTopology();
    this.drawWaterfall();
  };

  ObservabilityViz.prototype.drawTopology = function () {
    var ctx = this.ctx;
    var tr = this.trace;
    var clock = this.clock;
    var i, j;

    // Which edges / nodes are lit by active spans right now.
    var activeEdge = {};
    var activeNode = {};
    for (i = 0; i < tr.spans.length; i++) {
      var s = tr.spans[i];
      if (clock >= s.start && clock <= s.end) {
        // Level 2 (red) means genuinely slow; the healthy path stays white.
        var hot = tr.slow && s.crit ? 2 : 1;
        activeNode[s.service] = Math.max(activeNode[s.service] || 0, hot);
        if (s.parent >= 0) {
          var ps = tr.byId[s.parent];
          activeEdge[ps.service + ">" + s.service] = hot;
        }
      }
    }

    // 1. Ambient mesh: faint hairlines + dim drifting dots.
    for (i = 0; i < this.edgeGeom.length; i++) {
      var g = this.edgeGeom[i];
      var gg = Math.round(24 + g.norm * 34);
      ctx.strokeStyle = "rgb(" + gg + "," + gg + "," + (gg + 4) + ")";
      ctx.lineWidth = 0.6 + g.norm * 0.9;
      ctx.beginPath();
      ctx.moveTo(g.pts[0], g.pts[1]);
      for (j = 2; j < g.pts.length; j += 2) ctx.lineTo(g.pts[j], g.pts[j + 1]);
      ctx.stroke();
    }
    for (i = 0; i < this.edgeGeom.length; i++) {
      var g2 = this.edgeGeom[i];
      var e = EDGES[i];
      var a = this.node(e.from);
      var b = this.node(e.to);
      for (j = 0; j < g2.dots.length; j++) {
        var p = bezier(a.x, a.y, b.x, b.y, e.arc, g2.dots[j]);
        ctx.fillStyle = "rgba(150,154,164,0.5)";
        ctx.beginPath();
        ctx.arc(p.x, p.y, 1.2 + g2.norm * 0.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // 2. Active trace edges: bright over the ambient mesh.
    for (var key in activeEdge) {
      var ends = key.split(">");
      var na = this.node(ends[0]);
      var nb = this.node(ends[1]);
      var arc = ARC[key] || 0;
      var strong = activeEdge[key] === 2;
      ctx.strokeStyle = strong ? "rgba(214,164,164,0.9)" : "rgba(238,240,246,0.85)";
      ctx.lineWidth = strong ? 2 : 1.6;
      ctx.beginPath();
      for (j = 0; j <= 18; j++) {
        var pp = bezier(na.x, na.y, nb.x, nb.y, arc, j / 18);
        if (j === 0) ctx.moveTo(pp.x, pp.y);
        else ctx.lineTo(pp.x, pp.y);
      }
      ctx.stroke();
    }

    // 3. Request/response tokens travelling the current hops.
    for (i = 0; i < tr.spans.length; i++) {
      var sp = tr.spans[i];
      if (sp.parent < 0) continue;
      var parent = tr.byId[sp.parent];
      var from = this.node(parent.service);
      var to = this.node(sp.service);
      var arc2 = ARC[parent.service + ">" + sp.service] || 0;
      var tok = null;
      var back = false;
      if (clock >= sp.start && clock <= sp.start + TRAVEL_US) {
        tok = (clock - sp.start) / TRAVEL_US;
      } else if (clock >= sp.end - TRAVEL_US && clock <= sp.end) {
        tok = (clock - (sp.end - TRAVEL_US)) / TRAVEL_US;
        back = true;
      }
      if (tok === null) continue;
      var pt = back
        ? bezier(to.x, to.y, from.x, from.y, -arc2, tok)
        : bezier(from.x, from.y, to.x, to.y, arc2, tok);
      ctx.fillStyle = tr.slow && sp.crit ? "#e6a6a6" : "#ffffff";
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 2.6, 0, Math.PI * 2);
      ctx.fill();
    }

    // 4. Nodes.
    for (i = 0; i < NODES.length; i++) {
      var n = NODES[i];
      var pos = this.nodePos[i];
      var act = activeNode[n.id] || 0;
      var r = act ? 6 : 4.6;
      var crit = act === 2;

      if (act) {
        var ring = crit ? "rgba(214,164,164,0.5)" : "rgba(238,240,246,0.45)";
        ctx.strokeStyle = ring;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, r + 4, 0, Math.PI * 2);
        ctx.stroke();
      }

      ctx.fillStyle = "#050505";
      ctx.strokeStyle = act ? (crit ? "#e0a3a3" : "#f2f4f8") : "#4a4a4a";
      ctx.lineWidth = act ? 1.6 : 1.1;
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      if (act) {
        ctx.fillStyle = crit ? "#eccaca" : "#eef0f4";
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, r * 0.42, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.fillStyle = act ? "#eceef2" : "#8f939b";
      ctx.font = (act ? "500" : "400") + " 8px " + MONO;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillText(n.label, pos.x, pos.y + r + 5);
    }
  };

  ObservabilityViz.prototype.drawWaterfall = function () {
    var ctx = this.ctx;
    var tr = this.trace;
    var w = this.width;
    var top = this.waterTop;
    var bottom = this.waterBottom;
    var rows = tr.spans.length;
    var rowH = (bottom - top) / rows;
    var clock = this.clock;
    var i;

    // Divider + section label.
    ctx.strokeStyle = "#1a1a1a";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, top - 12);
    ctx.lineTo(w, top - 12);
    ctx.stroke();

    ctx.fillStyle = "#6a6e76";
    ctx.font = "400 8px " + MONO;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText("span waterfall", 2, top - 22);

    // Time gridlines.
    var frac = [0, 0.25, 0.5, 0.75, 1];
    for (i = 0; i < frac.length; i++) {
      var gx = this.waterX(frac[i] * tr.duration);
      ctx.strokeStyle = "rgba(255,255,255,0.045)";
      ctx.beginPath();
      ctx.moveTo(gx, top - 6);
      ctx.lineTo(gx, bottom + 4);
      ctx.stroke();
      ctx.fillStyle = "#5a5e66";
      ctx.font = "400 7px " + MONO;
      ctx.textAlign = i === frac.length - 1 ? "right" : "left";
      ctx.textBaseline = "top";
      ctx.fillText(fmtUs(frac[i] * tr.duration), gx + (i === frac.length - 1 ? -1 : 2), bottom + 6);
    }

    // Span bars.
    for (i = 0; i < rows; i++) {
      var s = tr.spans[i];
      var cy = top + (i + 0.5) * rowH;
      var barH = Math.min(11, rowH * 0.52);
      var revealed = clock >= s.start;
      var x0 = this.waterX(s.start);
      var x1 = this.waterX(Math.min(clock, s.end));
      var started = clock >= s.start;
      var live = clock >= s.start && clock < s.end;

      // Row label (indented by depth).
      ctx.fillStyle = started ? (s.crit ? "#e0b0b0" : "#c4c8d0") : "#565a62";
      ctx.font = "400 8px " + MONO;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      var lbl = NODES[NODE_INDEX[s.service]].label;
      ctx.fillText(lbl, 4 + s.depth * 9, cy);

      // Track baseline.
      ctx.strokeStyle = "rgba(255,255,255,0.05)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(this.labelW, cy);
      ctx.lineTo(w - 16, cy);
      ctx.stroke();

      if (!revealed) continue;

      var barW = Math.max(1.5, x1 - x0);
      if (s.container) {
        // Aggregation spans: hollow bracket, low emphasis.
        ctx.strokeStyle = "rgba(180,184,192,0.4)";
        ctx.lineWidth = 1;
        ctx.strokeRect(x0, cy - barH / 2, barW, barH);
      } else {
        var col = tr.slow && s.crit
          ? "rgba(200,120,120,0.92)"
          : s.crit
            ? "rgba(240,242,248,0.95)"
            : "rgba(150,156,168,0.85)";
        ctx.fillStyle = col;
        ctx.fillRect(x0, cy - barH / 2, barW, barH);
        if (live) {
          // Bright leading edge while the span is still open.
          ctx.fillStyle = "#ffffff";
          ctx.fillRect(x1 - 1.5, cy - barH / 2, 1.5, barH);
        }
      }

      // Duration label once the span has closed.
      if (clock >= s.end && !s.container) {
        ctx.fillStyle = "#7c8088";
        ctx.font = "400 7px " + MONO;
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        var tx = x1 + 4;
        var dl = fmtUs(s.dur);
        if (tx + ctx.measureText(dl).width > w - 4) {
          ctx.textAlign = "right";
          tx = x0 - 4;
        }
        ctx.fillText(dl, tx, cy);
      }
    }

    // Playhead.
    if (this.phase === "playing") {
      var px = this.waterX(clock);
      ctx.strokeStyle = "rgba(255,255,255,0.5)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(px, top - 6);
      ctx.lineTo(px, bottom + 4);
      ctx.stroke();
    }
  };

  ObservabilityViz.prototype.step = function (ts) {
    if (!this.running) return;
    if (!this.lastTs) this.lastTs = ts;
    var dt = Math.min(48, ts - this.lastTs);
    this.lastTs = ts;
    this.frame++;

    this.advance(dt);
    if (this.frame % 3 === 0) this.updateMeta();
    this.draw();

    this._boundStep = this._boundStep || this.step.bind(this);
    this.raf = requestAnimationFrame(this._boundStep);
  };

  ObservabilityViz.prototype.start = function () {
    this.resize();
    this.started = true;

    if (this.prefersReducedMotion) {
      // Show one completed trace, statically.
      this.clock = this.trace.duration;
      this.phase = "hold";
      this.updateMeta();
      this.draw();
      return;
    }

    this.updateMeta();
    this.draw();
    if (document.hidden) return;

    this.running = true;
    this.lastTs = 0;
    this._boundStep = this._boundStep || this.step.bind(this);
    this.raf = requestAnimationFrame(this._boundStep);
  };

  ObservabilityViz.prototype.destroy = function () {
    this.running = false;
    this.started = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    document.removeEventListener("visibilitychange", this._onVisibility);
  };

  if (typeof document !== "undefined") {
    var root = document.getElementById("observability-viz");
    if (root) {
      var viz = new ObservabilityViz(root);
      if ("IntersectionObserver" in window) {
        var obs = new IntersectionObserver(
          function (entries) {
            entries.forEach(function (entry) {
              if (entry.isIntersecting) {
                viz.start();
                obs.disconnect();
              }
            });
          },
          { threshold: 0.15 }
        );
        obs.observe(root);
      } else {
        viz.start();
      }
    }
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { generateTrace: generateTrace, TRACE_TEMPLATE: TRACE_TEMPLATE };
  }
})();

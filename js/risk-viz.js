/**
 * Real-time risk engine — isolated-margin liquidation for a linear perp.
 *
 * One shared mark price drives every open position. Move it (drag the line or
 * use the slider) and unrealized PnL, margin ratio, and liquidations recompute
 * live — the same loop an exchange runs on every price tick.
 *
 * Isolated USDT-margined model (linear perp):
 *   IM        = size * entry / leverage          (locked initial margin)
 *   uPnL      = ±size * (mark - entry)            (+ for long, − for short)
 *   equity    = IM + uPnL
 *   marginPct = equity / (size * mark)
 *   liquidate when marginPct <= MMR
 *
 * Closed-form liquidation price:
 *   long : entry * (1 - 1/leverage) / (1 - MMR)
 *   short: entry * (1 + 1/leverage) / (1 + MMR)
 */
(function () {
  "use strict";

  var MMR = 0.005; // maintenance margin rate (0.5%)

  function liqPrice(side, entry, leverage) {
    return side === "long"
      ? (entry * (1 - 1 / leverage)) / (1 - MMR)
      : (entry * (1 + 1 / leverage)) / (1 + MMR);
  }

  function positionState(pos, mark) {
    var im = (pos.size * pos.entry) / pos.leverage;
    var upnl =
      pos.side === "long"
        ? pos.size * (mark - pos.entry)
        : pos.size * (pos.entry - mark);
    var equity = im + upnl;
    var notional = pos.size * mark;
    var marginPct = notional > 0 ? equity / notional : 0;
    var imr = 1 / pos.leverage;
    var health = (marginPct - MMR) / (imr - MMR);
    if (health < 0) health = 0;
    if (health > 1) health = 1;
    return {
      im: im,
      upnl: upnl,
      equity: equity,
      notional: notional,
      marginPct: marginPct,
      health: health,
      liq: liqPrice(pos.side, pos.entry, pos.leverage),
      liquidated: marginPct <= MMR,
    };
  }

  /* The open book. On-screen column order is NOT this array order: columns
     sort live by proximity to liquidation (riskiest at the left) and glide as
     the mark moves, so this list is just the positions as they were opened. */
  var SCENARIO = [
    { side: "short", size: 0.6, entry: 62800, leverage: 20 },
    { side: "short", size: 1.0, entry: 60500, leverage: 15 },
    { side: "long", size: 0.8, entry: 58500, leverage: 10 },
    { side: "long", size: 2.2, entry: 59800, leverage: 8 },
    { side: "long", size: 1.5, entry: 61200, leverage: 5 },
  ];
  var START_MARK = 60000;

  /* Auto-tour sweeps the extremes so every tier eventually liquidates. */
  var AUTO_TARGETS = [53000, 49000, 62000, 65800, 60000];

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function fmtUsd(v) {
    var n = Math.round(v);
    return "$" + n.toLocaleString("en-US");
  }

  function fmtSigned(v) {
    var s = v < 0 ? "-$" : "+$";
    return s + Math.round(Math.abs(v)).toLocaleString("en-US");
  }

  function pickSide(side) {
    for (var i = 0; i < SCENARIO.length; i++) {
      if (SCENARIO[i].side === side) return SCENARIO[i];
    }
    return null;
  }

  function selfTest() {
    // At entry marginPct == 1/lev; at the liq price it equals MMR.
    var lp = pickSide("long");
    var atEntry = positionState(lp, lp.entry);
    if (Math.abs(atEntry.marginPct - 1 / lp.leverage) > 1e-9) {
      throw new Error("marginPct at entry must equal 1/leverage");
    }
    var atLiq = positionState(lp, liqPrice("long", lp.entry, lp.leverage));
    if (Math.abs(atLiq.marginPct - MMR) > 1e-9) {
      throw new Error("marginPct at liq price must equal MMR");
    }
    if (!positionState(lp, atLiq.liq - 1).liquidated) {
      throw new Error("long must liquidate below its liq price");
    }
    var sp = pickSide("short");
    if (!positionState(sp, liqPrice("short", sp.entry, sp.leverage) + 1).liquidated) {
      throw new Error("short must liquidate above its liq price");
    }
  }

  selfTest();

  /* ── Canvas visualization ── */

  var GUTTER = 46;
  var PLOT_TOP = 34;
  var PLOT_BOTTOM_PAD = 24;

  function RiskViz(root) {
    this.root = root;
    this.canvas = root.querySelector(".risk-viz__canvas");
    this.ctx = this.canvas.getContext("2d");
    this.slider = root.querySelector(".risk-viz__slider");
    this.elMarkOut = root.querySelector("[data-risk-markout]");
    this.elMark = root.querySelector("[data-risk-mark]");
    this.elOi = root.querySelector("[data-risk-oi]");
    this.elUpnl = root.querySelector("[data-risk-upnl]");
    this.elPos = root.querySelector("[data-risk-pos]");
    this.elLiq = root.querySelector("[data-risk-liq]");
    this.elIns = root.querySelector("[data-risk-ins]");

    this.mark = START_MARK;
    this.dragging = false;
    this.manualUntil = 0;
    this.autoIdx = 0;
    this.dwellUntil = 0;
    this.resetAt = 0;
    this.positions = [];
    this.liquidations = 0;
    this.insurance = 0;
    this.running = false;
    this.started = false;
    this.raf = null;
    this.lastTs = 0;
    this.frame = 0;
    this.width = 0;
    this.height = 0;
    this.minP = 0;
    this.maxP = 0;

    this.prefersReducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    ).matches;

    this.computeBounds();
    this.resetPositions();

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

    this.bindInteraction();

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

  RiskViz.prototype.computeBounds = function () {
    var lo = Infinity;
    var hi = -Infinity;
    SCENARIO.forEach(function (p) {
      var l = liqPrice(p.side, p.entry, p.leverage);
      lo = Math.min(lo, l, p.entry);
      hi = Math.max(hi, l, p.entry);
    });
    lo = Math.min(lo, START_MARK);
    hi = Math.max(hi, START_MARK);
    var pad = (hi - lo) * 0.06;
    this.minP = lo - pad;
    this.maxP = hi + pad;

    if (this.slider) {
      this.slider.min = String(Math.round(this.minP));
      this.slider.max = String(Math.round(this.maxP));
      this.slider.step = "10";
      this.slider.value = String(Math.round(this.mark));
    }
  };

  RiskViz.prototype.resetPositions = function () {
    this.positions = SCENARIO.map(function (p) {
      return {
        side: p.side,
        size: p.size,
        entry: p.entry,
        leverage: p.leverage,
        liq: liqPrice(p.side, p.entry, p.leverage),
        liquidated: false,
        flash: 0,
      };
    });
    this.mark = START_MARK;
    this.autoIdx = 0;
    this.dwellUntil = 0;
    this.resetAt = 0;
  };

  RiskViz.prototype.resize = function () {
    var rect = this.canvas.getBoundingClientRect();
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var w = Math.max(rect.width, 300);
    var h = Math.max(rect.height, 260);
    this.canvas.width = Math.floor(w * dpr);
    this.canvas.height = Math.floor(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.width = w;
    this.height = h;
    this.snapNext = true; // snap columns to their slots (no glide) on resize
  };

  RiskViz.prototype.plotBottom = function () {
    return this.height - PLOT_BOTTOM_PAD;
  };

  RiskViz.prototype.priceToY = function (price) {
    var top = PLOT_TOP;
    var bottom = this.plotBottom();
    var t = (this.maxP - price) / (this.maxP - this.minP);
    return top + t * (bottom - top);
  };

  RiskViz.prototype.yToPrice = function (y) {
    var top = PLOT_TOP;
    var bottom = this.plotBottom();
    var t = (y - top) / (bottom - top);
    return clamp(this.maxP - t * (this.maxP - this.minP), this.minP, this.maxP);
  };

  RiskViz.prototype.columnX = function (slot) {
    var innerLeft = GUTTER + 8;
    var innerRight = this.width - 12;
    var colW = (innerRight - innerLeft) / this.positions.length;
    return innerLeft + colW * (slot + 0.5);
  };

  // How far the mark can move before this position liquidates, as a fraction
  // of the current mark. Smaller = more urgent.
  RiskViz.prototype.distanceFrac = function (pos) {
    var d = pos.side === "long" ? this.mark - pos.liq : pos.liq - this.mark;
    return Math.max(0, d) / this.mark;
  };

  RiskViz.prototype.sortKey = function (pos) {
    return pos.liquidated ? Infinity : this.distanceFrac(pos);
  };

  // Sort columns by ascending distance-to-liquidation (riskiest leftmost);
  // liquidated positions fall to the right. Columns glide to their slots.
  RiskViz.prototype.layoutColumns = function (snap) {
    var self = this;
    var order = this.positions.map(function (_, i) {
      return i;
    });
    order.sort(function (a, b) {
      var ka = self.sortKey(self.positions[a]);
      var kb = self.sortKey(self.positions[b]);
      if (ka !== kb) return ka - kb;
      return a - b; // stable tiebreak — no flicker on near-ties
    });
    for (var s = 0; s < order.length; s++) {
      var pos = this.positions[order[s]];
      var target = this.columnX(s);
      if (snap || pos.x === undefined) pos.x = target;
      else pos.x += (target - pos.x) * 0.2;
    }
  };

  RiskViz.prototype.bindInteraction = function () {
    var self = this;

    function setFromClientY(clientY) {
      var rect = self.canvas.getBoundingClientRect();
      self.mark = self.yToPrice(clientY - rect.top);
      self.manualUntil = self.now() + 1500;
      self.evaluate();
      self.syncSlider();
      self.updateMeta();
      self.draw();
    }

    this.canvas.addEventListener("pointerdown", function (e) {
      self.dragging = true;
      self.canvas.setPointerCapture(e.pointerId);
      self.canvas.classList.add("is-dragging");
      setFromClientY(e.clientY);
      e.preventDefault();
    });

    this.canvas.addEventListener("pointermove", function (e) {
      if (!self.dragging) return;
      setFromClientY(e.clientY);
    });

    function release(e) {
      if (!self.dragging) return;
      self.dragging = false;
      self.canvas.classList.remove("is-dragging");
      self.manualUntil = self.now() + 1500;
      if (e && e.pointerId != null) {
        try {
          self.canvas.releasePointerCapture(e.pointerId);
        } catch (err) {
          /* capture already lost */
        }
      }
    }
    this.canvas.addEventListener("pointerup", release);
    this.canvas.addEventListener("pointercancel", release);

    if (this.slider) {
      this.slider.addEventListener("input", function () {
        self.mark = Number(self.slider.value);
        self.manualUntil = self.now() + 1500;
        self.evaluate();
        self.updateMeta();
        self.draw();
      });
    }
  };

  RiskViz.prototype.now = function () {
    return this.lastTs || (typeof performance !== "undefined" ? performance.now() : 0);
  };

  RiskViz.prototype.syncSlider = function () {
    if (this.slider && document.activeElement !== this.slider) {
      this.slider.value = String(Math.round(this.mark));
    }
  };

  /* Re-price the book against the current mark; fire liquidations. */
  RiskViz.prototype.evaluate = function () {
    var self = this;
    this.positions.forEach(function (pos) {
      if (pos.liquidated) return;
      var st = positionState(pos, self.mark);
      if (st.liquidated) {
        pos.liquidated = true;
        pos.flash = self.now();
        self.liquidations += 1;
        // Residual equity flows to the insurance fund (clamped ≥ 0).
        self.insurance += Math.max(0, st.equity);
      }
    });
  };

  RiskViz.prototype.liveCount = function () {
    var n = 0;
    for (var i = 0; i < this.positions.length; i++) {
      if (!this.positions[i].liquidated) n++;
    }
    return n;
  };

  RiskViz.prototype.autoStep = function (dt) {
    var t = this.now();
    if (t < this.manualUntil || this.dragging) return;

    if (this.liveCount() === 0) {
      if (!this.resetAt) this.resetAt = t + 2400;
      if (t >= this.resetAt) this.resetPositions();
      return;
    }

    var target = AUTO_TARGETS[this.autoIdx % AUTO_TARGETS.length];
    if (Math.abs(this.mark - target) < 220) {
      if (!this.dwellUntil) this.dwellUntil = t + 500;
      if (t >= this.dwellUntil) {
        this.autoIdx += 1;
        this.dwellUntil = 0;
      }
    } else {
      this.dwellUntil = 0;
    }

    var k = 1 - Math.pow(0.92, dt / 16);
    var noise = (Math.random() - 0.5) * dt * 0.7;
    this.mark = clamp(
      this.mark + (target - this.mark) * k * 0.65 + noise,
      this.minP,
      this.maxP
    );
    this.evaluate();
    this.syncSlider();
  };

  RiskViz.prototype.aggregate = function () {
    var live = 0;
    var oi = 0;
    var upnl = 0;
    for (var i = 0; i < this.positions.length; i++) {
      var pos = this.positions[i];
      if (pos.liquidated) continue;
      var st = positionState(pos, this.mark);
      live++;
      oi += st.notional;
      upnl += st.upnl;
    }
    return { live: live, oi: oi, upnl: upnl };
  };

  RiskViz.prototype.updateMeta = function () {
    var agg = this.aggregate();
    if (this.elMarkOut) this.elMarkOut.textContent = fmtUsd(this.mark);
    if (this.elMark) this.elMark.textContent = fmtUsd(this.mark);
    if (this.elOi) this.elOi.textContent = fmtUsd(agg.oi);
    if (this.elUpnl) {
      this.elUpnl.textContent = fmtSigned(agg.upnl);
      this.elUpnl.classList.toggle("is-pos", agg.upnl >= 0);
      this.elUpnl.classList.toggle("is-neg", agg.upnl < 0);
    }
    if (this.elPos) {
      this.elPos.textContent = agg.live + " / " + this.positions.length + " live";
    }
    if (this.elLiq) this.elLiq.textContent = String(this.liquidations);
    if (this.elIns) this.elIns.textContent = fmtUsd(this.insurance);
  };

  RiskViz.prototype.draw = function () {
    var ctx = this.ctx;
    var w = this.width;
    var h = this.height;
    var mono = '"IBM Plex Mono", ui-monospace, monospace';
    var self = this;
    var top = PLOT_TOP;
    var bottom = this.plotBottom();

    ctx.clearRect(0, 0, w, h);

    /* Price axis (left gutter) */
    ctx.textBaseline = "middle";
    ctx.font = "400 8px " + mono;
    var ticks = 5;
    for (var g = 0; g <= ticks; g++) {
      var price = self.minP + ((self.maxP - self.minP) * g) / ticks;
      var y = self.priceToY(price);
      ctx.strokeStyle = "#141414";
      ctx.beginPath();
      ctx.moveTo(GUTTER, y);
      ctx.lineTo(w - 12, y);
      ctx.stroke();
      ctx.fillStyle = "#5c5c5c";
      ctx.textAlign = "right";
      ctx.fillText(Math.round(price / 1000) + "k", GUTTER - 6, y);
    }

    /* Sort columns by live liquidation risk, then draw them */
    this.layoutColumns(this.snapNext);
    this.snapNext = false;

    this.positions.forEach(function (pos, i) {
      var x = pos.x;
      var colHalf = Math.min(34, (w - GUTTER - 20) / self.positions.length / 2 - 4);
      var st = positionState(pos, self.mark);
      var entryY = self.priceToY(pos.entry);
      var liqY = self.priceToY(clamp(pos.liq, self.minP, self.maxP));
      var markY = self.priceToY(self.mark);
      var flashing = pos.flash && self.now() - pos.flash < 550;
      var dead = pos.liquidated;

      // Column guide
      ctx.strokeStyle = dead ? "#161616" : "#1c1c1c";
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x, bottom);
      ctx.stroke();

      // Danger zone: losing side of the liq line
      if (pos.liq >= self.minP && pos.liq <= self.maxP) {
        var zTop = pos.side === "long" ? liqY : top;
        var zBot = pos.side === "long" ? bottom : liqY;
        ctx.fillStyle = dead
          ? "rgba(120,90,90,0.05)"
          : flashing
            ? "rgba(181,106,106,0.24)"
            : "rgba(181,106,106,0.09)";
        ctx.fillRect(x - colHalf, zTop, colHalf * 2, zBot - zTop);

        // Liquidation level
        ctx.setLineDash([3, 3]);
        ctx.strokeStyle = dead ? "#5a4646" : "#b56a6a";
        ctx.beginPath();
        ctx.moveTo(x - colHalf, liqY);
        ctx.lineTo(x + colHalf, liqY);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // PnL connector: entry → mark, colored by sign
      if (!dead) {
        var profit = st.upnl >= 0;
        ctx.strokeStyle = profit ? "#6b9b7a" : "#b56a6a";
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.moveTo(x, entryY);
        ctx.lineTo(x, markY);
        ctx.stroke();
        ctx.lineWidth = 1;
      }

      // Entry marker
      ctx.strokeStyle = dead ? "#3a3a3a" : "#8a8a8a";
      ctx.beginPath();
      ctx.moveTo(x - 5, entryY);
      ctx.lineTo(x + 5, entryY);
      ctx.stroke();

      // Position dot at the mark
      if (!dead) {
        ctx.fillStyle = st.upnl >= 0 ? "#a9d0b6" : "#e0a3a3";
        ctx.beginPath();
        ctx.arc(x, markY, 3, 0, Math.PI * 2);
        ctx.fill();
      }

      // Badge: side + leverage
      ctx.textAlign = "center";
      ctx.textBaseline = "alphabetic";
      ctx.font = "500 8px " + mono;
      ctx.fillStyle = dead ? "#666" : pos.side === "long" ? "#8fbf9f" : "#d18e8e";
      ctx.fillText(
        (pos.side === "long" ? "LONG" : "SHORT") + " " + pos.leverage + "×",
        x,
        top - 8
      );

      // Bottom label: margin % or LIQUIDATED
      ctx.font = "400 8px " + mono;
      if (dead) {
        ctx.fillStyle = flashing ? "#e0a3a3" : "#7a6060";
        ctx.fillText("LIQ", x, h - 8);
      } else {
        // % to liquidation — the value the columns are sorted by.
        var distPct = self.distanceFrac(pos) * 100;
        ctx.fillStyle = distPct < 4 ? "#e0a3a3" : "#8a8a8a";
        ctx.fillText(distPct.toFixed(1) + "%", x, h - 8);
      }
    });

    /* Shared mark price line + tag */
    var my = this.priceToY(this.mark);
    ctx.strokeStyle = "#f2f2f2";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(GUTTER, my);
    ctx.lineTo(w - 12, my);
    ctx.stroke();
    ctx.lineWidth = 1;

    var tag = fmtUsd(this.mark);
    ctx.font = "500 9px " + mono;
    var tw = ctx.measureText(tag).width + 12;
    var tagX = w - 12 - tw;
    ctx.fillStyle = "#f2f2f2";
    ctx.fillRect(tagX, my - 8, tw, 16);
    ctx.fillStyle = "#000";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(tag, tagX + tw / 2, my + 0.5);

    // Grab handle on the axis
    ctx.fillStyle = "#f2f2f2";
    ctx.beginPath();
    ctx.arc(GUTTER, my, 3, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "#5c5c5c";
    ctx.font = "400 8px " + mono;
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.fillText("mark", GUTTER + 6, my - 6);
  };

  RiskViz.prototype.step = function (ts) {
    if (!this.running) return;
    if (!this.lastTs) this.lastTs = ts;
    var dt = Math.min(48, ts - this.lastTs);
    this.lastTs = ts;
    this.frame++;

    this.autoStep(dt);
    if (this.frame % 3 === 0) this.updateMeta();
    this.draw();

    this._boundStep = this._boundStep || this.step.bind(this);
    this.raf = requestAnimationFrame(this._boundStep);
  };

  RiskViz.prototype.start = function () {
    this.resize();
    this.evaluate();
    this.updateMeta();
    this.draw();
    this.started = true;

    if (this.prefersReducedMotion || document.hidden) return;

    this.running = true;
    this.lastTs = 0;
    this._boundStep = this._boundStep || this.step.bind(this);
    this.raf = requestAnimationFrame(this._boundStep);
  };

  RiskViz.prototype.destroy = function () {
    this.running = false;
    this.started = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    document.removeEventListener("visibilitychange", this._onVisibility);
  };

  if (typeof document !== "undefined") {
    var root = document.getElementById("risk-viz");
    if (root) {
      var viz = new RiskViz(root);
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
    module.exports = {
      MMR: MMR,
      liqPrice: liqPrice,
      positionState: positionState,
      SCENARIO: SCENARIO,
    };
  }
})();

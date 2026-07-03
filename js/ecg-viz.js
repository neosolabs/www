/**
 * Lead-II ECG with real-time beat classification.
 *
 * A synthesized cardiac signal (P-QRS-T from summed Gaussians) scrolls past at
 * 25 mm/s while a detector classifies each beat from measured features —
 * prematurity (RR interval vs. the running mean) and QRS width. Premature,
 * wide beats are flagged as ventricular ectopics (PVCs) and drawn in red.
 *
 * Same shape as the trading work elsewhere on this page: a real-time stream,
 * deterministic detection, and an annotation you can trust — here the domain
 * just happens to be a heartbeat instead of an order book.
 */
(function () {
  "use strict";

  var FS = 250; // sample rate (Hz)
  var WINDOW = 5; // seconds visible on the strip

  function gaussian(x, mu, sigma, amp) {
    var d = x - mu;
    return amp * Math.exp(-(d * d) / (2 * sigma * sigma));
  }

  // ECG morphology relative to the R peak (dt in seconds), amplitude in mV.
  function beatWave(dt, beat) {
    if (dt < -0.32 || dt > 0.42) return 0;
    if (beat.isV) {
      // PVC: no P wave, wide biphasic QRS, discordant (inverted) T.
      var wf = beat.width / 0.12;
      return (
        gaussian(dt, 0, 0.03 * wf, beat.amp) +
        gaussian(dt, 0.05, 0.05, -0.55) +
        gaussian(dt, 0.22, 0.07, -0.35)
      );
    }
    return (
      gaussian(dt, -0.16, 0.025, 0.12) + // P
      gaussian(dt, -0.03, 0.012, -0.1) + // Q
      gaussian(dt, 0, 0.01, beat.amp) + // R
      gaussian(dt, 0.028, 0.015, -0.24) + // S
      gaussian(dt, 0.17, 0.05, 0.3) // T
    );
  }

  // Feature-based classifier: premature + wide QRS ⇒ ventricular ectopic.
  function classifyBeat(rr, meanRR, width) {
    var premature = rr < meanRR * 0.88;
    var wide = width > 0.095;
    return premature && wide ? "V" : "N";
  }

  function selfTest() {
    var r = beatWave(0, { isV: false, amp: 1, width: 0.07 });
    if (r < 0.8) throw new Error("R peak should dominate a normal beat");
    if (beatWave(-0.16, { isV: false, amp: 1, width: 0.07 }) <= 0) {
      throw new Error("P wave should be positive");
    }
    if (classifyBeat(0.55, 0.85, 0.13) !== "V") {
      throw new Error("premature wide beat must classify as V");
    }
    if (classifyBeat(0.84, 0.85, 0.07) !== "N") {
      throw new Error("normal beat must classify as N");
    }
  }

  selfTest();

  /* ── Visualization ── */

  var COLOR_TRACE = "#7fbf95";
  var COLOR_V = "#e0a3a3";
  var MONO = '"IBM Plex Mono", ui-monospace, monospace';

  function EcgViz(root) {
    this.root = root;
    this.canvas = root.querySelector(".ecg-viz__canvas");
    this.ctx = this.canvas.getContext("2d");
    this.elHr = root.querySelector("[data-ecg-hr]");
    this.elRhythm = root.querySelector("[data-ecg-rhythm]");
    this.elRr = root.querySelector("[data-ecg-rr]");
    this.elAnalysis = root.querySelector("[data-ecg-analysis]");

    this.simTime = 0;
    this.nextSampleT = 0;
    this.samples = [];
    this.sample0Time = 0;
    this.beats = [];
    this.recentRR = [];
    this.lastBeatTime = 0;
    this.normalCount = 0;
    this.vCount = 0;
    this.lastBeatWasV = false;

    this.running = false;
    this.started = false;
    this.raf = null;
    this.lastTs = 0;
    this.frame = 0;
    this.width = 0;
    this.height = 0;

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

  EcgViz.prototype.resize = function () {
    var rect = this.canvas.getBoundingClientRect();
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var w = Math.max(rect.width, 280);
    var h = Math.max(rect.height, 180);
    this.canvas.width = Math.floor(w * dpr);
    this.canvas.height = Math.floor(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.width = w;
    this.height = h;
    this.topPad = 26;
    this.bottomPad = 14;
    this.baselineY = this.topPad + (h - this.topPad - this.bottomPad) * 0.62;
    this.gain = (this.baselineY - this.topPad) / 1.6;
  };

  EcgViz.prototype.meanRR = function () {
    if (!this.recentRR.length) return 0.82;
    var s = 0;
    for (var i = 0; i < this.recentRR.length; i++) s += this.recentRR[i];
    return s / this.recentRR.length;
  };

  EcgViz.prototype.hrBpm = function () {
    return 70 + 6 * Math.sin(this.simTime * 0.16) + 3 * Math.sin(this.simTime * 0.05);
  };

  EcgViz.prototype.scheduleBeats = function (untilT) {
    while (this.lastBeatTime < untilT) {
      var meanRR = 60 / this.hrBpm();
      var isV = false;
      var rr;
      var amp;
      var width;

      if (this.lastBeatWasV) {
        // Compensatory pause after an ectopic, then a normal beat.
        rr = meanRR * (1.18 + Math.random() * 0.12);
        amp = 0.96 + Math.random() * 0.12;
        width = 0.06 + Math.random() * 0.02;
      } else if (Math.random() < 0.1) {
        // Premature ventricular contraction.
        isV = true;
        rr = meanRR * (0.55 + Math.random() * 0.16);
        amp = 1.32 + Math.random() * 0.28;
        width = 0.11 + Math.random() * 0.035;
      } else {
        rr = meanRR * (0.95 + Math.random() * 0.1);
        amp = 0.96 + Math.random() * 0.12;
        width = 0.06 + Math.random() * 0.02;
      }

      var meanEst = this.meanRR();
      var det = classifyBeat(rr, meanEst, width);
      var rTime = this.lastBeatTime + rr;

      this.beats.push({
        rTime: rTime,
        rr: rr,
        amp: amp,
        width: width,
        isV: isV,
        det: det,
        counted: false,
      });

      if (!isV) {
        this.recentRR.push(rr);
        if (this.recentRR.length > 8) this.recentRR.shift();
      }
      this.lastBeatTime = rTime;
      this.lastBeatWasV = isV;
    }
  };

  EcgViz.prototype.value = function (t) {
    var v = 0.03 * Math.sin(t * 0.6) + 0.006 * Math.sin(t * 47.3);
    for (var i = 0; i < this.beats.length; i++) {
      var b = this.beats[i];
      var dt = t - b.rTime;
      if (dt < -0.32) break; // beats are time-ordered
      if (dt > 0.42) continue;
      v += beatWave(dt, b);
    }
    return v;
  };

  EcgViz.prototype.advance = function (dtMs) {
    this.simTime += dtMs / 1000;
    this.scheduleBeats(this.simTime + 0.6);

    while (this.nextSampleT <= this.simTime) {
      this.samples.push(this.value(this.nextSampleT));
      this.nextSampleT += 1 / FS;
    }

    var maxLen = Math.ceil(FS * WINDOW) + 4;
    while (this.samples.length > maxLen) {
      this.samples.shift();
      this.sample0Time += 1 / FS;
    }

    // Count beats as they reach the present; drop those off the left edge.
    for (var i = 0; i < this.beats.length; i++) {
      var b = this.beats[i];
      if (!b.counted && b.rTime <= this.simTime) {
        b.counted = true;
        if (b.det === "V") this.vCount++;
        else this.normalCount++;
      }
    }
    var cutoff = this.simTime - WINDOW - 0.5;
    while (this.beats.length && this.beats[0].rTime < cutoff) this.beats.shift();
  };

  EcgViz.prototype.timeToX = function (t) {
    return ((t - (this.simTime - WINDOW)) / WINDOW) * this.width;
  };

  EcgViz.prototype.yFor = function (v) {
    return this.baselineY - v * this.gain;
  };

  EcgViz.prototype.updateMeta = function () {
    var hr = Math.round(60 / this.meanRR());
    var recentV = false;
    for (var i = this.beats.length - 1, seen = 0; i >= 0 && seen < 8; i--) {
      if (this.beats[i].counted) {
        seen++;
        if (this.beats[i].det === "V") recentV = true;
      }
    }
    if (this.elHr) {
      this.elHr.textContent = hr + " bpm";
      this.elHr.classList.toggle("is-neg", recentV);
      this.elHr.classList.toggle("is-pos", !recentV);
    }
    if (this.elRhythm) {
      this.elRhythm.textContent = recentV ? "Ventricular ectopy" : "Normal sinus";
      this.elRhythm.classList.toggle("is-neg", recentV);
    }
    if (this.elRr) {
      var last = this.beats.length ? this.beats[this.beats.length - 1] : null;
      this.elRr.textContent = last ? Math.round(last.rr * 1000) + " ms" : "—";
    }
    if (this.elAnalysis) {
      this.elAnalysis.textContent =
        this.normalCount +
        " normal · " +
        this.vCount +
        " ventricular (flagged)";
    }
  };

  EcgViz.prototype.drawGrid = function () {
    var ctx = this.ctx;
    var w = this.width;
    var h = this.height;
    var t0 = this.simTime - WINDOW;
    var kStart = Math.floor(t0 / 0.2);
    var kEnd = Math.ceil(this.simTime / 0.2);

    for (var k = kStart; k <= kEnd; k++) {
      var x = this.timeToX(k * 0.2);
      if (x < 0 || x > w) continue;
      var major = k % 5 === 0;
      ctx.strokeStyle = major ? "rgba(255,255,255,0.06)" : "rgba(255,255,255,0.028)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, this.topPad - 6);
      ctx.lineTo(x, h - this.bottomPad + 2);
      ctx.stroke();
    }

    // Baseline + ±1 mV reference.
    ctx.strokeStyle = "rgba(255,255,255,0.05)";
    [0, 1, -1].forEach(function (mv) {
      var y = this.yFor(mv);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }, this);
  };

  EcgViz.prototype.tracePathSegment = function (tA, tB, style, lineWidth) {
    var ctx = this.ctx;
    var n = this.samples.length;
    if (n < 2) return;
    ctx.strokeStyle = style;
    ctx.lineWidth = lineWidth;
    ctx.beginPath();
    var drawing = false;
    for (var i = 0; i < n; i++) {
      var t = this.sample0Time + i / FS;
      if (t < tA || t > tB) {
        drawing = false;
        continue;
      }
      var x = this.timeToX(t);
      var y = this.yFor(this.samples[i]);
      if (!drawing) {
        ctx.moveTo(x, y);
        drawing = true;
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();
  };

  EcgViz.prototype.draw = function () {
    var ctx = this.ctx;
    var w = this.width;
    var h = this.height;
    if (!w) return;

    ctx.clearRect(0, 0, w, h);
    ctx.lineJoin = "round";
    ctx.lineCap = "round";

    this.drawGrid();

    // Full trace in green.
    this.tracePathSegment(-Infinity, Infinity, COLOR_TRACE, 1.6);

    // Overdraw flagged ectopic beats in red.
    for (var i = 0; i < this.beats.length; i++) {
      var b = this.beats[i];
      if (b.det !== "V") continue;
      this.tracePathSegment(b.rTime - 0.12, b.rTime + 0.32, COLOR_V, 1.8);
    }

    // Live cursor at the leading (right) edge.
    if (this.samples.length) {
      var lastV = this.samples[this.samples.length - 1];
      var cx = this.timeToX(this.sample0Time + (this.samples.length - 1) / FS);
      var cy = this.yFor(lastV);
      ctx.fillStyle = "#eafff0";
      ctx.beginPath();
      ctx.arc(cx, cy, 2.4, 0, Math.PI * 2);
      ctx.fill();
    }

    // Beat annotations.
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    for (var j = 0; j < this.beats.length; j++) {
      var beat = this.beats[j];
      var bx = this.timeToX(beat.rTime);
      if (bx < 8 || bx > w - 8) continue;
      var isV = beat.det === "V";
      ctx.strokeStyle = isV ? COLOR_V : "rgba(180,184,192,0.4)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(bx, this.topPad - 4);
      ctx.lineTo(bx, this.topPad - 12);
      ctx.stroke();
      ctx.fillStyle = isV ? COLOR_V : "#8f939b";
      ctx.font = (isV ? "500 " : "400 ") + "9px " + MONO;
      ctx.fillText(beat.det, bx, this.topPad - 15);
    }

    // Authenticity marks.
    ctx.fillStyle = "#6a6e76";
    ctx.font = "400 8px " + MONO;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText("II", 4, h - this.bottomPad + 2);
    ctx.textAlign = "right";
    ctx.fillText("25 mm/s · 250 Hz", w - 4, h - this.bottomPad + 2);
  };

  EcgViz.prototype.step = function (ts) {
    if (!this.running) return;
    if (!this.lastTs) this.lastTs = ts;
    var dt = Math.min(50, ts - this.lastTs);
    this.lastTs = ts;
    this.frame++;

    this.advance(dt);
    if (this.frame % 6 === 0) this.updateMeta();
    this.draw();

    this._boundStep = this._boundStep || this.step.bind(this);
    this.raf = requestAnimationFrame(this._boundStep);
  };

  EcgViz.prototype.start = function () {
    this.resize();
    // Pre-fill a full window so the strip is never blank on first paint.
    this.advance(WINDOW * 1000);
    this.updateMeta();
    this.draw();
    this.started = true;

    if (this.prefersReducedMotion || document.hidden) return;

    this.running = true;
    this.lastTs = 0;
    this._boundStep = this._boundStep || this.step.bind(this);
    this.raf = requestAnimationFrame(this._boundStep);
  };

  EcgViz.prototype.destroy = function () {
    this.running = false;
    this.started = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    document.removeEventListener("visibilitychange", this._onVisibility);
  };

  if (typeof document !== "undefined") {
    var root = document.getElementById("ecg-viz");
    if (root) {
      var viz = new EcgViz(root);
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
      gaussian: gaussian,
      beatWave: beatWave,
      classifyBeat: classifyBeat,
    };
  }
})();

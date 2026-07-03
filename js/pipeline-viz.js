/**
 * SDLC pipeline — build → test → sign → publish → parallel regional rollout.
 */
(function () {
  "use strict";

  var STAGES = [
    {
      id: "build",
      label: "build",
      detail: "matching-engine v2.4.1",
      ms: 1400,
    },
    {
      id: "test",
      label: "test",
      detail: "integration · 1,216 tests",
      ms: 1900,
    },
    {
      id: "sign",
      label: "sign",
      detail: "cosign · SLSA provenance",
      ms: 650,
    },
    {
      id: "publish",
      label: "publish",
      detail: "OCI image \u00b7 ghcr.io",
      ms: 900,
    },
  ];

  var REGIONS = [
    { id: "eu-west-1", label: "eu-west-1" },
    { id: "us-east-1", label: "us-east-1" },
    { id: "ap-southeast-1", label: "ap-southeast-1" },
  ];

  // Progressive rollout: regions go live one after another (canary first),
  // with slight overlap — not all at once. Windows are fractions of the
  // rollout segment [0,1]; one entry per region, in order.
  var REGION_ROLLOUT = [
    { s: 0.0, e: 0.5 },
    { s: 0.28, e: 0.76 },
    { s: 0.54, e: 1.0 },
  ];

  var ARTIFACT = "matching-engine v2.4.1";

  var REGION_BOX_W = 96;
  var REGION_BOX_H = 52;
  var REGION_PAD_X = 10;
  var REGION_PAD_Y = 9;

  var TRACK_PAD_X = 26;
  var TRACK_PAD_TOP = 32;
  var TRACK_PAD_BOTTOM = 36;
  var TRACK_LABEL_INSET = 12;
  var STAGE_LABEL_OFFSET = 12;
  var STAGE_DETAIL_BELOW_BOX = 10;

  var SEGMENTS = STAGES.map(function (_, i) {
    return { kind: "stage", index: i, ms: STAGES[i].ms };
  }).concat(
    { kind: "rollout", ms: 2600 },
    { kind: "hold", ms: 2800 }
  );

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function easeOut(t) {
    return 1 - Math.pow(1 - t, 2.5);
  }

  function PipelineViz(root) {
    this.root = root;
    this.canvas = root.querySelector(".pipeline-viz__canvas");
    this.ctx = this.canvas.getContext("2d");
    this.elStage = root.querySelector("[data-pipe-stage]");
    this.elArtifact = root.querySelector("[data-pipe-artifact]");
    this.elRegions = root.querySelector("[data-pipe-regions]");
    this.elStatus = root.querySelector("[data-pipe-status]");

    this.segmentIndex = 0;
    this.segmentElapsed = 0;
    this.stageActive = -1;
    this.stageComplete = -1;
    this.stageProgress = 0;
    this.regionProgress = REGIONS.map(function () {
      return 0;
    });
    this.running = false;
    this.raf = null;
    this.lastTs = 0;
    this.layout = null;

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
  }

  PipelineViz.prototype.resize = function () {
    var rect = this.canvas.getBoundingClientRect();
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var w = Math.max(rect.width, 300);
    var h = Math.max(rect.height, 240);
    this.canvas.width = Math.floor(w * dpr);
    this.canvas.height = Math.floor(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.width = w;
    this.height = h;
    this.computeLayout();
  };

  PipelineViz.prototype.computeLayout = function () {
    var w = this.width;
    var h = this.height;
    var trackW = Math.min(w * 0.82, 520);
    var trackLeft = (w - trackW) / 2;
    var stageY = h * 0.24;
    var hubY = h * 0.5;
    var regionY = h * 0.72;
    var count = STAGES.length;
    var step = trackW / (count - 1);

    var stages = STAGES.map(function (s, i) {
      return {
        id: s.id,
        label: s.label,
        detail: s.detail,
        x: trackLeft + step * i,
        y: stageY,
      };
    });

    var publish = stages[stages.length - 1];
    var hub = { x: publish.x, y: hubY };

    var regionSpan = Math.min(w * 0.78, 360);
    var regionStep = regionSpan / (REGIONS.length - 1);
    var regionStart = w / 2 - regionSpan / 2;

    var regions = REGIONS.map(function (r, i) {
      return {
        id: r.id,
        label: r.label,
        x: regionStart + regionStep * i,
        y: regionY,
      };
    });

    this.layout = {
      trackLeft: trackLeft,
      trackW: trackW,
      stageY: stageY,
      stages: stages,
      hub: hub,
      regions: regions,
      publishDrop: stageY + TRACK_PAD_BOTTOM + STAGE_DETAIL_BELOW_BOX + 12,
    };
  };

  PipelineViz.prototype.reset = function () {
    this.segmentIndex = 0;
    this.segmentElapsed = 0;
    this.stageActive = -1;
    this.stageComplete = -1;
    this.stageProgress = 0;
    this.regionProgress = REGIONS.map(function () {
      return 0;
    });
  };

  PipelineViz.prototype.applySegment = function (seg, t) {
    if (seg.kind === "stage") {
      this.stageComplete = seg.index - 1;
      this.stageActive = seg.index;
      this.stageProgress = easeOut(t);
      this.regionProgress = REGIONS.map(function () {
        return 0;
      });
    } else if (seg.kind === "rollout") {
      this.stageComplete = STAGES.length - 1;
      this.stageActive = STAGES.length - 1;
      this.stageProgress = 1;
      // Canary → progressive: each region ramps within its own window.
      this.regionProgress = REGION_ROLLOUT.map(function (win) {
        var p = (t - win.s) / (win.e - win.s);
        return easeOut(p < 0 ? 0 : p > 1 ? 1 : p);
      });
    } else if (seg.kind === "hold") {
      this.stageComplete = STAGES.length - 1;
      this.stageActive = STAGES.length - 1;
      this.stageProgress = 1;
      this.regionProgress = REGIONS.map(function () {
        return 1;
      });
    }
  };

  PipelineViz.prototype.updateMeta = function () {
    var stageLabel = "\u2014";
    var status = "idle";
    var seg = SEGMENTS[this.segmentIndex];

    if (this.stageActive >= 0 && this.stageActive < STAGES.length) {
      if (seg && seg.kind === "stage") {
        stageLabel = STAGES[this.stageActive].label;
        status = STAGES[this.stageActive].detail;
      } else if (seg && seg.kind === "rollout") {
        stageLabel = "deploy \u2192 regions";
        status = "progressive rollout \u00b7 canary first";
      } else if (seg && seg.kind === "hold") {
        stageLabel = "complete";
        status = "all regions healthy";
      }
    }

    var live = this.regionProgress.filter(function (p) {
      return p >= 1;
    }).length;

    if (this.elStage) this.elStage.textContent = stageLabel;
    if (this.elArtifact) this.elArtifact.textContent = ARTIFACT;
    if (this.elRegions) {
      this.elRegions.textContent = live + " / " + REGIONS.length + " live";
    }
    if (this.elStatus) this.elStatus.textContent = status;
  };

  PipelineViz.prototype.drawTrack = function (ctx, layout) {
    var mono = '"IBM Plex Mono", ui-monospace, monospace';
    var y = layout.stageY;
    var left = layout.stages[0].x;
    var right = layout.stages[layout.stages.length - 1].x;

    ctx.fillStyle = "#050505";
    ctx.strokeStyle = "#1f1f1f";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(
      left - TRACK_PAD_X,
      y - TRACK_PAD_TOP,
      right - left + TRACK_PAD_X * 2,
      TRACK_PAD_TOP + TRACK_PAD_BOTTOM,
      3
    );
    ctx.fill();
    ctx.stroke();

    ctx.font = '400 7px ' + mono;
    ctx.fillStyle = "#8a8a8a";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText(
      "pipeline",
      left - TRACK_PAD_X + TRACK_LABEL_INSET,
      y - TRACK_PAD_TOP + TRACK_LABEL_INSET
    );

    ctx.strokeStyle = "#1a1a1a";
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(right, y);
    ctx.stroke();

    for (var i = 0; i < layout.stages.length - 1; i++) {
      var a = layout.stages[i];
      var b = layout.stages[i + 1];
      var isDone =
        this.stageActive > i + 1 ||
        (this.stageActive === i + 1 && this.stageProgress >= 1);
      var isFilling =
        this.stageActive === i + 1 && this.stageProgress > 0 && this.stageProgress < 1;

      ctx.beginPath();
      ctx.moveTo(a.x, y);
      ctx.lineTo(b.x, y);
      ctx.strokeStyle = isDone ? "#4a4a4a" : "#1a1a1a";
      ctx.lineWidth = isDone ? 1.5 : 1;
      ctx.stroke();
      ctx.lineWidth = 1;

      if (isFilling || (this.stageActive === i + 1 && this.stageProgress > 0 && !isDone)) {
        var px = lerp(a.x, b.x, this.stageProgress);
        ctx.strokeStyle = "#8a8a8a";
        ctx.beginPath();
        ctx.moveTo(a.x, y);
        ctx.lineTo(px, y);
        ctx.stroke();

        ctx.fillStyle = "#f2f2f2";
        ctx.beginPath();
        ctx.arc(px, y, 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  };

  PipelineViz.prototype.drawStages = function (ctx, layout) {
    var mono = '"IBM Plex Mono", ui-monospace, monospace';
    var self = this;

    layout.stages.forEach(function (node, i) {
      var complete = i <= self.stageComplete;
      var active = i === self.stageActive;
      var r = 4;

      if (active) {
        ctx.strokeStyle = "#3a3a3a";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(node.x, node.y, 9, 0, Math.PI * 2);
        ctx.stroke();

        ctx.strokeStyle = "#f2f2f2";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(
          node.x,
          node.y,
          9,
          -Math.PI / 2,
          -Math.PI / 2 + Math.PI * 2 * self.stageProgress
        );
        ctx.stroke();
        ctx.lineWidth = 1;
      }

      ctx.fillStyle = complete ? "#141414" : active ? "#1a1a1a" : "#0a0a0a";
      ctx.strokeStyle = active ? "#f2f2f2" : complete ? "#6a6a6a" : "#2a2a2a";
      ctx.lineWidth = active ? 1.5 : 1;
      ctx.beginPath();
      ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      if (complete && !active) {
        ctx.fillStyle = "#8a8a8a";
        ctx.font = '600 6px ' + mono;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("\u2713", node.x, node.y + 0.5);
      }

      ctx.fillStyle = active ? "#f2f2f2" : complete ? "#a8a8a8" : "#787878";
      ctx.font = (active ? "500" : "400") + ' 9px ' + mono;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillText(node.label, node.x, node.y + STAGE_LABEL_OFFSET);

      if (active) {
        ctx.fillStyle = "#8a8a8a";
        ctx.font = '400 7px ' + mono;
        ctx.textBaseline = "top";
        ctx.fillText(
          node.detail,
          node.x,
          node.y + TRACK_PAD_BOTTOM + STAGE_DETAIL_BELOW_BOX
        );
      }
    });
  };

  PipelineViz.prototype.draw = function () {
    if (!this.layout) return;

    var ctx = this.ctx;
    var w = this.width;
    var h = this.height;
    var layout = this.layout;
    var mono = '"IBM Plex Mono", ui-monospace, monospace';

    ctx.clearRect(0, 0, w, h);

    this.drawTrack(ctx, layout);
    this.drawStages(ctx, layout);

    var pub = layout.stages[layout.stages.length - 1];
    var hub = layout.hub;
    var deployActive =
      this.stageActive >= STAGES.length - 1 ||
      this.stageComplete >= STAGES.length - 1;

    var publishDrop = layout.publishDrop;

    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(pub.x, publishDrop);
    ctx.lineTo(hub.x, hub.y - 6);
    ctx.strokeStyle = deployActive ? "#4a4a4a" : "#1f1f1f";
    ctx.lineWidth = deployActive ? 1.5 : 1;
    ctx.stroke();
    ctx.lineWidth = 1;

    if (deployActive && SEGMENTS[this.segmentIndex].kind === "rollout") {
      var rt = easeOut(Math.min(1, this.segmentElapsed / SEGMENTS[this.segmentIndex].ms));
      var hy = lerp(publishDrop, hub.y - 6, rt);
      ctx.fillStyle = "#f2f2f2";
      ctx.beginPath();
      ctx.arc(pub.x, hy, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }

    layout.regions.forEach(function (reg, ri) {
      var prog = this.regionProgress[ri];
      var top = reg.y - REGION_BOX_H / 2 - 2;
      ctx.beginPath();
      ctx.moveTo(hub.x, hub.y + 6);
      ctx.lineTo(reg.x, top);
      ctx.strokeStyle =
        prog > 0 ? "#4a4a4a" : deployActive ? "#2a2a2a" : "#1f1f1f";
      ctx.stroke();

      if (prog > 0 && prog < 1) {
        var tx = lerp(hub.x, reg.x, prog);
        var ty = lerp(hub.y + 6, top, prog);
        ctx.fillStyle = "#f2f2f2";
        ctx.beginPath();
        ctx.arc(tx, ty, 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }, this);

    ctx.fillStyle = deployActive ? "#141414" : "#0a0a0a";
    ctx.strokeStyle = deployActive ? "#787878" : "#1f1f1f";
    ctx.beginPath();
    ctx.arc(hub.x, hub.y, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    layout.regions.forEach(function (reg, ri) {
      var prog = this.regionProgress[ri];
      var rw = REGION_BOX_W;
      var rh = REGION_BOX_H;
      var padX = REGION_PAD_X;
      var padY = REGION_PAD_Y;
      var healthy = prog >= 1;
      var bx = reg.x - rw / 2;
      var by = reg.y - rh / 2;

      ctx.fillStyle = healthy ? "#0f0f0f" : "#050505";
      ctx.strokeStyle = healthy
        ? "#6b9b7a"
        : prog > 0
          ? "#8a8a8a"
          : "#1f1f1f";
      ctx.lineWidth = prog > 0 && !healthy ? 1.5 : 1;
      ctx.fillRect(bx, by, rw, rh);
      ctx.strokeRect(bx + 0.5, by + 0.5, rw - 1, rh - 1);

      ctx.fillStyle = healthy ? "#f2f2f2" : "#b0b0b0";
      ctx.font = '400 9px ' + mono;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillText(reg.label, reg.x, by + padY);

      var barW = rw - padX * 2;
      var barH = 3;
      var barX = reg.x - barW / 2;
      var barY = by + padY + 14;
      ctx.fillStyle = "#1a1a1a";
      ctx.fillRect(barX, barY, barW, barH);
      if (prog > 0) {
        ctx.fillStyle = healthy ? "#6b9b7a" : "#8a8a8a";
        ctx.fillRect(barX, barY, barW * prog, barH);
      }

      ctx.fillStyle = "#8a8a8a";
      ctx.font = '400 7px ' + mono;
      ctx.textBaseline = "bottom";
      var statusText = healthy ? "healthy" : prog > 0 ? "deploying" : "pending";
      ctx.fillText(statusText, reg.x, by + rh - padY);
    }, this);

    ctx.fillStyle = "#8a8a8a";
    ctx.font = '400 9px ' + mono;
    ctx.textAlign = "center";
    ctx.fillText("multi-region rollout", w / 2, h - 10);
  };

  PipelineViz.prototype.tick = function (ts) {
    if (!this.running) return;

    if (!this.lastTs) this.lastTs = ts;
    var dt = ts - this.lastTs;
    this.lastTs = ts;

    var seg = SEGMENTS[this.segmentIndex];
    if (!seg) {
      this.reset();
      seg = SEGMENTS[0];
    }

    this.segmentElapsed += dt;
    var t = Math.min(1, this.segmentElapsed / seg.ms);
    this.applySegment(seg, t);
    this.updateMeta();
    this.draw();

    if (this.segmentElapsed >= seg.ms) {
      this.segmentIndex = (this.segmentIndex + 1) % SEGMENTS.length;
      this.segmentElapsed = 0;
      if (this.segmentIndex === 0) this.reset();
    }

    this.raf = requestAnimationFrame(this._boundTick);
  };

  PipelineViz.prototype.start = function () {
    this.resize();
    this.reset();

    if (this.prefersReducedMotion) {
      this.segmentIndex = SEGMENTS.length - 1;
      this.applySegment({ kind: "hold" }, 1);
      this.updateMeta();
      this.draw();
      return;
    }

    this.running = true;
    this.lastTs = 0;
    this._boundTick = this._boundTick || this.tick.bind(this);
    this.raf = requestAnimationFrame(this._boundTick);
  };

  PipelineViz.prototype.destroy = function () {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
  };

  var root = document.getElementById("pipeline-viz");
  if (root) {
    var viz = new PipelineViz(root);

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
        { threshold: 0.2 }
      );
      obs.observe(root);
    } else {
      viz.start();
    }
  }
})();

/**
 * Limit order book with price–time priority matching.
 * Same semantics as production equity/crypto matchers: FIFO per level,
 * partial fills, resting remainder on book.
 *
 * Prices stored as integer ticks (1 tick = 0.01) to avoid float drift.
 */
(function () {
  "use strict";

  var TICK = 0.01;

  function ticksToPrice(ticks) {
    return (ticks * TICK).toFixed(2);
  }

  function OrderBook() {
    this.bids = Object.create(null);
    this.asks = Object.create(null);
    this.orderSeq = 0;
    this.lastEvent = null;
    this.tradeCount = 0;
    this.volume = 0;
  }

  OrderBook.prototype._nextId = function () {
    this.orderSeq += 1;
    return this.orderSeq;
  };

  OrderBook.prototype._bestBid = function () {
    var best = null;
    for (var p in this.bids) {
      var price = Number(p);
      if (this.bids[p].length && (best === null || price > best)) best = price;
    }
    return best;
  };

  OrderBook.prototype._bestAsk = function () {
    var best = null;
    for (var p in this.asks) {
      var price = Number(p);
      if (this.asks[p].length && (best === null || price < best)) best = price;
    }
    return best;
  };

  OrderBook.prototype._pushLevel = function (book, price, order) {
    if (!book[price]) book[price] = [];
    book[price].push(order);
  };

  OrderBook.prototype.submit = function (side, priceTicks, qty, kind) {
    var id = this._nextId();
    var ts = this.orderSeq;
    var fills = [];

    if (side === "buy") {
      fills = this._matchBuy(id, priceTicks, qty, kind, ts);
    } else {
      fills = this._matchSell(id, priceTicks, qty, kind, ts);
    }

    return { id: id, fills: fills };
  };

  OrderBook.prototype._recordFill = function (fills, price, qty, makerId, takerSide) {
    fills.push({ price: price, qty: qty, makerId: makerId });
    this.volume += qty;
    this.tradeCount += 1;
    this.lastEvent = {
      type: "match",
      takerSide: takerSide,
      price: price,
      qty: qty,
      makerId: makerId,
    };
  };

  OrderBook.prototype._matchBuy = function (takerId, limitTicks, qty, kind, ts) {
    var remaining = qty;
    var fills = [];

    while (remaining > 0) {
      var askPrice = this._bestAsk();
      if (askPrice === null) break;
      if (kind === "limit" && askPrice > limitTicks) break;

      var level = this.asks[askPrice];
      var maker = level[0];
      var fillQty = Math.min(remaining, maker.qty);

      maker.qty -= fillQty;
      if (maker.qty === 0) level.shift();
      if (!level.length) delete this.asks[askPrice];

      remaining -= fillQty;
      this._recordFill(fills, askPrice, fillQty, maker.id, "buy");
    }

    if (remaining > 0 && kind === "limit") {
      this._pushLevel(this.bids, limitTicks, {
        id: takerId,
        qty: remaining,
        ts: ts,
      });
      this.lastEvent = {
        type: "rest",
        side: "bid",
        price: limitTicks,
        qty: remaining,
        id: takerId,
      };
    } else if (!fills.length) {
      this.lastEvent = {
        type: "reject",
        side: "buy",
        reason: kind === "market" ? "book empty" : "no liquidity",
      };
    } else if (remaining === 0) {
      this.lastEvent = {
        type: "filled",
        takerSide: "buy",
        totalQty: qty,
      };
    } else if (kind === "market") {
      this.lastEvent = {
        type: "partial",
        side: "buy",
        filled: qty - remaining,
        remaining: remaining,
      };
    }

    return fills;
  };

  OrderBook.prototype._matchSell = function (takerId, limitTicks, qty, kind, ts) {
    var remaining = qty;
    var fills = [];

    while (remaining > 0) {
      var bidPrice = this._bestBid();
      if (bidPrice === null) break;
      if (kind === "limit" && bidPrice < limitTicks) break;

      var level = this.bids[bidPrice];
      var maker = level[0];
      var fillQty = Math.min(remaining, maker.qty);

      maker.qty -= fillQty;
      if (maker.qty === 0) level.shift();
      if (!level.length) delete this.bids[bidPrice];

      remaining -= fillQty;
      this._recordFill(fills, bidPrice, fillQty, maker.id, "sell");
    }

    if (remaining > 0 && kind === "limit") {
      this._pushLevel(this.asks, limitTicks, {
        id: takerId,
        qty: remaining,
        ts: ts,
      });
      this.lastEvent = {
        type: "rest",
        side: "ask",
        price: limitTicks,
        qty: remaining,
        id: takerId,
      };
    } else if (!fills.length) {
      this.lastEvent = {
        type: "reject",
        side: "sell",
        reason: kind === "market" ? "book empty" : "no liquidity",
      };
    } else if (remaining === 0) {
      this.lastEvent = {
        type: "filled",
        takerSide: "sell",
        totalQty: qty,
      };
    } else if (kind === "market") {
      this.lastEvent = {
        type: "partial",
        side: "sell",
        filled: qty - remaining,
        remaining: remaining,
      };
    }

    return fills;
  };

  OrderBook.prototype.cancel = function (side, priceTicks, orderId) {
    var book = side === "bid" ? this.bids : this.asks;
    var level = book[priceTicks];
    if (!level) return false;

    for (var i = 0; i < level.length; i++) {
      if (level[i].id === orderId) {
        var removed = level.splice(i, 1)[0];
        if (!level.length) delete book[priceTicks];
        this.lastEvent = {
          type: "cancel",
          side: side,
          price: priceTicks,
          qty: removed.qty,
          id: orderId,
        };
        return true;
      }
    }
    return false;
  };

  OrderBook.prototype.depth = function (maxLevels) {
    var bidPrices = Object.keys(this.bids)
      .map(Number)
      .filter(function (p) {
        return this.bids[p].length;
      }, this)
      .sort(function (a, b) {
        return b - a;
      })
      .slice(0, maxLevels);

    var askPrices = Object.keys(this.asks)
      .map(Number)
      .filter(function (p) {
        return this.asks[p].length;
      }, this)
      .sort(function (a, b) {
        return a - b;
      })
      .slice(0, maxLevels);

    var self = this;

    function sumLevel(book, price) {
      return book[price].reduce(function (n, o) {
        return n + o.qty;
      }, 0);
    }

    return {
      bids: bidPrices.map(function (p) {
        return { price: p, qty: sumLevel(self.bids, p) };
      }),
      asks: askPrices.map(function (p) {
        return { price: p, qty: sumLevel(self.asks, p) };
      }),
      bestBid: this._bestBid(),
      bestAsk: this._bestAsk(),
    };
  };

  OrderBook.prototype.assertUncrossed = function () {
    var bb = this._bestBid();
    var ba = this._bestAsk();
    if (bb !== null && ba !== null && bb >= ba) {
      throw new Error("Crossed book: bid " + bb + " >= ask " + ba);
    }
  };

  /* Scripted session: market-maker seed → aggressive sweep → replenishment */
  var SESSION = [
    { op: "limit", side: "buy", price: 10004, qty: 1200 },
    { op: "limit", side: "buy", price: 10003, qty: 2800 },
    { op: "limit", side: "buy", price: 10002, qty: 1900 },
    { op: "limit", side: "buy", price: 10001, qty: 4200 },
    { op: "limit", side: "sell", price: 10006, qty: 1100 },
    { op: "limit", side: "sell", price: 10007, qty: 2400 },
    { op: "limit", side: "sell", price: 10008, qty: 1650 },
    { op: "limit", side: "sell", price: 10009, qty: 3600 },
    { op: "limit", side: "buy", price: 10009, qty: 3200 },
    { op: "limit", side: "sell", price: 10003, qty: 2100 },
    { op: "limit", side: "buy", price: 10006, qty: 580 },
    { op: "limit", side: "buy", price: 10005, qty: 450 },
    { op: "limit", side: "sell", price: 10004, qty: 720 },
    { op: "limit", side: "buy", price: 10008, qty: 1400 },
    { op: "limit", side: "sell", price: 10002, qty: 950 },
    { op: "limit", side: "buy", price: 10007, qty: 880 },
    { op: "limit", side: "sell", price: 10005, qty: 620 },
    { op: "limit", side: "buy", price: 10010, qty: 2600 },
    { op: "limit", side: "sell", price: 10001, qty: 1800 },
    { op: "limit", side: "buy", price: 10004, qty: 1100 },
    { op: "limit", side: "sell", price: 10009, qty: 2000 },
  ];

  function selfTest() {
    var book = new OrderBook();
    book.submit("sell", 10010, 100, "limit");
    book.submit("buy", 10010, 40, "limit");
    book.assertUncrossed();

    var book2 = new OrderBook();
    book2.submit("sell", 10006, 400, "limit");
    book2.submit("sell", 10007, 900, "limit");
    book2.submit("buy", 10008, 650, "limit");
    if (book2.volume !== 650) throw new Error("Sweep volume mismatch");
    if (book2.asks[10006] || book2.asks[10007][0].qty !== 650) {
      throw new Error("Sweep depth mismatch");
    }
    book2.assertUncrossed();
  }

  function runSessionTest() {
    var book = new OrderBook();
    SESSION.forEach(function (ev, i) {
      book.submit(ev.side === "buy" ? "buy" : "sell", ev.price, ev.qty, ev.op);
      try {
        book.assertUncrossed();
      } catch (err) {
        throw new Error("Session step " + (i + 1) + ": " + err.message);
      }
    });
    return {
      volume: book.volume,
      trades: book.tradeCount,
      spread: book._bestAsk() - book._bestBid(),
    };
  }

  function runSessionCycles(cycleCount) {
    var book = new OrderBook();
    var lastResult = null;

    for (var cycle = 0; cycle < cycleCount; cycle++) {
      if (cycle > 0) {
        book = new OrderBook();
      }
      SESSION.forEach(function (ev, i) {
        book.submit(ev.side === "buy" ? "buy" : "sell", ev.price, ev.qty, ev.op);
        try {
          book.assertUncrossed();
        } catch (err) {
          throw new Error(
            "Cycle " + (cycle + 1) + " step " + (i + 1) + ": " + err.message
          );
        }
      });
      lastResult = {
        volume: book.volume,
        trades: book.tradeCount,
        spread: book._bestAsk() - book._bestBid(),
      };
    }

    return lastResult;
  }

  selfTest();

  /* ── Canvas visualization ── */

  function BookViz(root) {
    this.root = root;
    this.canvas = root.querySelector(".sci-viz__canvas");
    this.ctx = this.canvas.getContext("2d");
    this.elBid = root.querySelector("[data-ob-bid]");
    this.elAsk = root.querySelector("[data-ob-ask]");
    this.elSpread = root.querySelector("[data-ob-spread]");
    this.elEvent = root.querySelector("[data-ob-event]");
    this.elVol = root.querySelector("[data-ob-vol]");
    this.book = new OrderBook();
    this.step = 0;
    this.flash = null;
    this.timer = null;
    this.stepMs = 680;
    this.stepMsMatch = 520;
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

  BookViz.prototype.resize = function () {
    var rect = this.canvas.getBoundingClientRect();
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var w = Math.max(rect.width, 280);
    var h = Math.max(rect.height, 200);
    this.canvas.width = Math.floor(w * dpr);
    this.canvas.height = Math.floor(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.width = w;
    this.height = h;
  };

  BookViz.prototype.formatEvent = function (ev) {
    if (!ev) return "\u2014";
    if (ev.type === "match") {
      return (
        "MATCH " +
        ev.qty +
        " @ " +
        ticksToPrice(ev.price) +
        "  (maker #" +
        ev.makerId +
        ")"
      );
    }
    if (ev.type === "rest") {
      return (
        "REST " +
        (ev.side === "bid" ? "BID" : "ASK") +
        " " +
        ev.qty +
        " @ " +
        ticksToPrice(ev.price)
      );
    }
    if (ev.type === "filled") {
      return "FILLED " + ev.totalQty + " (" + ev.takerSide + ")";
    }
    if (ev.type === "cancel") {
      return "CXL #" + ev.id + " " + ev.qty + " @ " + ticksToPrice(ev.price);
    }
    return ev.type.toUpperCase();
  };

  BookViz.prototype.updateMeta = function () {
    var d = this.book.depth(8);
    var bb = d.bestBid;
    var ba = d.bestAsk;

    if (this.elBid) {
      this.elBid.textContent = bb !== null ? ticksToPrice(bb) : "\u2014";
    }
    if (this.elAsk) {
      this.elAsk.textContent = ba !== null ? ticksToPrice(ba) : "\u2014";
    }
    if (this.elSpread) {
      this.elSpread.textContent =
        bb !== null && ba !== null
          ? ((ba - bb) * TICK).toFixed(2) + " (" + (ba - bb) + " ticks)"
          : "\u2014";
    }
    if (this.elEvent) {
      this.elEvent.textContent = this.formatEvent(this.book.lastEvent);
    }
    if (this.elVol) {
      this.elVol.textContent = String(this.book.volume);
    }
  };

  BookViz.prototype.formatQty = function (qty) {
    return qty >= 1000 ? (qty / 1000).toFixed(1).replace(/\.0$/, "") + "k" : String(qty);
  };

  BookViz.prototype.draw = function () {
    var ctx = this.ctx;
    var w = this.width;
    var h = this.height;
    var d = this.book.depth(5);
    var midX = w / 2;

    ctx.clearRect(0, 0, w, h);

    var allPrices = [];
    d.bids.forEach(function (l) {
      allPrices.push(l.price);
    });
    d.asks.forEach(function (l) {
      allPrices.push(l.price);
    });

    if (!allPrices.length) {
      ctx.fillStyle = "#8a8a8a";
      ctx.font = '400 11px "IBM Plex Mono", ui-monospace, monospace';
      ctx.textAlign = "center";
      ctx.fillText("awaiting liquidity", midX, h / 2);
      return;
    }

    var maxQty = 1;
    d.bids.forEach(function (l) {
      maxQty = Math.max(maxQty, l.qty);
    });
    d.asks.forEach(function (l) {
      maxQty = Math.max(maxQty, l.qty);
    });

    var rowCount = Math.max(d.bids.length, d.asks.length, 4);
    var rowH = Math.min(26, (h - 48) / rowCount);
    var topY = 30;

    var priceColW = 46;
    var qtyColW = 34;
    var barMax = midX - priceColW - qtyColW - 10;

    var priceFont = '400 10px "IBM Plex Mono", ui-monospace, monospace';
    var qtyFont = '500 9px "IBM Plex Mono", ui-monospace, monospace';

    ctx.strokeStyle = "#1f1f1f";
    ctx.beginPath();
    ctx.moveTo(midX, 18);
    ctx.lineTo(midX, h - 22);
    ctx.stroke();

    ctx.fillStyle = "#5c5c5c";
    ctx.font = '400 9px "IBM Plex Mono", ui-monospace, monospace';
    ctx.textAlign = "center";
    ctx.fillText("depth", midX, 12);

    function drawSide(levels, side) {
      levels.forEach(function (level, i) {
        var y = topY + i * rowH;
        var barH = rowH - 4;
        var barW = Math.max(2, (level.qty / maxQty) * barMax);
        var qtyLabel = this.formatQty(level.qty);
        var isFlash =
          this.flash &&
          this.flash.price === level.price &&
          Date.now() - this.flash.at < 400;

        if (side === "bid") {
          var barX = midX - qtyColW - barW;
          ctx.fillStyle = isFlash ? "#3a3a3a" : "#0a0a0a";
          ctx.fillRect(barX, y, barW, barH);
          ctx.strokeStyle = isFlash ? "#8a8a8a" : "#2a2a2a";
          ctx.strokeRect(barX + 0.5, y + 0.5, barW - 1, barH - 1);

          ctx.fillStyle = isFlash ? "#f2f2f2" : "#b0b0b0";
          ctx.font = priceFont;
          ctx.textAlign = "left";
          ctx.textBaseline = "middle";
          ctx.fillText(ticksToPrice(level.price), 8, y + barH / 2);

          ctx.fillStyle = isFlash ? "#d8d8d8" : "#909090";
          ctx.font = qtyFont;
          ctx.textAlign = "right";
          ctx.fillText(qtyLabel, midX - 8, y + barH / 2);
        } else {
          var askBarX = midX + qtyColW;
          ctx.fillStyle = isFlash ? "#3a3a3a" : "#0a0a0a";
          ctx.fillRect(askBarX, y, barW, barH);
          ctx.strokeStyle = isFlash ? "#8a8a8a" : "#2a2a2a";
          ctx.strokeRect(askBarX + 0.5, y + 0.5, barW - 1, barH - 1);

          ctx.fillStyle = isFlash ? "#f2f2f2" : "#b0b0b0";
          ctx.font = priceFont;
          ctx.textAlign = "right";
          ctx.textBaseline = "middle";
          ctx.fillText(ticksToPrice(level.price), w - 8, y + barH / 2);

          ctx.fillStyle = isFlash ? "#d8d8d8" : "#909090";
          ctx.font = qtyFont;
          ctx.textAlign = "left";
          ctx.fillText(qtyLabel, midX + 8, y + barH / 2);
        }
      }, this);
    }

    drawSide.call(this, d.bids, "bid");
    drawSide.call(this, d.asks, "ask");

    if (d.bestBid !== null && d.bestAsk !== null) {
      var spreadMid = ((d.bestBid + d.bestAsk) / 2) * TICK;
      ctx.fillStyle = "#8a8a8a";
      ctx.font = '400 9px "IBM Plex Mono", ui-monospace, monospace';
      ctx.textAlign = "center";
      ctx.textBaseline = "alphabetic";
      ctx.fillText("mid " + spreadMid.toFixed(2), midX, h - 8);
    }
  };

  BookViz.prototype.applyStep = function () {
    if (this.step > 0 && this.step % SESSION.length === 0) {
      this.book = new OrderBook();
    }

    var ev = SESSION[this.step % SESSION.length];
    var side = ev.side === "buy" ? "buy" : "sell";
    var result = this.book.submit(side, ev.price, ev.qty, ev.op);

    if (result.fills.length) {
      var last = result.fills[result.fills.length - 1];
      this.flash = { price: last.price, at: Date.now() };
    }

    this.book.assertUncrossed();
    this.updateMeta();
    this.draw();
    this.step += 1;
  };

  BookViz.prototype.tick = function () {
    this.applyStep();
    var self = this;
    var ev = this.book.lastEvent;
    var delay =
      ev && (ev.type === "match" || ev.type === "filled")
        ? this.stepMsMatch
        : this.stepMs;
    this.timer = window.setTimeout(function () {
      self.tick();
    }, delay);
  };

  BookViz.prototype.start = function () {
    this.resize();
    this.updateMeta();
    this.draw();

    if (this.prefersReducedMotion) {
      for (var i = 0; i < SESSION.length; i++) this.applyStep();
      return;
    }

    this.tick();
  };

  BookViz.prototype.destroy = function () {
    if (this.timer) window.clearTimeout(this.timer);
  };

  if (typeof document !== "undefined") {
    var root = document.getElementById("hero-viz");
    if (root) {
      var viz = new BookViz(root);
      viz.start();
    }
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      OrderBook: OrderBook,
      runSessionTest: runSessionTest,
      runSessionCycles: runSessionCycles,
    };
  }

  if (typeof process !== "undefined" && process.argv[1] && /hero-viz\.js$/.test(process.argv[1])) {
    var result = runSessionTest();
    console.log(
      "Session OK. Volume:",
      result.volume,
      "Trades:",
      result.trades,
      "Spread:",
      result.spread,
      "ticks"
    );
  }
})();

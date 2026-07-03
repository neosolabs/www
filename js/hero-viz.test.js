#!/usr/bin/env node
"use strict";

var mod = require("./hero-viz.js");
var OrderBook = mod.OrderBook;

var passed = 0;
var failed = 0;

function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    failed++;
    return;
  }
  passed++;
}

function sumBookSide(book, side) {
  var levels = side === "bid" ? book.bids : book.asks;
  var total = 0;
  for (var p in levels) {
    levels[p].forEach(function (o) {
      total += o.qty;
    });
  }
  return total;
}

function totalVolumeFromFills(book, fills) {
  return fills.reduce(function (n, f) {
    return n + f.qty;
  }, 0);
}

console.log("=== Order book correctness suite ===\n");

// 1. Price-time FIFO at same level
(function () {
  var book = new OrderBook();
  book.submit("sell", 10005, 100, "limit");
  book.submit("sell", 10005, 200, "limit");
  var r = book.submit("buy", 10005, 150, "limit");
  assert(r.fills.length === 2, "FIFO: two fills when crossing two makers");
  assert(r.fills[0].qty === 100 && r.fills[0].makerId === 1, "FIFO: first maker fully consumed");
  assert(r.fills[1].qty === 50 && r.fills[1].makerId === 2, "FIFO: second maker partially hit");
  assert(book.asks[10005][0].qty === 150, "FIFO: remainder on second order");
  book.assertUncrossed();
})();

// 2. Multi-level sweep (price priority before time)
(function () {
  var book = new OrderBook();
  book.submit("sell", 10008, 500, "limit");
  book.submit("sell", 10006, 300, "limit");
  var r = book.submit("buy", 10010, 600, "limit");
  assert(r.fills[0].price === 10006 && r.fills[0].qty === 300, "Price priority: best ask first");
  assert(r.fills[1].price === 10008 && r.fills[1].qty === 300, "Price priority: next level");
  assert(!book.asks[10006], "Price priority: level cleared");
  assert(book.asks[10008][0].qty === 200, "Price priority: partial at second level");
  book.assertUncrossed();
})();

// 3. Limit does not cross (rests instead)
(function () {
  var book = new OrderBook();
  book.submit("sell", 10010, 100, "limit");
  var r = book.submit("buy", 10005, 50, "limit");
  assert(r.fills.length === 0, "Non-crossing limit: no fills");
  assert(book.bids[10005][0].qty === 50, "Non-crossing limit: rests on bid");
  book.assertUncrossed();
})();

// 4. Exact touch matches
(function () {
  var book = new OrderBook();
  book.submit("sell", 10005, 40, "limit");
  var r = book.submit("buy", 10005, 40, "limit");
  assert(r.fills.length === 1 && r.fills[0].qty === 40, "Exact touch: full fill");
  assert(!book.bids[10005] && !book.asks[10005], "Exact touch: book flat at level");
  book.assertUncrossed();
})();

// 5. Volume conservation on partial + rest
(function () {
  var book = new OrderBook();
  book.submit("sell", 10006, 100, "limit");
  var r = book.submit("buy", 10008, 250, "limit");
  assert(totalVolumeFromFills(book, r.fills) === 100, "Volume: filled amount");
  assert(book.bids[10008][0].qty === 150, "Volume: resting remainder");
  assert(book.volume === 100, "Volume: session counter");
  book.assertUncrossed();
})();

// 6. Spread invariant after full session
(function () {
  var result = mod.runSessionTest();
  assert(result.spread > 0, "Session: positive spread after all steps");
  console.log(
    "  Session snapshot: volume=" +
      result.volume +
      " trades=" +
      result.trades +
      " spread=" +
      result.spread +
      " ticks"
  );
})();

// 7. Session replay: each cycle matches a fresh run
(function () {
  var once = mod.runSessionTest();
  var cycled = mod.runSessionCycles(2);
  assert(once.volume === cycled.volume, "Session replay: volume identical per cycle");
  assert(once.trades === cycled.trades, "Session replay: trade count identical per cycle");
  assert(once.spread === cycled.spread, "Session replay: spread identical per cycle");
})();

// 8. Filled event is a clean object (no stale match fields)
(function () {
  var book = new OrderBook();
  book.submit("sell", 10006, 400, "limit");
  book.submit("sell", 10007, 900, "limit");
  book.submit("buy", 10008, 650, "limit");
  var ev = book.lastEvent;
  assert(ev.type === "filled", "Filled: event type");
  assert(ev.makerId === undefined, "Filled: no stale makerId");
  assert(ev.totalQty === 650, "Filled: total qty");
})();

// 9. Integer tick spread math
(function () {
  var book = new OrderBook();
  book.submit("buy", 10004, 10, "limit");
  book.submit("sell", 10006, 10, "limit");
  var d = book.depth(1);
  var spreadTicks = d.bestAsk - d.bestBid;
  assert(spreadTicks === 2, "Spread: 2 ticks between 100.04 bid and 100.06 ask");
  assert(Math.abs(spreadTicks * 0.01 - 0.02) < 1e-9, "Spread: 0.02 dollars");
})();

console.log("\n=== Results: " + passed + " passed, " + failed + " failed ===");
process.exit(failed > 0 ? 1 : 0);

#!/usr/bin/env node
"use strict";

var mod = require("./risk-viz.js");
var liqPrice = mod.liqPrice;
var positionState = mod.positionState;
var MMR = mod.MMR;

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

function near(a, b, eps) {
  return Math.abs(a - b) <= (eps || 1e-9);
}

console.log("=== Risk engine correctness suite ===\n");

// 1. Margin ratio at entry equals initial margin ratio (1/leverage)
(function () {
  var pos = { side: "long", size: 1, entry: 60000, leverage: 10 };
  var st = positionState(pos, pos.entry);
  assert(near(st.marginPct, 1 / pos.leverage), "Entry: marginPct == 1/leverage");
  assert(near(st.upnl, 0), "Entry: zero uPnL at mark == entry");
  assert(near(st.im, 6000), "Entry: IM = size*entry/leverage");
  assert(st.health > 0.99, "Entry: health near 1");
})();

// 2. Long liquidation price hits maintenance margin exactly
(function () {
  var pos = { side: "long", size: 0.8, entry: 58500, leverage: 10 };
  var lp = liqPrice("long", pos.entry, pos.leverage);
  var st = positionState(pos, lp);
  assert(near(st.marginPct, MMR), "Long: marginPct == MMR at liq price");
  assert(positionState(pos, lp - 1).liquidated, "Long: liquidates just below liq price");
  assert(!positionState(pos, lp + 50).liquidated, "Long: solvent just above liq price");
})();

// 3. Short liquidation price hits maintenance margin exactly
(function () {
  var pos = { side: "short", size: 0.6, entry: 62800, leverage: 20 };
  var lp = liqPrice("short", pos.entry, pos.leverage);
  var st = positionState(pos, lp);
  assert(near(st.marginPct, MMR), "Short: marginPct == MMR at liq price");
  assert(positionState(pos, lp + 1).liquidated, "Short: liquidates just above liq price");
  assert(!positionState(pos, lp - 50).liquidated, "Short: solvent just below liq price");
})();

// 4. PnL direction and symmetry
(function () {
  var long = { side: "long", size: 1, entry: 60000, leverage: 5 };
  var short = { side: "short", size: 1, entry: 60000, leverage: 5 };
  assert(positionState(long, 61000).upnl > 0, "Long: profit when price rises");
  assert(positionState(long, 59000).upnl < 0, "Long: loss when price falls");
  assert(positionState(short, 59000).upnl > 0, "Short: profit when price falls");
  assert(
    near(positionState(long, 61000).upnl, -positionState(short, 61000).upnl),
    "Symmetry: long/short uPnL mirror at same mark"
  );
})();

// 5. Higher leverage liquidates closer to entry (tighter buffer)
(function () {
  var tight = liqPrice("long", 60000, 20);
  var loose = liqPrice("long", 60000, 4);
  assert(tight > loose, "Leverage: 20× liq price closer to entry than 4×");
  assert(loose < 60000 && tight < 60000, "Long liq prices sit below entry");
})();

// 6. Scenario book is initially solvent at the start mark
(function () {
  var allLive = mod.SCENARIO.every(function (p) {
    return !positionState(p, 60000).liquidated;
  });
  assert(allLive, "Scenario: every position solvent at $60,000 mark");
})();

// 7. Health decreases monotonically toward the liq price (long)
(function () {
  var pos = { side: "long", size: 1, entry: 60000, leverage: 8 };
  var lp = liqPrice("long", pos.entry, pos.leverage);
  var hHigh = positionState(pos, 60000).health;
  var hMid = positionState(pos, (60000 + lp) / 2).health;
  var hLow = positionState(pos, lp + 5).health;
  assert(hHigh > hMid && hMid > hLow, "Health: monotonic decline toward liq");
})();

console.log("\n=== Results: " + passed + " passed, " + failed + " failed ===");
process.exit(failed > 0 ? 1 : 0);

#!/usr/bin/env node
"use strict";

var mod = require("./ecg-viz.js");
var beatWave = mod.beatWave;
var classifyBeat = mod.classifyBeat;
var gaussian = mod.gaussian;

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

console.log("=== ECG signal + classifier suite ===\n");

// 1. Gaussian peak and symmetry
(function () {
  assert(Math.abs(gaussian(0, 0, 0.02, 1) - 1) < 1e-9, "Gaussian: peak at mu");
  assert(
    Math.abs(gaussian(-0.03, 0, 0.02, 1) - gaussian(0.03, 0, 0.02, 1)) < 1e-9,
    "Gaussian: symmetric about mu"
  );
})();

// 2. Normal beat morphology: R dominates, P and T positive, S negative
(function () {
  var b = { isV: false, amp: 1, width: 0.07 };
  var R = beatWave(0, b);
  var P = beatWave(-0.16, b);
  var S = beatWave(0.028, b);
  var T = beatWave(0.17, b);
  assert(R > 0.85, "Normal: R peak dominant");
  assert(P > 0 && P < R, "Normal: P wave positive and smaller than R");
  assert(S < 0, "Normal: S wave negative");
  assert(T > 0, "Normal: T wave positive");
  assert(beatWave(0.6, b) === 0, "Normal: no contribution far from beat");
})();

// 3. PVC morphology: wide, tall, no upright P, inverted T
(function () {
  var v = { isV: true, amp: 1.4, width: 0.12 };
  assert(beatWave(0, v) > 1.0, "PVC: tall R");
  assert(beatWave(0.22, v) < 0, "PVC: inverted T wave");
  // Larger QRS excursion than a normal beat away from the R peak.
  var normal = { isV: false, amp: 1, width: 0.07 };
  assert(
    Math.abs(beatWave(0.06, v)) > Math.abs(beatWave(0.06, normal)),
    "PVC: larger QRS deflection than a normal beat"
  );
})();

// 4. Classifier: premature + wide ⇒ V; otherwise N
(function () {
  assert(classifyBeat(0.55, 0.85, 0.13) === "V", "Classify: premature wide ⇒ V");
  assert(classifyBeat(0.82, 0.85, 0.07) === "N", "Classify: normal ⇒ N");
  assert(
    classifyBeat(0.6, 0.85, 0.07) === "N",
    "Classify: premature but narrow (e.g. PAC) ⇒ not V"
  );
  assert(
    classifyBeat(0.84, 0.85, 0.13) === "N",
    "Classify: wide but on-time ⇒ not V"
  );
})();

console.log("\n=== Results: " + passed + " passed, " + failed + " failed ===");
process.exit(failed > 0 ? 1 : 0);

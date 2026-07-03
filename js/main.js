(function () {
  "use strict";

  const header = document.querySelector(".site-header");
  const navToggle = document.querySelector(".nav-toggle");
  const siteNav = document.querySelector(".site-nav");
  const navLinks = document.querySelectorAll(".site-nav a");
  const reveals = document.querySelectorAll(".reveal");

  const prefersReducedMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)"
  ).matches;

  /* ── Scroll: header border ── */

  function onScroll() {
    if (!header) return;
    header.classList.toggle("is-scrolled", window.scrollY > 8);
  }

  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  /* ── Mobile navigation ── */

  function closeNav() {
    if (!navToggle || !siteNav) return;
    navToggle.setAttribute("aria-expanded", "false");
    navToggle.setAttribute("aria-label", "Open menu");
    siteNav.classList.remove("is-open");
    document.body.style.overflow = "";
  }

  function openNav() {
    if (!navToggle || !siteNav) return;
    navToggle.setAttribute("aria-expanded", "true");
    navToggle.setAttribute("aria-label", "Close menu");
    siteNav.classList.add("is-open");
    document.body.style.overflow = "hidden";
  }

  if (navToggle && siteNav) {
    navToggle.addEventListener("click", function () {
      const expanded = navToggle.getAttribute("aria-expanded") === "true";
      if (expanded) closeNav();
      else openNav();
    });

    navLinks.forEach(function (link) {
      link.addEventListener("click", closeNav);
    });

    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") closeNav();
    });
  }

  /* ── Reveal on scroll ── */

  if (prefersReducedMotion) {
    reveals.forEach(function (el) {
      el.classList.add("is-visible");
    });
  } else if ("IntersectionObserver" in window && reveals.length) {
    const observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-visible");
            observer.unobserve(entry.target);
          }
        });
      },
      { rootMargin: "0px 0px -6% 0px", threshold: 0.08 }
    );

    reveals.forEach(function (el) {
      observer.observe(el);
    });
  } else {
    reveals.forEach(function (el) {
      el.classList.add("is-visible");
    });
  }

  /* ── Showcase terminal ── */

  var showcaseViewport = document.getElementById("showcase-terminal-viewport");

  function pinTerminal(viewport) {
    if (!viewport) return;
    requestAnimationFrame(function () {
      viewport.scrollTop = viewport.scrollHeight;
    });
  }

  function watchTerminalViewport(viewport) {
    if (!viewport || prefersReducedMotion) return;

    if ("ResizeObserver" in window) {
      var ro = new ResizeObserver(function () {
        pinTerminal(viewport);
      });
      ro.observe(viewport);
    }
  }

  watchTerminalViewport(showcaseViewport);

  var terminalStarted = false;

  function initShowcaseAnimations() {
    if (terminalStarted) return;
    terminalStarted = true;

    if (!prefersReducedMotion) {
      runTerminalSequence();
    } else {
      renderTerminalStatic();
    }
  }

  if ("IntersectionObserver" in window) {
    var showcase = document.getElementById("showcase");
    if (showcase) {
      var showcaseObserver = new IntersectionObserver(
        function (entries) {
          entries.forEach(function (entry) {
            if (entry.isIntersecting) {
              initShowcaseAnimations();
              showcaseObserver.disconnect();
            }
          });
        },
        { threshold: 0.2 }
      );
      showcaseObserver.observe(showcase);
    }
  } else {
    initShowcaseAnimations();
  }

  /* ── Terminal sequence: typed commands, instant output ── */

  var TERMINAL_LINES = [
    { type: "prompt", text: "neosol audit --component matching-engine" },
    { type: "out", text: "→ price–time priority verified · book invariant OK" },
    { type: "out", text: "→ p99 match path: 1.2µs (within budget)" },
    { type: "prompt", text: "neosol bench --scenario sweep-3-levels" },
    { type: "out", text: "→ 480k orders/s · 0 crossed-book violations" },
    { type: "prompt", text: "neosol test --suite integration" },
    { type: "out", text: "→ 1,204 passed · 0 failed · 12 skipped" },
    { type: "prompt", text: "neosol ship --env production" },
    { type: "out", text: "→ artifacts signed · staged rollout · monitors green" },
    {
      type: "success",
      text: "✓ release v2.4.1 — matching-engine operational",
    },
  ];

  var PROMPT_CHAR_DELAY = 22;
  var PAUSE_BEFORE_CMD = 350;
  var PAUSE_AFTER_CMD = 280;
  var PAUSE_AFTER_OUT = 420;
  var PAUSE_AFTER_SUCCESS = 1400;
  var PAUSE_BEFORE_LOOP = 4000;

  function renderTerminalStatic() {
    var log = document.getElementById("terminal-log");
    if (!log) return;

    log.innerHTML = TERMINAL_LINES.map(function (line) {
      return lineHtml(line, true);
    }).join("");
    pinTerminal(showcaseViewport);
  }

  function lineHtml(line, complete) {
    var cls =
      line.type === "prompt"
        ? "terminal__line terminal__line--prompt"
        : line.type === "success"
          ? "terminal__line terminal__line--success"
          : "terminal__line";

    var prefix = line.type === "prompt" ? '<span class="terminal__prompt">$ </span>' : "";
    var text = complete ? line.text : "";

    return (
      '<div class="' +
      cls +
      '">' +
      prefix +
      '<span class="terminal__text">' +
      escapeHtml(text) +
      "</span></div>"
    );
  }

  function escapeHtml(str) {
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function delay(ms) {
    return new Promise(function (resolve) {
      window.setTimeout(resolve, ms);
    });
  }

  function typeLine(lineEl, text, charDelay, viewport) {
    var span = lineEl.querySelector(".terminal__text");
    if (!span) return Promise.resolve();

    return new Promise(function (resolve) {
      var i = 0;

      function tick() {
        if (i >= text.length) {
          pinTerminal(viewport);
          resolve();
          return;
        }
        span.textContent += text.charAt(i);
        i += 1;
        pinTerminal(viewport);
        window.setTimeout(tick, charDelay);
      }

      tick();
    });
  }

  function appendLine(log, line, complete) {
    var el = document.createElement("div");
    el.innerHTML = lineHtml(line, complete);
    var lineNode = el.firstElementChild;
    log.appendChild(lineNode);
    pinTerminal(showcaseViewport);
    return lineNode;
  }

  async function runTerminalSequence() {
    var log = document.getElementById("terminal-log");
    if (!log) return;

    log.innerHTML = "";

    for (var i = 0; i < TERMINAL_LINES.length; i++) {
      var line = TERMINAL_LINES[i];

      if (line.type === "prompt") {
        if (i > 0) await delay(PAUSE_BEFORE_CMD);
        var promptNode = appendLine(log, line, false);
        var promptText = promptNode.querySelector(".terminal__text");
        if (promptText) promptText.textContent = "";
        await typeLine(promptNode, line.text, PROMPT_CHAR_DELAY, showcaseViewport);
        await delay(PAUSE_AFTER_CMD);
      } else {
        appendLine(log, line, true);
        await delay(
          line.type === "success" ? PAUSE_AFTER_SUCCESS : PAUSE_AFTER_OUT
        );
      }
    }

    await delay(PAUSE_BEFORE_LOOP);
    log.innerHTML = "";
    pinTerminal(showcaseViewport);
    runTerminalSequence();
  }
})();

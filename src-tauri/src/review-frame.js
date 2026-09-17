// review-frame.js - injected into a presented page so the captain can comment on it.
//
// src-tauri/src/artifact.rs appends this to every HTML document it serves. The
// page itself is never changed on disk, and this script does nothing until the
// review screen talks to it, so the file still opens the same way anywhere else.
//
// It talks to the review screen through postMessage only, because the page runs
// in a sandboxed frame with no same-origin access:
//
//   in   qd:mode      {mode: "read" | "comment"}
//   in   qd:threads   {threads: [{id, anchor, draft}]}  draw these, newest last
//   in   qd:focus     {id}                              scroll one into view
//   out  qd:ready     the page is listening
//   out  qd:picked    {anchor}                          the captain picked a place
//   out  qd:located   {found: [id], missing: [id]}      where the threads landed
//
// An anchor is {quote, prefix, suffix, path}: the words themselves plus a little
// text either side, so it can be found again after the page is revised, and a CSS
// path as a fallback for a whole block.
(function () {
  var CONTEXT = 40;
  var QUOTE_LIMIT = 300;
  var mode = "read";
  var threads = [];
  var layer = null;

  function post(type, body) {
    var message = { type: type };
    for (var key in body) if (Object.prototype.hasOwnProperty.call(body, key)) message[key] = body[key];
    parent.postMessage(message, "*");
  }

  function normalize(text) {
    return (text || "").replace(/\s+/g, " ").trim();
  }

  function cssPath(node) {
    var parts = [];
    while (node && node.nodeType === 1 && node !== document.body && parts.length < 5) {
      var part = node.tagName.toLowerCase();
      if (node.id) {
        parts.unshift(part + "#" + node.id);
        break;
      }
      var siblings = node.parentElement ? node.parentElement.children : [];
      var index = 0;
      for (var i = 0; i < siblings.length; i++) {
        if (siblings[i].tagName === node.tagName) {
          index++;
          if (siblings[i] === node) break;
        }
      }
      parts.unshift(part + ":nth-of-type(" + index + ")");
      node = node.parentElement;
    }
    return parts.join(" > ");
  }

  // Every text node in order, with the document's text as one string, so a quote
  // can be found across element boundaries.
  function textIndex() {
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        var parent = node.parentElement;
        if (!parent || parent.closest("script, style, #__qd_layer__")) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    var nodes = [];
    var text = "";
    var node;
    while ((node = walker.nextNode())) {
      nodes.push({ node: node, start: text.length });
      text += node.nodeValue;
    }
    return { nodes: nodes, text: text };
  }

  function pointAt(index, nodes) {
    for (var i = nodes.length - 1; i >= 0; i--) {
      if (index >= nodes[i].start) return { node: nodes[i].node, offset: Math.min(index - nodes[i].start, nodes[i].node.nodeValue.length) };
    }
    return null;
  }

  function rangeFor(index, length, nodes) {
    var from = pointAt(index, nodes);
    var to = pointAt(index + length, nodes);
    if (!from || !to) return null;
    var range = document.createRange();
    range.setStart(from.node, from.offset);
    range.setEnd(to.node, to.offset);
    return range;
  }

  // The best place for an anchor: the occurrence of its quote whose surrounding
  // text matches what was there when the comment was written.
  function locate(anchor) {
    if (!anchor) return null;
    var quote = normalize(anchor.quote);
    if (!quote) return byPath(anchor);
    var index = textIndex();
    var haystack = normalize(index.text);
    // Map normalized positions back to raw ones by walking both together.
    var raw = index.text;
    var map = [];
    var seenSpace = true;
    for (var i = 0; i < raw.length; i++) {
      var character = raw[i];
      if (/\s/.test(character)) {
        if (seenSpace) continue;
        seenSpace = true;
        map.push(i);
      } else {
        seenSpace = false;
        map.push(i);
      }
    }
    var best = -1;
    var bestScore = -1;
    var at = haystack.indexOf(quote);
    while (at !== -1) {
      var before = haystack.slice(Math.max(0, at - CONTEXT), at);
      var after = haystack.slice(at + quote.length, at + quote.length + CONTEXT);
      var score = overlap(before, normalize(anchor.prefix)) + overlap(after, normalize(anchor.suffix));
      if (score > bestScore) {
        bestScore = score;
        best = at;
      }
      at = haystack.indexOf(quote, at + 1);
    }
    if (best === -1) return byPath(anchor);
    var startRaw = map[best];
    var endRaw = best + quote.length < map.length ? map[best + quote.length - 1] + 1 : raw.length;
    return rangeFor(startRaw, endRaw - startRaw, index.nodes);
  }

  function overlap(a, b) {
    if (!a || !b) return 0;
    var length = Math.min(a.length, b.length);
    var same = 0;
    for (var i = 1; i <= length; i++) {
      if (a.slice(-i) === b.slice(-i) || a.slice(0, i) === b.slice(0, i)) same = i;
    }
    return same;
  }

  function byPath(anchor) {
    if (!anchor || !anchor.path) return null;
    var element;
    try {
      element = document.querySelector(anchor.path);
    } catch (error) {
      return null;
    }
    if (!element) return null;
    var range = document.createRange();
    range.selectNodeContents(element);
    return range;
  }

  function ensureLayer() {
    if (layer && layer.isConnected) return layer;
    layer = document.createElement("div");
    layer.id = "__qd_layer__";
    layer.setAttribute("aria-hidden", "true");
    layer.style.cssText = "position:absolute;top:0;left:0;width:0;height:0;pointer-events:none;z-index:2147483646";
    document.documentElement.appendChild(layer);
    return layer;
  }

  function draw() {
    var host = ensureLayer();
    host.textContent = "";
    var found = [];
    var missing = [];
    for (var i = 0; i < threads.length; i++) {
      var thread = threads[i];
      var range = locate(thread.anchor);
      if (!range) {
        missing.push(thread.id);
        continue;
      }
      found.push(thread.id);
      var rects = range.getClientRects();
      for (var r = 0; r < rects.length; r++) {
        var rect = rects[r];
        if (rect.width < 1 || rect.height < 1) continue;
        var mark = document.createElement("div");
        mark.style.cssText =
          "position:absolute;left:" + (rect.left + window.scrollX) + "px;top:" + (rect.top + window.scrollY) + "px;width:" + rect.width + "px;height:" + rect.height +
          "px;border-radius:2px;background:" + (thread.draft ? "rgba(41,124,116,.20)" : "rgba(41,124,116,.13)") +
          ";box-shadow:inset 0 -1px 0 " + (thread.draft ? "rgba(41,124,116,.85)" : "rgba(41,124,116,.45)");
        host.appendChild(mark);
      }
    }
    post("qd:located", { found: found, missing: missing });
  }

  var pending = null;
  function redraw() {
    if (pending) return;
    pending = requestAnimationFrame(function () {
      pending = null;
      draw();
    });
  }

  function anchorFromSelection() {
    var selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
    var range = selection.getRangeAt(0);
    var quote = normalize(range.toString());
    if (!quote) return null;
    var index = textIndex();
    var whole = normalize(index.text);
    var at = whole.indexOf(quote);
    return {
      quote: quote.slice(0, QUOTE_LIMIT),
      prefix: at > 0 ? whole.slice(Math.max(0, at - CONTEXT), at) : "",
      suffix: at === -1 ? "" : whole.slice(at + quote.length, at + quote.length + CONTEXT),
      path: cssPath(range.commonAncestorContainer.nodeType === 1 ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement),
    };
  }

  // A click with no selection comments on the smallest block that holds real text.
  function anchorFromPoint(target) {
    var element = target;
    while (element && element !== document.body && normalize(element.textContent).length === 0) element = element.parentElement;
    if (!element || element === document.body) return null;
    var quote = normalize(element.textContent).slice(0, QUOTE_LIMIT);
    if (!quote) return null;
    var index = textIndex();
    var whole = normalize(index.text);
    var at = whole.indexOf(quote);
    return {
      quote: quote,
      prefix: at > 0 ? whole.slice(Math.max(0, at - CONTEXT), at) : "",
      suffix: at === -1 ? "" : whole.slice(at + quote.length, at + quote.length + CONTEXT),
      path: cssPath(element),
    };
  }

  function onClick(event) {
    if (mode !== "comment") return;
    event.preventDefault();
    event.stopPropagation();
    var anchor = anchorFromSelection() || anchorFromPoint(event.target);
    if (anchor) post("qd:picked", { anchor: anchor });
  }

  function onMove(event) {
    if (mode !== "comment") return;
    var element = event.target;
    while (element && element !== document.body && normalize(element.textContent).length === 0) element = element.parentElement;
    document.documentElement.style.setProperty("--qd-hover", "1");
    if (hovered && hovered !== element) hovered.style.outline = "";
    if (element && element !== document.body) {
      element.style.outline = "2px solid rgba(41,124,116,.55)";
      element.style.outlineOffset = "1px";
    }
    hovered = element;
  }
  var hovered = null;

  function clearHover() {
    if (hovered) hovered.style.outline = "";
    hovered = null;
  }

  window.addEventListener("message", function (event) {
    if (event.source !== parent) return;
    var data = event.data || {};
    if (data.type === "qd:mode") {
      mode = data.mode === "comment" ? "comment" : "read";
      document.body.style.cursor = mode === "comment" ? "crosshair" : "";
      if (mode !== "comment") clearHover();
    } else if (data.type === "qd:threads") {
      threads = Array.isArray(data.threads) ? data.threads : [];
      redraw();
    } else if (data.type === "qd:focus") {
      for (var i = 0; i < threads.length; i++) {
        if (threads[i].id !== data.id) continue;
        var range = locate(threads[i].anchor);
        if (!range) return;
        var rect = range.getBoundingClientRect();
        window.scrollTo({ top: rect.top + window.scrollY - window.innerHeight / 3, behavior: "smooth" });
      }
    }
  });

  document.addEventListener("click", onClick, true);
  document.addEventListener("mousemove", onMove, true);
  window.addEventListener("resize", redraw);
  window.addEventListener("scroll", redraw, true);
  if (window.ResizeObserver) new ResizeObserver(redraw).observe(document.documentElement);

  post("qd:ready", {});
})();

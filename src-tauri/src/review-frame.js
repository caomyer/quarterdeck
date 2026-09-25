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
//   out  qd:scenes    {scenes: [{id, file, label, rect}]} diagrams the page owns
//   out  qd:ready     the page is listening
//   out  qd:picked    {anchor, pick}                    the captain picked a place
//   out  qd:pictured  {pick, jpeg, crop, took_ms} | {pick, error}
//                     the page drawn around that place, or why it could not be
//   out  qd:located   {found: [id], missing: [id]}      where the threads landed
//
// An anchor is {quote, prefix, suffix, path} and, for a place picked here:
//   quote, prefix, suffix  the words, and a little text either side, so the place
//                          can be found again after the page is revised
//   occurrence   {n, of, shown}  which of the places those words appear the captain meant,
//                counted through all the page's text, and how many of them were on screen
//   element      the element's path by id, classes, data attributes and states,
//                such as div.prov.open[data-prov=claude], which says what was open
//   near         the headings and labels around it, in words: "Plan limits › Claude › 5h"
//   box, point   where it sat and where the click fell, in page CSS pixels
//   view         the window's size, how far it was scrolled, and whether the page read light or dark
//   reasons      why words alone may not say which place: "repeated", "opened", "wordless"
//   path         a positional CSS path, the last way to find a whole block
// An anchor on a diagram the page owns is {scene, label, path} instead: the scene
// file is the thing being talked about.
//
// A picture is the page redrawing itself with SnapDOM, which the app serves at
// /_qd/snapdom.js and this script loads on the first pick. It is not a
// screenshot: layout and content are right, but images from other sites,
// canvases and fine detail can differ from what the captain saw. It is cropped
// around the place, with the place outlined, and sent as a small JPEG.
//
// A page says a picture is a diagram it owns by marking it
// `data-quarterdeck-scene="<file>"`, optionally with
// `data-quarterdeck-scene-label="<name>"`. The file ships beside the page, so the
// page stays a plain picture anywhere else and the review screen can open the real
// thing.
(function () {
  var CONTEXT = 40;
  var QUOTE_LIMIT = 300;
  // A picture shows this much of the page around the place, and never more than a screenful.
  var PICTURE_PAD = 110;
  var PICTURE_MAX = { w: 800, h: 600 };
  var PICTURE_QUALITY = 0.7;
  var OUTLINE = "rgba(41,124,116,.95)";
  var mode = "read";
  var threads = [];
  var layer = null;
  var picks = 0;
  var library = null;

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

  // The same element described by what it is rather than where it is: id,
  // classes, data attributes and open states, up to the nearest id.
  function describe(node) {
    var parts = [];
    while (node && node.nodeType === 1 && node !== document.body && node !== document.documentElement && parts.length < 10) {
      var part = node.tagName.toLowerCase();
      if (node.id) part += "#" + node.id;
      var classes = [];
      for (var c = 0; c < node.classList.length && classes.length < 3; c++) classes.push(node.classList[c]);
      if (classes.length) part += "." + classes.join(".");
      var marks = [];
      for (var a = 0; a < node.attributes.length && marks.length < 2; a++) {
        var attribute = node.attributes[a];
        if (attribute.name.indexOf("data-") === 0 && attribute.name.indexOf("data-quarterdeck") !== 0 && attribute.value.length <= 40) {
          marks.push("[" + attribute.name + "=" + attribute.value + "]");
        }
      }
      if (node.hasAttribute("open")) marks.push("[open]");
      ["aria-expanded", "aria-selected", "aria-checked", "aria-current"].forEach(function (name) {
        var value = node.getAttribute(name);
        if (value && value !== "false") marks.push("[" + name + "=" + value + "]");
      });
      parts.unshift(part + marks.join(""));
      if (node.id) break;
      node = node.parentElement;
    }
    return parts.join(" > ");
  }

  var OPEN_CLASSES = /^(open|opened|expanded|is-open|is-expanded|show)$/;

  // Something the captain had to open to see this place: an expanded row, a
  // disclosure, a dialog. The agent opening the page will not see it unless it
  // knows what to open, so words alone are not enough.
  function insideOpened(node) {
    while (node && node.nodeType === 1 && node !== document.body) {
      if (node.hasAttribute("open") || node.getAttribute("aria-expanded") === "true") return true;
      var role = node.getAttribute("role");
      if (role === "dialog" || role === "alertdialog") return true;
      for (var c = 0; c < node.classList.length; c++) if (OPEN_CLASSES.test(node.classList[c])) return true;
      node = node.parentElement;
    }
    return false;
  }

  function labelText(element) {
    var text = normalize(element && element.textContent);
    return text.length > 0 && text.length <= 48 ? text : "";
  }

  var HEADINGS = "h1, h2, h3, h4, h5, h6, legend, caption, summary";

  // The heading-like element before `branch` in `container`: a real heading, or
  // an element whose class says head or title, read for its strongest words.
  function headingBefore(container, branch) {
    for (var i = 0; i < container.children.length; i++) {
      var child = container.children[i];
      if (child === branch || child.contains(branch)) return "";
      var named = typeof child.className === "string" && /(^|[-_\s])(head|header|heading|title)([-_\s]|$)/i.test(child.className);
      if (!child.matches(HEADINGS) && !named) continue;
      var strongest = child.matches(HEADINGS) ? child : child.querySelector(HEADINGS + ", strong, b") || child.firstElementChild || child;
      var text = labelText(strongest);
      if (text) return text;
    }
    return "";
  }

  // The headings and labels around a place, outermost first, in words.
  function near(node) {
    var parts = [];
    var own = "";
    for (var sibling = node.previousElementSibling, steps = 0; sibling && steps < 3; sibling = sibling.previousElementSibling, steps++) {
      if (sibling.matches("dt, th, label")) {
        own = labelText(sibling);
        break;
      }
    }
    var element = node;
    while (element.parentElement && element.parentElement !== document.documentElement && parts.length < 4) {
      var heading = headingBefore(element.parentElement, element);
      if (heading && parts[0] !== heading) parts.unshift(heading);
      element = element.parentElement;
    }
    if (own && parts[parts.length - 1] !== own) parts.push(own);
    return parts.join(" › ").slice(0, 200);
  }

  function pageBox(rect) {
    return { x: Math.round(rect.left + window.scrollX), y: Math.round(rect.top + window.scrollY), w: Math.round(rect.width), h: Math.round(rect.height) };
  }

  function colour(value) {
    var match = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?/.exec(value || "");
    return match ? { r: +match[1], g: +match[2], b: +match[3], a: match[4] === undefined ? 1 : +match[4] } : null;
  }

  // The first solid background behind a place, which is what the captain saw it on.
  function backdrop(node) {
    for (; node && node.nodeType === 1; node = node.parentElement) {
      var found = colour(getComputedStyle(node).backgroundColor);
      if (found && found.a > 0.5) return found;
    }
    return { r: 255, g: 255, b: 255, a: 1 };
  }

  function view(node) {
    var behind = backdrop(node);
    var light = (0.2126 * behind.r + 0.7152 * behind.g + 0.0722 * behind.b) / 255 > 0.5;
    return { w: window.innerWidth, h: window.innerHeight, scroll_y: Math.round(window.scrollY), scheme: light ? "light" : "dark" };
  }

  function occurrences(whole, quote) {
    var found = [];
    for (var at = whole.indexOf(quote); at !== -1 && found.length < 1000; at = whole.indexOf(quote, at + 1)) found.push(at);
    return found;
  }

  // Everything about a picked place beyond its words.
  function placeOf(element, rect, whole, quote, at, extra) {
    var all = occurrences(whole, quote);
    var shown = all.length > 1 ? shownCount(quote, all) : all.length;
    var reasons = [];
    if (shown > 1) reasons.push("repeated");
    if (insideOpened(element)) reasons.push("opened");
    if (extra.wordless) reasons.push("wordless");
    var place = {
      occurrence: at === -1 || all.indexOf(at) === -1 ? null : { n: all.indexOf(at) + 1, of: all.length, shown: shown },
      element: describe(element),
      near: near(element),
      box: pageBox(rect),
      view: view(element),
      reasons: reasons,
    };
    if (extra.point) place.point = extra.point;
    return place;
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

  // Where a point in the page falls in the normalized text: near enough to tell
  // one occurrence of the same words from another, which is all it is used for.
  function normalizedOffset(index, node, offset) {
    if (node && node.nodeType === 1) {
      // The child the point sits before, or failing that (say, blank space) the element itself.
      var candidates = [node.childNodes[offset], node];
      for (var c = 0; c < candidates.length; c++) {
        var inside = candidates[c];
        if (!inside) continue;
        for (var i = 0; i < index.nodes.length; i++) {
          if (inside === index.nodes[i].node || (inside.contains && inside.contains(index.nodes[i].node))) {
            return normalize(index.text.slice(0, index.nodes[i].start)).length;
          }
        }
      }
      return -1;
    }
    for (var j = 0; j < index.nodes.length; j++) {
      if (index.nodes[j].node === node) return normalize(index.text.slice(0, index.nodes[j].start + offset)).length;
    }
    return -1;
  }

  // The occurrence of the quote the captain actually chose, so a comment on the
  // second "Wi-Fi only" carries the second one's surroundings, not the first's.
  function occurrenceNear(whole, quote, near) {
    var best = whole.indexOf(quote);
    if (near < 0) return best;
    var at = best;
    while (at !== -1) {
      if (Math.abs(at - near) < Math.abs(best - near)) best = at;
      at = whole.indexOf(quote, at + 1);
    }
    return best;
  }

  // The page's text normalized, with each normalized position mapped back to the raw one.
  function normalizedText() {
    var index = textIndex();
    var raw = index.text;
    var map = [];
    var seenSpace = true;
    for (var i = 0; i < raw.length; i++) {
      if (/\s/.test(raw[i])) {
        if (seenSpace) continue;
        seenSpace = true;
      } else {
        seenSpace = false;
      }
      map.push(i);
    }
    return { index: index, haystack: normalize(raw), map: map };
  }

  function rangeAt(text, at, length) {
    var startRaw = text.map[at];
    var endRaw = at + length < text.map.length ? text.map[at + length - 1] + 1 : text.index.text.length;
    return rangeFor(startRaw, endRaw - startRaw, text.index.nodes);
  }

  // The best place for an anchor: the occurrence of its quote whose surrounding
  // text matches what was there when the comment was written.
  function locate(anchor) {
    if (!anchor) return null;
    var quote = normalize(anchor.quote);
    if (!quote) return byPath(anchor);
    var text = normalizedText();
    var haystack = text.haystack;
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
    return rangeAt(text, best, quote.length);
  }

  // How many of a quote's occurrences are on screen rather than in text the page hides.
  function shownCount(quote, all) {
    var text = normalizedText();
    var shown = 0;
    for (var i = 0; i < all.length; i++) {
      var range = rangeAt(text, all[i], quote.length);
      var rects = range ? range.getClientRects() : [];
      for (var r = 0; r < rects.length; r++) {
        if (rects[r].width >= 1 && rects[r].height >= 1) {
          shown += 1;
          break;
        }
      }
    }
    return shown;
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
    // Drawing runs on every scroll frame; the app only needs to hear when something changed.
    postChanged("qd:located", { found: found, missing: missing });
    postChanged("qd:scenes", { scenes: scenes() });
  }

  var lastPosted = {};
  function postChanged(type, payload) {
    var said = JSON.stringify(payload);
    if (lastPosted[type] === said) return;
    lastPosted[type] = said;
    post(type, payload);
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
    var at = occurrenceNear(whole, quote, normalizedOffset(index, range.startContainer, range.startOffset));
    var element = range.commonAncestorContainer.nodeType === 1 ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement;
    var anchor = {
      quote: quote.slice(0, QUOTE_LIMIT),
      prefix: at > 0 ? whole.slice(Math.max(0, at - CONTEXT), at) : "",
      suffix: at === -1 ? "" : whole.slice(at + quote.length, at + quote.length + CONTEXT),
      path: cssPath(element),
    };
    return { anchor: merge(anchor, placeOf(element, range.getBoundingClientRect(), whole, quote, at, {})), element: element };
  }

  function merge(into, from) {
    for (var key in from) if (Object.prototype.hasOwnProperty.call(from, key)) into[key] = from[key];
    return into;
  }

  function ownText(node) {
    for (var i = 0; i < node.childNodes.length; i++) {
      if (node.childNodes[i].nodeType === 3 && node.childNodes[i].nodeValue.trim()) return true;
    }
    return false;
  }

  // A click with no selection comments on the smallest block that holds real text.
  // A click that lands on no words of its own (a gap, a picture, padding) keeps
  // where it fell, since the block's words do not say where that was.
  function anchorFromPoint(target, event) {
    var element = target;
    while (element && element !== document.body && normalize(element.textContent).length === 0) element = element.parentElement;
    if (!element || element === document.body) return null;
    var quote = normalize(element.textContent).slice(0, QUOTE_LIMIT);
    if (!quote) return null;
    var index = textIndex();
    var whole = normalize(index.text);
    var at = occurrenceNear(whole, quote, normalizedOffset(index, element, 0));
    var anchor = {
      quote: quote,
      prefix: at > 0 ? whole.slice(Math.max(0, at - CONTEXT), at) : "",
      suffix: at === -1 ? "" : whole.slice(at + quote.length, at + quote.length + CONTEXT),
      path: cssPath(element),
    };
    var extra = { wordless: element !== target || !ownText(target), point: event ? { x: Math.round(event.pageX), y: Math.round(event.pageY) } : null };
    return { anchor: merge(anchor, placeOf(element, element.getBoundingClientRect(), whole, quote, at, extra)), element: element };
  }

  function loadLibrary() {
    if (library) return library;
    library = new Promise(function (resolve, reject) {
      if (window.snapdom && window.snapdom.toCanvas) return resolve(window.snapdom);
      var script = document.createElement("script");
      script.setAttribute("data-quarterdeck-review", "");
      script.src = new URL("/_qd/snapdom.js", location.href).href;
      script.onload = function () {
        if (window.snapdom && window.snapdom.toCanvas) resolve(window.snapdom);
        else reject(new Error("the picture library did not start"));
      };
      script.onerror = function () {
        reject(new Error("the picture library could not be loaded"));
      };
      (document.head || document.documentElement).appendChild(script);
    });
    library.catch(function () {
      library = null;
    });
    return library;
  }

  // The part of the page a picture shows: the place with some room around it,
  // inside the page, and never more than a screenful.
  function pictureRegion(box) {
    var docWidth = Math.max(document.documentElement.scrollWidth, box.x + box.w);
    var docHeight = Math.max(document.documentElement.scrollHeight, box.y + box.h);
    var w = Math.min(box.w + 2 * PICTURE_PAD, PICTURE_MAX.w, docWidth);
    var h = Math.min(box.h + 2 * PICTURE_PAD, PICTURE_MAX.h, docHeight);
    var x = Math.min(Math.max(0, box.x - PICTURE_PAD), Math.max(0, docWidth - w));
    var y = Math.min(Math.max(0, box.y - PICTURE_PAD), Math.max(0, docHeight - h));
    // A place bigger than a screenful is shown from its top left.
    if (box.w + 2 * PICTURE_PAD > PICTURE_MAX.w) x = Math.max(0, box.x - PICTURE_PAD);
    if (box.h + 2 * PICTURE_PAD > PICTURE_MAX.h) y = Math.max(0, box.y - PICTURE_PAD);
    return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
  }

  function drawPicture(element, box) {
    var started = Date.now();
    var region = pictureRegion(box);
    return loadLibrary().then(function (snapdom) {
      clearHover();
      // The whole page is drawn and then cropped: drawing only the part around the place lets it
      // lay out on its own, and the picture stops matching the page. SnapDOM draws the page as
      // scrolled, so the crop is taken from where the window was.
      var root = document.documentElement;
      var from = { x: Math.round(window.scrollX), y: Math.round(window.scrollY) };
      return snapdom.toCanvas(root, { scale: 1, dpr: 1, exclude: ["#__qd_layer__"], excludeMode: "hide" }).then(function (drawn) {
        var ratio = drawn.width / Math.max(1, root.scrollWidth);
        var crop = document.createElement("canvas");
        crop.width = region.w;
        crop.height = region.h;
        var paint = crop.getContext("2d");
        var behind = backdrop(element);
        paint.fillStyle = "rgb(" + behind.r + "," + behind.g + "," + behind.b + ")";
        paint.fillRect(0, 0, region.w, region.h);
        paint.drawImage(drawn, (region.x - from.x) * ratio, (region.y - from.y) * ratio, region.w * ratio, region.h * ratio, 0, 0, region.w, region.h);
        paint.strokeStyle = OUTLINE;
        paint.lineWidth = 2;
        paint.strokeRect(box.x - region.x - 3, box.y - region.y - 3, box.w + 6, box.h + 6);
        return { jpeg: crop.toDataURL("image/jpeg", PICTURE_QUALITY), crop: region, took_ms: Date.now() - started };
      });
    });
  }

  function picture(pick, element, box) {
    drawPicture(element, box).then(
      function (drawn) {
        post("qd:pictured", { pick: pick, jpeg: drawn.jpeg, crop: drawn.crop, took_ms: drawn.took_ms });
      },
      function (error) {
        post("qd:pictured", { pick: pick, error: String((error && error.message) || error).slice(0, 200) });
      },
    );
  }

  // The diagrams this page owns, and where they sit right now.
  function scenes() {
    var found = [];
    var marked = document.querySelectorAll("[data-quarterdeck-scene]");
    for (var i = 0; i < marked.length; i++) {
      var element = marked[i];
      var rect = element.getBoundingClientRect();
      found.push({
        id: "scene-" + i,
        file: element.getAttribute("data-quarterdeck-scene"),
        label: element.getAttribute("data-quarterdeck-scene-label") || "Diagram " + (i + 1),
        path: cssPath(element),
        rect: { top: rect.top + window.scrollY, left: rect.left + window.scrollX, width: rect.width, height: rect.height },
      });
    }
    return found;
  }

  function sceneAt(target) {
    var element = target;
    while (element && element.nodeType === 1) {
      if (element.hasAttribute && element.hasAttribute("data-quarterdeck-scene")) {
        var all = scenes();
        for (var i = 0; i < all.length; i++) {
          if (all[i].path === cssPath(element)) return all[i];
        }
      }
      element = element.parentElement;
    }
    return null;
  }

  function onClick(event) {
    if (mode !== "comment") return;
    event.preventDefault();
    event.stopPropagation();
    // A diagram the page owns is edited rather than quoted: the scene is the thing being changed.
    var scene = sceneAt(event.target);
    if (scene) {
      post("qd:scene-open", { scene: scene });
      return;
    }
    var picked = anchorFromSelection() || anchorFromPoint(event.target, event);
    if (!picked) return;
    picks += 1;
    post("qd:picked", { anchor: picked.anchor, pick: picks });
    // Drawn for every pick; the review screen keeps it only when the comment goes with a picture.
    picture(picks, picked.element, picked.anchor.box);
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

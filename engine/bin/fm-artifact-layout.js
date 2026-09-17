// fm-artifact-layout.js - in-page layout probe for bin/fm-artifact.sh.
//
// bin/fm-artifact.sh appends this script to a scratch copy of the artifact,
// loads it in headless Chrome at one window size, and reads the result back
// from the dumped DOM. After load, fonts, and a short settle, it appends
// <pre id="__fm_artifact_layout__">{"viewport":<css px>,"issues":[...]}</pre>.
// Each issue is {rule, selector, detail}. Rules are deliberately few and
// high-precision, because every finding blocks a present until the agent fixes
// it or accepts it:
//   page-scrolls-sideways  the document is wider than the viewport; the
//                          selector names the outermost element reaching
//                          furthest right.
//   text-clipped           an element clips its own text horizontally without
//                          an ellipsis or line clamp.
// Tiny (visually hidden) elements, fixed-position elements, and text inside an
// intentional horizontal scroller are ignored.
(function () {
  var MARKER = '__fm_artifact_layout__';
  var MAX_ISSUES = 20;

  function selectorOf(el) {
    var parts = [];
    var node = el;
    while (node && node.nodeType === 1 && node !== document.body && parts.length < 4) {
      var part = node.tagName.toLowerCase();
      if (node.id) {
        parts.unshift(part + '#' + node.id);
        break;
      }
      if (node.classList && node.classList.length) {
        part += '.' + Array.prototype.slice.call(node.classList, 0, 2).join('.');
      }
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.join(' > ') || el.tagName.toLowerCase();
  }

  function ownText(el) {
    for (var child = el.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === 3 && child.nodeValue.trim()) {
        return child.nodeValue.trim().replace(/\s+/g, ' ').slice(0, 60);
      }
    }
    return '';
  }

  function tiny(rect) {
    return rect.width <= 2 || rect.height <= 2;
  }

  function insideScroller(el) {
    for (var node = el.parentElement; node && node !== document.body; node = node.parentElement) {
      var overflow = getComputedStyle(node).overflowX;
      if ((overflow === 'auto' || overflow === 'scroll') && node.scrollWidth > node.clientWidth) return true;
    }
    return false;
  }

  function probe() {
    var viewport = document.documentElement.clientWidth;
    var issues = [];
    var all = document.body ? document.body.getElementsByTagName('*') : [];
    var i;

    var excess = document.documentElement.scrollWidth - viewport;
    if (excess > 1) {
      var widest = null;
      var widestRight = viewport;
      for (i = 0; i < all.length; i++) {
        var rect = all[i].getBoundingClientRect();
        if (tiny(rect) || getComputedStyle(all[i]).position === 'fixed' || insideScroller(all[i])) continue;
        if (rect.right > widestRight + 1) {
          widest = all[i];
          widestRight = rect.right;
        }
      }
      // Blame the outermost element that overflows as far: a block child
      // stretched by an over-wide parent is a symptom, not the cause.
      while (widest && widest.parentElement && widest.parentElement !== document.documentElement &&
             widest.parentElement.getBoundingClientRect().right >= widestRight - 1) {
        widest = widest.parentElement;
      }
      issues.push({
        rule: 'page-scrolls-sideways',
        selector: widest ? selectorOf(widest) : 'html',
        detail: 'the page is ' + Math.round(excess) + 'px wider than the window'
      });
    }

    for (i = 0; i < all.length && issues.length < MAX_ISSUES; i++) {
      var el = all[i];
      var text = ownText(el);
      if (!text) continue;
      var style = getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none') continue;
      if (tiny(el.getBoundingClientRect())) continue;
      var clips = style.overflowX === 'hidden' || style.overflowX === 'clip';
      var cut = el.scrollWidth - el.clientWidth;
      var clamped = style.textOverflow === 'ellipsis' || /-webkit-box/.test(style.display);
      if (clips && cut > 1 && !clamped) {
        issues.push({
          rule: 'text-clipped',
          selector: selectorOf(el),
          detail: '"' + text + '" is cut off by ' + cut + 'px'
        });
      }
    }

    var out = document.createElement('pre');
    out.id = MARKER;
    out.textContent = JSON.stringify({ viewport: viewport, issues: issues });
    document.documentElement.appendChild(out);
  }

  function settle() {
    var fonts = document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve();
    fonts.then(function () {
      setTimeout(probe, 400);
    });
  }

  if (document.readyState === 'complete') {
    settle();
  } else {
    window.addEventListener('load', settle);
  }
})();

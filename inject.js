(function() {
  var DEFAULT_PORT = 3456;
  var SIDECAR = 'http://localhost:' + DEFAULT_PORT;
  var portLoaded = false;

  // Port discovery strategy (ordered by priority):
  // 1. Global variable (set by Next.js/bundler plugin with known port)
  // 2. fetch('/__cc-port') from dev server middleware (Vite)
  // 3. Probe sidecar directly at http://localhost:${port}/__cc-port (Next.js / other)

  // Strategy 1: Check global variable
  if (typeof window !== 'undefined' && window.__CC_PROMPTER_PORT__) {
    SIDECAR = 'http://localhost:' + window.__CC_PROMPTER_PORT__;
    portLoaded = true;
  }

  // Strategy 2: Fetch from dev server middleware
  if (!portLoaded) {
    fetch('/__cc-port').then(function(r) { return r.text(); }).then(function(p) {
      if (p && parseInt(p) > 0) {
        SIDECAR = 'http://localhost:' + p;
        portLoaded = true;
      }
    }).catch(function() {
      // Strategy 3: Probe sidecar directly
      var start = window.__CC_PROMPTER_START_PORT__ || DEFAULT_PORT;
      probeSidecar(start, start + 10);
    });
  }

  function probeSidecar(port, maxPort) {
    function tryNext() {
      if (port > maxPort || portLoaded) return;
      fetch('http://localhost:' + port + '/__cc-port').then(function(r) {
        return r.text();
      }).then(function(p) {
        if (p && parseInt(p) > 0) {
          SIDECAR = 'http://localhost:' + p;
          portLoaded = true;
        } else {
          port++;
          tryNext();
        }
      }).catch(function() {
        port++;
        tryNext();
      });
    }
    tryNext();
  }
  var container = null;
  var iframe = null;
  var iframeReady = false;
  var dragBar = null;
  var resizeHandle = null;

  // Drag state
  var dragging = false;
  var dragOffsetX = 0;
  var dragOffsetY = 0;

  // Resize state
  var resizing = false;
  var resizeStartX = 0;
  var resizeStartY = 0;
  var resizeStartW = 0;
  var resizeStartH = 0;

  // Edge resize state (top/left/bottom/right)
  var edgeResizing = false;
  var edgeDir = '';
  var edgeStartX = 0;
  var edgeStartY = 0;
  var edgeStartRect = null;

  var MIN_W = 320;
  var MIN_H = 280;
  var EDGE_THRESHOLD = 6;

  function getOrCreatePanel() {
    if (container) return container;

    // Container
    container = document.createElement('div');
    container.id = 'cc-prompter-container';
    container.style.cssText =
      'position:fixed;bottom:16px;right:16px;width:480px;height:540px;' +
      'border:1px solid #e0e0e0;border-radius:10px;z-index:99999;' +
      'box-shadow:0 4px 24px rgba(0,0,0,0.10);display:none;background:#fff;' +
      'overflow:visible;';

    // Drag bar
    dragBar = document.createElement('div');
    dragBar.style.cssText =
      'height:28px;background:#fafafa;border-bottom:1px solid #ebebeb;' +
      'cursor:move;display:flex;align-items:center;justify-content:space-between;' +
      'padding:0 10px;user-select:none;border-radius:10px 10px 0 0;';
    dragBar.innerHTML =
      '<span style="font-size:11px;font-weight:600;color:#888;letter-spacing:0.3px;">CC Prompter</span>' +
      '<span style="font-size:11px;color:#bbb;" id="cc-drag-hint">drag to move</span>';

    // Iframe wrapper (holds iframe + resize handle, clips corners)
    var wrap = document.createElement('div');
    wrap.style.cssText = 'position:relative;width:100%;height:calc(100% - 28px);overflow:hidden;border-radius:0 0 10px 10px;';

    // Iframe
    iframe = document.createElement('iframe');
    iframe.id = 'cc-prompter-panel';
    iframe.src = SIDECAR + '/__panel/';
    iframe.style.cssText = 'width:100%;height:100%;border:none;';

    // Resize handle (bottom-right corner)
    resizeHandle = document.createElement('div');
    resizeHandle.style.cssText =
      'position:absolute;right:0;bottom:0;width:16px;height:16px;' +
      'cursor:nwse-resize;z-index:10;';
    // SVG grip icon
    resizeHandle.innerHTML =
      '<svg width="16" height="16" viewBox="0 0 16 16" style="opacity:0.3;">' +
      '<path d="M14 14L14 10M14 14L10 14M14 14L14 6M14 14L6 14M14 14L14 2M14 14L2 14" ' +
      'stroke="#888" stroke-width="1.2" stroke-linecap="round"/></svg>';

    wrap.appendChild(iframe);
    wrap.appendChild(resizeHandle);

    container.appendChild(dragBar);
    container.appendChild(wrap);
    document.body.appendChild(container);

    iframe.onload = function() { iframeReady = true; };

    // Drag events
    dragBar.addEventListener('mousedown', function(e) {
      dragging = true;
      var rect = container.getBoundingClientRect();
      dragOffsetX = e.clientX - rect.left;
      dragOffsetY = e.clientY - rect.top;
      container.style.transition = 'none';
      e.preventDefault();
    });

    // Hide drag hint after first drag
    dragBar.addEventListener('mousedown', function() {
      var hint = document.getElementById('cc-drag-hint');
      if (hint) setTimeout(function() { hint.style.display = 'none'; }, 2000);
    });

    // Corner resize events
    resizeHandle.addEventListener('mousedown', function(e) {
      resizing = true;
      resizeStartX = e.clientX;
      resizeStartY = e.clientY;
      resizeStartW = container.offsetWidth;
      resizeStartH = container.offsetHeight;
      container.style.transition = 'none';
      e.preventDefault();
      e.stopPropagation();
    });

    // Edge resize — detect mouse near edges of container
    container.addEventListener('mousedown', function(e) {
      if (e.target === resizeHandle || e.target.closest('#cc-prompter-panel')) return;
      var rect = container.getBoundingClientRect();
      var x = e.clientX - rect.left;
      var y = e.clientY - rect.top;
      var dir = '';

      if (x < EDGE_THRESHOLD) dir = 'w';
      else if (x > rect.width - EDGE_THRESHOLD) dir = 'e';

      if (y < EDGE_THRESHOLD) dir += 'n';
      else if (y > rect.height - EDGE_THRESHOLD) dir += 's';

      // Only edge-resize from container border, not drag bar or iframe
      if (dir && e.target === container) {
        edgeResizing = true;
        edgeDir = dir;
        edgeStartX = e.clientX;
        edgeStartY = e.clientY;
        edgeStartRect = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
        container.style.transition = 'none';
        e.preventDefault();
      }
    });

    return container;
  }

  // Global mouse handlers
  document.addEventListener('mousemove', function(e) {
    if (dragging && container) {
      var x = e.clientX - dragOffsetX;
      var y = e.clientY - dragOffsetY;
      x = Math.max(0, Math.min(x, window.innerWidth - container.offsetWidth));
      y = Math.max(0, Math.min(y, window.innerHeight - container.offsetHeight));
      container.style.left = x + 'px';
      container.style.top = y + 'px';
      container.style.right = 'auto';
      container.style.bottom = 'auto';
    }

    if (resizing && container) {
      var dw = e.clientX - resizeStartX;
      var dh = e.clientY - resizeStartY;
      var nw = Math.max(MIN_W, resizeStartW + dw);
      var nh = Math.max(MIN_H, resizeStartH + dh);
      // Clamp to viewport
      var rect = container.getBoundingClientRect();
      nw = Math.min(nw, window.innerWidth - rect.left);
      nh = Math.min(nh, window.innerHeight - rect.top);
      container.style.width = nw + 'px';
      container.style.height = nh + 'px';
    }

    if (edgeResizing && container && edgeStartRect) {
      var dx = e.clientX - edgeStartX;
      var dy = e.clientY - edgeStartY;
      var nl = edgeStartRect.left;
      var nt = edgeStartRect.top;
      var nw = edgeStartRect.width;
      var nh = edgeStartRect.height;

      if (edgeDir.indexOf('e') >= 0) {
        nw = Math.max(MIN_W, edgeStartRect.width + dx);
        nw = Math.min(nw, window.innerWidth - nl);
      }
      if (edgeDir.indexOf('w') >= 0) {
        var proposedW = edgeStartRect.width - dx;
        if (proposedW >= MIN_W && nl + dx >= 0) {
          nw = proposedW;
          nl = edgeStartRect.left + dx;
        }
      }
      if (edgeDir.indexOf('s') >= 0) {
        nh = Math.max(MIN_H, edgeStartRect.height + dy);
        nh = Math.min(nh, window.innerHeight - nt);
      }
      if (edgeDir.indexOf('n') >= 0) {
        var proposedH = edgeStartRect.height - dy;
        if (proposedH >= MIN_H && nt + dy >= 0) {
          nh = proposedH;
          nt = edgeStartRect.top + dy;
        }
      }

      container.style.left = nl + 'px';
      container.style.top = nt + 'px';
      container.style.right = 'auto';
      container.style.bottom = 'auto';
      container.style.width = nw + 'px';
      container.style.height = nh + 'px';
    }

    // Update cursor on container edges
    if (container && !dragging && !resizing && !edgeResizing) {
      var rect = container.getBoundingClientRect();
      var x = e.clientX - rect.left;
      var y = e.clientY - rect.top;
      var cursor = '';

      if (x < EDGE_THRESHOLD || x > rect.width - EDGE_THRESHOLD) {
        if (y < EDGE_THRESHOLD || y > rect.height - EDGE_THRESHOLD) {
          cursor = 'nwse-resize';
        } else {
          cursor = x < EDGE_THRESHOLD ? 'ew-resize' : 'ew-resize';
        }
      } else if (y < EDGE_THRESHOLD || y > rect.height - EDGE_THRESHOLD) {
        cursor = 'ns-resize';
      }

      if (cursor && e.target === container) {
        container.style.cursor = cursor;
      } else if (e.target === container) {
        container.style.cursor = 'default';
      }
    }
  });

  document.addEventListener('mouseup', function() {
    if (dragging) {
      dragging = false;
      if (container) container.style.transition = '';
    }
    if (resizing) {
      resizing = false;
      if (container) container.style.transition = '';
    }
    if (edgeResizing) {
      edgeResizing = false;
      edgeDir = '';
      edgeStartRect = null;
      if (container) container.style.transition = '';
    }
  });

  function showPanel(source) {
    var c = getOrCreatePanel();
    c.style.display = 'block';
    function send() {
      try {
        iframe.contentWindow.postMessage({
          type: 'cc-prompter:source-info',
          source: source
        }, SIDECAR);
      } catch(e) {
        setTimeout(send, 100);
      }
    }
    if (iframeReady) { send(); }
    else { iframe.onload = function() { iframeReady = true; send(); }; }
  }

  // Listen for hide message from iframe (Escape key)
  window.addEventListener('message', function(e) {
    if (e.data && e.data.type === 'cc-prompter:hide') {
      if (container && container.style.display !== 'none') {
        container.style.display = 'none';
      }
    }
  });

  // Track mouse for element detection
  var mx = 0, my = 0;
  document.addEventListener('mousemove', function(e) { mx = e.clientX; my = e.clientY; });

  // code-inspector click handler
  window.addEventListener('code-inspector:trackCode', function(e) {
    var d = e.detail || {};
    var el = document.elementFromPoint(mx, my);
    var info = '';
    if (el) {
      var tag = el.tagName.toLowerCase();
      var cls = (el.className && typeof el.className === 'string')
        ? el.className.replace(/\s+/g, ' ').trim().slice(0, 80) : '';
      var txt = (el.textContent || '').trim().slice(0, 50);
      info = '<' + tag
        + (el.id ? ' id="' + el.id + '"' : '')
        + (cls ? ' class="' + cls + '"' : '')
        + (txt ? ' text~"' + txt + '"' : '')
        + '>';
    }
    showPanel({
      name: d.name || '',
      path: d.path || '',
      line: d.line || 0,
      column: d.column || 0,
      elementInfo: info
    });
  });

  // Escape to hide
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') {
      if (container && container.style.display !== 'none') container.style.display = 'none';
    }
  });

  // Ctrl+Shift+P toggle
  document.addEventListener('keydown', function(e) {
    if (e.ctrlKey && e.shiftKey && e.key === 'P') {
      e.preventDefault();
      var c = getOrCreatePanel();
      c.style.display = c.style.display === 'none' ? 'block' : 'none';
    }
  });
})();

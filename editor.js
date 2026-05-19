/**
 * editor.js — Main Editor Logic (Google Docs–style)
 *
 * KEY FIXES:
 * 1. docContent = single source of truth string
 * 2. Remote cursor markers rendered as positioned overlays with name flags
 * 3. Input handler uses a MutationObserver–free approach: we read textContent
 *    EXCLUDING any remote-cursor marker DOM to avoid "phantom text" injection
 * 4. syncDomFromDocContent first strips cursors, sets text, re-inserts cursors
 * 5. Share link uses the actual joined docId, not the stale input value
 */
'use strict';

// ─── Single Source of Truth ────────────────────────────────────────────────────
let docContent = '';   // mirrors server's document content exactly
let lastContent = '';  // last content seen by input handler (== docContent)

// ─── State ─────────────────────────────────────────────────────────────────────
let ws = null;
let otClient = null;
let myClientId = null;
let myColor = '#1a73e8';
let myUsername = '';
let myDocId = '';
let isConnected = false;
let suppressDepth = 0;
let latency = 0;
let lastPingSent = 0;

const userColors = new Map();
const remoteCursors = new Map(); // clientId → { pos, color, username, el }

const myStyles = {
  fontName: 'Roboto',
  fontSize: '3',
  foreColor: '#000000',
  hiliteColor: 'transparent',
  bold: false,
  italic: false,
  underline: false,
  strikeThrough: false
};

let isEnforcing = false;
document.addEventListener('selectionchange', () => {
  if (isSuppressed() || isEnforcing) return;
  if (document.activeElement !== editorEl) return;
  const sel = window.getSelection();
  if (!sel || !sel.isCollapsed) return;

  isEnforcing = true;
  
  if (document.queryCommandValue('fontName').replace(/['"]/g, '') !== myStyles.fontName) {
    document.execCommand('fontName', false, myStyles.fontName);
  }
  if (document.queryCommandValue('fontSize') !== myStyles.fontSize) {
    document.execCommand('fontSize', false, myStyles.fontSize);
  }
  
  document.execCommand('foreColor', false, myStyles.foreColor);
  
  if (myStyles.hiliteColor !== 'transparent') {
    document.execCommand('hiliteColor', false, myStyles.hiliteColor);
  }

  if (document.queryCommandState('bold') !== myStyles.bold) {
    document.execCommand('bold', false, null);
  }
  if (document.queryCommandState('italic') !== myStyles.italic) {
    document.execCommand('italic', false, null);
  }
  if (document.queryCommandState('underline') !== myStyles.underline) {
    document.execCommand('underline', false, null);
  }
  if (document.queryCommandState('strikeThrough') !== myStyles.strikeThrough) {
    document.execCommand('strikeThrough', false, null);
  }
  
  isEnforcing = false;
});

// ─── DOM References ────────────────────────────────────────────────────────────
const editorEl       = document.getElementById('editor');
const cursorOverlay  = document.getElementById('cursor-overlay');
const statusDot      = document.getElementById('status-dot');
const statusText     = document.getElementById('status-text');
const latencyEl      = document.getElementById('latency');
const presenceContainer = document.getElementById('presence-container');
const versionPanel   = document.getElementById('version-panel');
const versionList    = document.getElementById('version-list');
const wordCountEl    = document.getElementById('word-count');
const charCountEl    = document.getElementById('char-count');
const saveIndicator  = document.getElementById('save-indicator');
const docTitle       = document.getElementById('doc-title');
const joinModal      = document.getElementById('join-modal');
const joinBtn        = document.getElementById('join-btn');
const usernameInput  = document.getElementById('username-input');
const roomInput      = document.getElementById('room-input');
const connectionBanner = document.getElementById('connection-banner');
const toastContainer = document.getElementById('toast-container');
const collaboratorsCount = document.getElementById('collaborators-count');

// ─── Suppress helpers ──────────────────────────────────────────────────────────
function beginSuppress() { suppressDepth++; }
function endSuppress()   { suppressDepth = Math.max(0, suppressDepth - 1); }
function isSuppressed()  { return suppressDepth > 0; }

// ─── Toast Notifications ───────────────────────────────────────────────────────
function showToast(message, type = 'info', duration = 3000) {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `
    <span class="toast-icon">${type === 'success' ? '✓' : type === 'error' ? '✗' : type === 'warning' ? '⚠' : 'ℹ'}</span>
    <span>${message}</span>
  `;
  toastContainer.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('show'));
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

// ─── WebSocket Connection ──────────────────────────────────────────────────────
function connect(username, docId) {
  myUsername = username;
  myDocId = docId;

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${location.host}`;

  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    isConnected = true;
    setStatus('connected');
    ws.send(JSON.stringify({ type: 'join', username, docId }));
    startPing();
    showToast('Connected to server', 'success');
  };

  ws.onclose = () => {
    isConnected = false;
    setStatus('disconnected');
    connectionBanner.classList.add('show');
    showToast('Disconnected. Reconnecting...', 'error');
    setTimeout(() => connect(myUsername, myDocId), 3000);
  };

  ws.onerror = (err) => {
    console.error('WS error:', err);
    setStatus('error');
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      handleServerMessage(msg);
    } catch (e) {
      console.error('Parse error:', e);
    }
  };
}

// ─── Server Message Handler ────────────────────────────────────────────────────
function handleServerMessage(msg) {
  switch (msg.type) {
    case 'init':         handleInit(msg); break;
    case 'op':           handleRemoteOp(msg); break;
    case 'ack':          otClient?.handleAck(msg.opId, msg.serverRevision); updateSaveIndicator(); break;
    case 'cursor':       renderRemoteCursor(msg); break;
    case 'presence:join':  handlePresenceJoin(msg); break;
    case 'presence:leave': handlePresenceLeave(msg); break;
    case 'versionHistory': renderVersionHistory(msg.versions); break;
    case 'restore':      handleRestore(msg); break;
    case 'pong':
      latency = Date.now() - lastPingSent;
      latencyEl.textContent = `${latency}ms`;
      break;
    case 'format':       handleRemoteFormat(msg); break;
    case 'request-html-sync': {
      const clone = editorEl.cloneNode(true);
      clone.querySelectorAll('.remote-cursor, .remote-cursor-marker').forEach(c => c.remove());
      ws.send(JSON.stringify({ type: 'html-sync', targetClientId: msg.targetClientId, html: clone.innerHTML }));
      break;
    }
    case 'apply-html-sync': {
      beginSuppress();
      try {
        const caretPos = getCaretOffset();
        editorEl.innerHTML = msg.html;
        try { setCaretOffset(Math.min(caretPos, docContent.length)); } catch {}
        requestAnimationFrame(() => refreshAllRemoteCursors());
      } finally {
        endSuppress();
      }
      break;
    }
    case 'error': showToast(msg.message, 'error'); break;
  }
}

function handleInit(msg) {
  myClientId = msg.clientId;
  myColor = msg.color;
  myUsername = msg.username;
  docContent = msg.content;
  lastContent = msg.content;

  // Init OT client
  otClient = new OTClient(
    (remoteOp) => applyRemoteOp(remoteOp),
    (op, opId) => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'op', op, opId, revision: otClient.revision }));
      }
    }
  );
  otClient.revision = msg.revision;
  otClient.clientId = myClientId;

  // Set initial content from server — this is ground truth
  beginSuppress();
  if (msg.html) {
    editorEl.innerHTML = msg.html;
  } else {
    editorEl.textContent = msg.content;
  }
  endSuppress();

  // Render presence
  renderAllPresence(msg.presence);
  renderVersionHistory(msg.versionHistory || []);

  // Render Instance ID (System Design Showcase)
  const instanceBadge = document.getElementById('instance-badge');
  if (instanceBadge && msg.instanceId) {
    instanceBadge.textContent = `Node ID: ${msg.instanceId}`;
    instanceBadge.style.display = 'inline-block';
  }

  connectionBanner.classList.remove('show');
  updateCounts();
  showToast(`Joined as ${msg.username}`, 'success');
}

function handleRemoteOp(msg) {
  otClient?.handleRemoteOp(msg.op, msg.serverRevision);
}

function applyRemoteOp(op) {
  if (op.type === 'restore') {
    setDocContent(op.content);
    showToast('Document restored to a previous version', 'warning');
    return;
  }

  // 1. Save local caret
  const savedCursor = getCaretOffset();

  // 2. Apply to docContent string model
  if (op.type === 'insert') {
    const pos = Math.min(op.pos, docContent.length);
    docContent = docContent.slice(0, pos) + op.text + docContent.slice(pos);
    // Surgically insert into DOM (preserves formatting)
    beginSuppress();
    insertTextInDom(pos, op.text);
    // Apply formats that the remote user had when typing
    if (op.formats) {
      for (const [cmd, value] of Object.entries(op.formats)) {
        if (value) applyFormatToDOM(pos, pos + op.text.length, cmd, value === true ? null : value);
      }
    }
    endSuppress();
  } else if (op.type === 'delete') {
    const pos = Math.min(op.pos, docContent.length);
    const len = Math.min(op.len, docContent.length - pos);
    docContent = docContent.slice(0, pos) + docContent.slice(pos + len);
    // Surgically delete from DOM (preserves formatting)
    beginSuppress();
    deleteTextInDom(pos, len);
    endSuppress();
  }

  // 3. Sync lastContent (prevent phantom ops)
  lastContent = docContent;

  // 4. Restore cursor adjusted for this op
  try {
    const newCursor = adjustCursor(savedCursor, op);
    setCaretOffset(newCursor);
  } catch {}

  // 5. Re-position remote cursors
  requestAnimationFrame(() => refreshAllRemoteCursors());

  updateCounts();
  flashUser(op.clientId);
}

function handleRestore(msg) {
  otClient?.handleRestore(msg.content, msg.revision);
  showToast(`Document restored by ${msg.restoredBy}`, 'warning');
}

// ─── Document Content Management ───────────────────────────────────────────────
function setDocContent(text) {
  docContent = text;
  lastContent = text;
  syncDomFromDocContent(text);
  updateCounts();
}

/**
 * Full DOM replace — used ONLY for initial load and restore.
 * For remote ops, we use surgical insert/delete to preserve formatting.
 */
function syncDomFromDocContent(text) {
  beginSuppress();
  try {
    const caretPos = getCaretOffset();
    editorEl.textContent = text;
    try {
      setCaretOffset(Math.min(caretPos, text.length));
    } catch {}
    requestAnimationFrame(() => refreshAllRemoteCursors());
  } finally {
    endSuppress();
  }
}

// ─── Surgical DOM Operations (preserve formatting) ─────────────────────────────
/**
 * Collect all text nodes in the editor, skipping remote cursor elements.
 */
function getTextNodes() {
  const nodes = [];
  function walk(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      if (!isInsideRemoteCursor(node)) nodes.push(node);
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      if (node.classList && node.classList.contains('remote-cursor')) return;
      for (const child of node.childNodes) walk(child);
    }
  }
  walk(editorEl);
  return nodes;
}

/**
 * Insert text at a character offset without destroying DOM formatting.
 */
function insertTextInDom(pos, text) {
  const textNodes = getTextNodes();
  let currentOffset = 0;
  for (const node of textNodes) {
    const len = node.textContent.length;
    if (currentOffset + len >= pos) {
      const localOffset = pos - currentOffset;
      node.textContent = node.textContent.slice(0, localOffset) + text + node.textContent.slice(localOffset);
      return;
    }
    currentOffset += len;
  }
  // pos is at or beyond end
  if (textNodes.length > 0) {
    const last = textNodes[textNodes.length - 1];
    last.textContent += text;
  } else {
    editorEl.appendChild(document.createTextNode(text));
  }
}

/**
 * Delete `len` characters starting at `pos` without destroying DOM formatting.
 */
function deleteTextInDom(pos, len) {
  const textNodes = getTextNodes();
  let currentOffset = 0;
  const deleteEnd = pos + len;
  for (const node of textNodes) {
    const nodeLen = node.textContent.length;
    const nodeStart = currentOffset;
    const nodeEnd = currentOffset + nodeLen;
    currentOffset = nodeEnd;
    if (nodeEnd <= pos || nodeStart >= deleteEnd) continue;
    const overlapStart = Math.max(pos, nodeStart) - nodeStart;
    const overlapEnd = Math.min(deleteEnd, nodeEnd) - nodeStart;
    node.textContent = node.textContent.slice(0, overlapStart) + node.textContent.slice(overlapEnd);
  }
}

// ─── Format Operation Syncing ──────────────────────────────────────────────────
/**
 * Get the current selection as character offsets { start, end }.
 */
function getSelectionOffsets() {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return { start: 0, end: 0 };
  const range = sel.getRangeAt(0);
  function charOffsetTo(container, offset) {
    let count = 0;
    function walk(node) {
      if (node === container) {
        if (node.nodeType === Node.TEXT_NODE) count += offset;
        return true;
      }
      if (node.nodeType === Node.TEXT_NODE) {
        if (!isInsideRemoteCursor(node)) count += node.textContent.length;
        return false;
      }
      if (node.nodeType === Node.ELEMENT_NODE) {
        if (node.classList && node.classList.contains('remote-cursor')) return false;
        for (const child of node.childNodes) { if (walk(child)) return true; }
      }
      return false;
    }
    walk(editorEl);
    return count;
  }
  return {
    start: charOffsetTo(range.startContainer, range.startOffset),
    end: charOffsetTo(range.endContainer, range.endOffset)
  };
}

/**
 * Select a character range in the editor.
 */
function selectRange(start, end) {
  const sel = window.getSelection();
  const range = document.createRange();
  const textNodes = getTextNodes();
  let currentOffset = 0;
  let startNode = null, startOff = 0, endNode = null, endOff = 0;
  for (const node of textNodes) {
    const len = node.textContent.length;
    if (!startNode && currentOffset + len >= start) {
      startNode = node;
      startOff = start - currentOffset;
    }
    if (!endNode && currentOffset + len >= end) {
      endNode = node;
      endOff = end - currentOffset;
    }
    currentOffset += len;
    if (startNode && endNode) break;
  }
  if (startNode && endNode) {
    range.setStart(startNode, Math.min(startOff, startNode.textContent.length));
    range.setEnd(endNode, Math.min(endOff, endNode.textContent.length));
    sel.removeAllRanges();
    sel.addRange(range);
  }
}

/**
 * Extract formatting at a specific text position by walking up its DOM parents.
 */
function getFormattingAt(pos) {
  const textNodes = getTextNodes();
  let currentOffset = 0;
  let targetNode = null;
  for (const node of textNodes) {
    const len = node.textContent.length;
    if (currentOffset + len > pos) {
      targetNode = node;
      break;
    }
    currentOffset += len;
  }
  if (!targetNode) return {};

  const formats = {};
  let el = targetNode.parentNode;
  while (el && el !== editorEl) {
    if (el.tagName === 'B' || el.tagName === 'STRONG') formats.bold = true;
    if (el.tagName === 'I' || el.tagName === 'EM') formats.italic = true;
    if (el.tagName === 'U') formats.underline = true;
    if (el.tagName === 'S' || el.tagName === 'STRIKE') formats.strikeThrough = true;
    
    // Check inline styles (prioritize inner tags)
    if (!formats.fontName && el.style.fontFamily) formats.fontName = el.style.fontFamily;
    if (!formats.fontSize && el.style.fontSize) formats.fontSize = el.style.fontSize;
    if (!formats.foreColor && el.style.color) formats.foreColor = el.style.color;
    if (!formats.hiliteColor && el.style.backgroundColor) formats.hiliteColor = el.style.backgroundColor;
    
    // Check legacy tags from execCommand
    if (el.tagName === 'FONT') {
      if (!formats.fontName && el.face) formats.fontName = el.face;
      if (!formats.foreColor && el.color) formats.foreColor = el.color;
      if (!formats.fontSize && el.size) formats.fontSize = el.size;
    }
    el = el.parentNode;
  }
  return formats;
}

/**
 * Send a format operation to the server for broadcasting.
 */
function sendFormatOp(cmd, value) {
  if (!ws || !isConnected) return;
  const { start, end } = getSelectionOffsets();
  if (start === end && cmd !== 'formatBlock') return; // no selection for inline formats
  ws.send(JSON.stringify({ type: 'format', cmd, value, start, end }));
}

/**
 * Apply a remote format operation via direct DOM manipulation.
 */
function handleRemoteFormat(msg) {
  if (msg.clientId === myClientId) return;
  beginSuppress();
  try {
    applyFormatToDOM(msg.start, msg.end, msg.cmd, msg.value);
  } finally {
    endSuppress();
  }
}

/**
 * Directly wrap text nodes in formatting elements for a character range.
 */
function applyFormatToDOM(rangeStart, rangeEnd, cmd, value) {
  if (['formatBlock','insertUnorderedList','insertOrderedList',
       'justifyLeft','justifyCenter','justifyRight','removeFormat'].includes(cmd)) {
    try {
      editorEl.focus();
      selectRange(rangeStart, rangeEnd);
      document.execCommand(cmd, false, value || null);
    } catch {}
    return;
  }

  const textNodes = getTextNodes();
  let currentOffset = 0;
  const segments = [];

  for (const node of textNodes) {
    const nodeLen = node.textContent.length;
    const nodeStart = currentOffset;
    const nodeEnd = currentOffset + nodeLen;
    currentOffset = nodeEnd;
    if (nodeEnd <= rangeStart || nodeStart >= rangeEnd) continue;
    const localStart = Math.max(rangeStart, nodeStart) - nodeStart;
    const localEnd = Math.min(rangeEnd, nodeEnd) - nodeStart;
    segments.push({ node, localStart, localEnd });
  }

  // Process in reverse so earlier node positions stay valid
  for (let i = segments.length - 1; i >= 0; i--) {
    const { node, localStart, localEnd } = segments[i];
    let targetNode = node;
    // Split from end first, then start
    if (localEnd < node.textContent.length) {
      node.splitText(localEnd);
    }
    if (localStart > 0) {
      targetNode = node.splitText(localStart);
    }
    const wrapper = createFormatElement(cmd, value);
    if (wrapper) {
      targetNode.parentNode.insertBefore(wrapper, targetNode);
      wrapper.appendChild(targetNode);
    }
  }
}

/**
 * Create a DOM element for a given formatting command.
 */
function createFormatElement(cmd, value) {
  let el;
  switch (cmd) {
    case 'bold':          el = document.createElement('strong'); return el;
    case 'italic':        el = document.createElement('em'); return el;
    case 'underline':     el = document.createElement('u'); return el;
    case 'strikeThrough': el = document.createElement('s'); return el;
    case 'foreColor':
      el = document.createElement('span');
      el.style.color = value;
      return el;
    case 'hiliteColor':
      el = document.createElement('span');
      el.style.backgroundColor = value;
      return el;
    case 'fontName':
      el = document.createElement('span');
      el.style.fontFamily = value;
      return el;
    case 'fontSize': {
      const sizeMap = {'1':'10px','2':'13px','3':'16px','4':'18px','5':'24px','6':'32px','7':'48px'};
      el = document.createElement('span');
      el.style.fontSize = sizeMap[String(value)] || '16px';
      return el;
    }
    default: return null;
  }
}

// ─── Read Editor Text (cursor-marker safe) ────────────────────────────────────
/**
 * Read the plain text from the editor, ignoring any remote-cursor marker
 * elements that might be injected into the DOM.
 * This prevents "phantom text" from cursor labels leaking into the diff.
 */
function readEditorText() {
  // Walk text nodes only, skip .remote-cursor-marker elements
  let text = '';
  function walk(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent;
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      // Skip cursor marker elements entirely
      if (node.classList && node.classList.contains('remote-cursor-marker')) return;
      for (const child of node.childNodes) {
        walk(child);
      }
    }
  }
  walk(editorEl);
  return text;
}

// ─── Editor Events → OT Ops ────────────────────────────────────────────────────
editorEl.addEventListener('input', handleEditorInput);
editorEl.addEventListener('keydown', handleKeyDown);
editorEl.addEventListener('mouseup', sendCursor);
editorEl.addEventListener('keyup', sendCursor);

function handleEditorInput() {
  if (isSuppressed() || !otClient) return;

  // Read what the user actually typed from the DOM (excluding cursor markers)
  const newContent = readEditorText();

  // Diff against our known-good docContent
  const ops = diffToOps(lastContent, newContent);
  if (ops.length === 0) return;

  // Apply each op to docContent immediately (keep it in sync)
  for (const op of ops) {
    if (op.type === 'insert') {
      op.formats = getFormattingAt(op.pos); // Attach current DOM formats to the insert op
      const pos = Math.min(op.pos, docContent.length);
      docContent = docContent.slice(0, pos) + op.text + docContent.slice(pos);
    } else if (op.type === 'delete') {
      const pos = Math.min(op.pos, docContent.length);
      const len = Math.min(op.len, docContent.length - pos);
      docContent = docContent.slice(0, pos) + docContent.slice(pos + len);
    }
    otClient.submitOp(op);
  }

  // Keep lastContent in sync with docContent
  lastContent = docContent;

  updateCounts();
  scheduleSaveSnapshot();
}

function handleKeyDown(e) {
  if (e.key === 'Tab') {
    e.preventDefault();
    const pos = getCaretOffset();
    const spaces = '    ';
    docContent = docContent.slice(0, pos) + spaces + docContent.slice(pos);
    lastContent = docContent;
    syncDomFromDocContent(docContent);
    setCaretOffset(pos + spaces.length);
    if (otClient) otClient.submitOp({ type: 'insert', pos, text: spaces });
  }
}

// ─── Diff → Ops ────────────────────────────────────────────────────────────────
function diffToOps(oldStr, newStr) {
  if (oldStr === newStr) return [];

  let prefixLen = 0;
  const minLen = Math.min(oldStr.length, newStr.length);
  while (prefixLen < minLen && oldStr[prefixLen] === newStr[prefixLen]) {
    prefixLen++;
  }

  let oldSuffixStart = oldStr.length;
  let newSuffixStart = newStr.length;
  while (
    oldSuffixStart > prefixLen &&
    newSuffixStart > prefixLen &&
    oldStr[oldSuffixStart - 1] === newStr[newSuffixStart - 1]
  ) {
    oldSuffixStart--;
    newSuffixStart--;
  }

  const deletedText = oldStr.slice(prefixLen, oldSuffixStart);
  const insertedText = newStr.slice(prefixLen, newSuffixStart);

  const ops = [];
  if (deletedText.length > 0) {
    ops.push({ type: 'delete', pos: prefixLen, len: deletedText.length });
  }
  if (insertedText.length > 0) {
    ops.push({ type: 'insert', pos: prefixLen, text: insertedText });
  }

  return ops;
}

// ─── Cursor Tracking ───────────────────────────────────────────────────────────
function sendCursor() {
  if (!ws || !isConnected) return;
  const cursor = getCaretOffset();
  ws.send(JSON.stringify({ type: 'cursor', cursor }));
}

/**
 * Render a remote user's cursor as a positioned overlay within the editor.
 */
function renderRemoteCursor(msg) {
  if (msg.clientId === myClientId) return;

  const color = msg.color || '#1a73e8';
  const username = msg.username || 'User';
  const cursorPos = msg.cursor;

  userColors.set(msg.clientId, color);

  // Store cursor data
  let cursorData = remoteCursors.get(msg.clientId);
  if (!cursorData) {
    // Create the cursor overlay element
    const el = document.createElement('div');
    el.className = 'remote-cursor';
    el.setAttribute('data-cursor-client', msg.clientId);
    el.innerHTML = `
      <div class="remote-cursor-line" style="background:${color}"></div>
      <div class="remote-cursor-flag" style="background:${color}">${escapeHtml(username)}</div>
    `;
    cursorOverlay.appendChild(el);
    cursorData = { pos: cursorPos, color, username, el };
    remoteCursors.set(msg.clientId, cursorData);
  } else {
    cursorData.pos = cursorPos;
    cursorData.color = color;
  }

  // Position the cursor overlay
  positionRemoteCursor(msg.clientId, cursorPos);

  // Auto-hide the flag after a few seconds of inactivity
  clearTimeout(cursorData._hideTimer);
  const flag = cursorData.el.querySelector('.remote-cursor-flag');
  if (flag) {
    flag.style.opacity = '1';
    cursorData._hideTimer = setTimeout(() => {
      flag.style.opacity = '0';
      flag.style.transition = 'opacity 0.5s ease';
    }, 4000);
  }
}

/**
 * Position a remote cursor overlay at a character offset within the editor.
 */
function positionRemoteCursor(clientId, charOffset) {
  const cursorData = remoteCursors.get(clientId);
  if (!cursorData || !cursorData.el) return;

  // Create a temporary range at the offset
  const pos = Math.min(charOffset, docContent.length);

  try {
    // Find the text node and offset at the given character position
    let currentOffset = 0;
    let targetNode = null;
    let targetOffset = 0;

    function findPosition(node) {
      if (targetNode) return;
      if (node.nodeType === Node.TEXT_NODE) {
        const len = node.textContent.length;
        if (currentOffset + len >= pos) {
          targetNode = node;
          targetOffset = pos - currentOffset;
          return;
        }
        currentOffset += len;
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        if (node.classList && node.classList.contains('remote-cursor')) return;
        for (const child of node.childNodes) {
          findPosition(child);
          if (targetNode) return;
        }
      }
    }

    findPosition(editorEl);

    if (targetNode) {
      const range = document.createRange();
      range.setStart(targetNode, Math.min(targetOffset, targetNode.textContent.length));
      range.collapse(true);
      const rect = range.getBoundingClientRect();
      const editorRect = cursorOverlay.getBoundingClientRect();

      cursorData.el.style.left = (rect.left - editorRect.left) + 'px';
      cursorData.el.style.top = (rect.top - editorRect.top) + 'px';
      cursorData.el.style.height = rect.height + 'px';
      cursorData.el.style.display = 'block';
    } else {
      // Fallback: position at end of editor
      cursorData.el.style.display = 'none';
    }
  } catch (e) {
    // Silently fail
  }
}

/**
 * Remove a remote cursor when a user leaves.
 */
function removeRemoteCursor(clientId) {
  const cursorData = remoteCursors.get(clientId);
  if (cursorData && cursorData.el) {
    cursorData.el.remove();
  }
  remoteCursors.delete(clientId);
}

/**
 * Re-position all remote cursors (e.g. after DOM content change).
 */
function refreshAllRemoteCursors() {
  for (const [clientId, data] of remoteCursors) {
    positionRemoteCursor(clientId, data.pos);
  }
}

// ─── Presence ─────────────────────────────────────────────────────────────────
function renderAllPresence(presenceList) {
  presenceContainer.innerHTML = '';
  collaboratorsCount.textContent = presenceList.length;
  for (const user of presenceList) addPresenceBadge(user);
}

function handlePresenceJoin(msg) {
  addPresenceBadge({ clientId: msg.clientId, username: msg.username, color: msg.color });
  collaboratorsCount.textContent = msg.presence.length;
  showToast(`${msg.username} joined`, 'info', 2000);
}

function handlePresenceLeave(msg) {
  const badge = document.querySelector(`[data-client="${msg.clientId}"]`);
  if (badge) {
    badge.style.animation = 'badgePop 0.25s reverse';
    setTimeout(() => badge.remove(), 250);
  }
  // Remove remote cursor
  removeRemoteCursor(msg.clientId);

  collaboratorsCount.textContent = msg.presence ? msg.presence.length :
    document.querySelectorAll('.presence-badge').length - 1;
  showToast(`${msg.username} left`, 'info', 2000);
}

function addPresenceBadge(user) {
  if (document.querySelector(`[data-client="${user.clientId}"]`)) return;
  const badge = document.createElement('div');
  badge.className = 'presence-badge';
  badge.setAttribute('data-client', user.clientId);
  badge.setAttribute('title', user.username);
  badge.style.background = user.color;
  badge.style.borderColor = user.color;
  badge.textContent = user.username.charAt(0).toUpperCase();
  if (user.clientId === myClientId) {
    badge.classList.add('me');
    badge.setAttribute('title', user.username + ' (you)');
  }
  presenceContainer.appendChild(badge);
  userColors.set(user.clientId, user.color);
}

function flashUser(clientId) {
  const badge = document.querySelector(`[data-client="${clientId}"]`);
  if (badge) {
    badge.classList.remove('typing');
    void badge.offsetWidth;
    badge.classList.add('typing');
    setTimeout(() => badge.classList.remove('typing'), 1000);
  }
}

// ─── Version History ───────────────────────────────────────────────────────────
function renderVersionHistory(versions) {
  if (!versions || !versionList) return;
  versionList.innerHTML = '';
  const sorted = [...versions].reverse();
  for (const v of sorted) {
    const item = document.createElement('div');
    item.className = 'version-item';
    const date = new Date(v.timestamp);
    const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const dateStr = date.toLocaleDateString([], { month: 'short', day: 'numeric' });
    item.innerHTML = `
      <div class="version-meta">
        <span class="version-label">${escapeHtml(v.label)}</span>
        <span class="version-time">${dateStr} ${timeStr}</span>
      </div>
      <div class="version-stats">
        <span class="version-words">${v.wordCount} words</span>
        <span class="version-rev">Rev ${v.revision}</span>
      </div>
      <button class="version-restore-btn" onclick="restoreVersion('${v.id}')">
        Restore this version
      </button>
    `;
    versionList.appendChild(item);
  }
}

function restoreVersion(versionId) {
  if (!confirm('Restore this version? Current changes will be overwritten.')) return;
  ws.send(JSON.stringify({ type: 'restoreVersion', versionId }));
}
window.restoreVersion = restoreVersion;

function toggleVersionPanel() {
  versionPanel.classList.toggle('open');
  if (versionPanel.classList.contains('open')) {
    ws.send(JSON.stringify({ type: 'getVersionHistory' }));
  }
}

// ─── Toolbar Commands ──────────────────────────────────────────────────────────
function execFormat(cmd) {
  if (['bold', 'italic', 'underline', 'strikeThrough'].includes(cmd)) {
    myStyles[cmd] = !myStyles[cmd];
  }
  editorEl.focus();
  document.execCommand(cmd, false, null);
  if (cmd !== 'undo' && cmd !== 'redo') {
    sendFormatOp(cmd, null);
  }
}

function setHeading(level) {
  editorEl.focus();
  document.execCommand('formatBlock', false, level);
  sendFormatOp('formatBlock', level);
}

function saveSnapshot() {
  const label = prompt('Enter a name for this version:', `Snapshot ${new Date().toLocaleTimeString()}`);
  if (label !== null && ws) {
    ws.send(JSON.stringify({ type: 'saveSnapshot', label }));
    showToast('Version saved!', 'success');
  }
}

// ─── Font Family ────────────────────────────────────────────────────────────────
function setFontFamily(fontName) {
  myStyles.fontName = fontName;
  editorEl.focus();
  document.execCommand('fontName', false, fontName);
  sendFormatOp('fontName', fontName);
}

// Style the font dropdown options so each font previews itself
(function styleFontOptions() {
  const fontSelect = document.getElementById('font-select');
  if (!fontSelect) return;
  for (const opt of fontSelect.options) {
    opt.style.fontFamily = opt.value + ', sans-serif';
  }
})();

// ─── Font Size ──────────────────────────────────────────────────────────────────
function setFontSize(size) {
  myStyles.fontSize = size;
  editorEl.focus();
  document.execCommand('fontSize', false, size);
  sendFormatOp('fontSize', size);
}

// ─── Text Color ─────────────────────────────────────────────────────────────────
const TEXT_COLOR_SWATCHES = [
  // Row 1: blacks/greys
  '#000000', '#434343', '#666666', '#999999', '#b7b7b7', '#cccccc', '#d9d9d9', '#efefef', '#f3f3f3', '#ffffff',
  // Row 2: vivid colors
  '#980000', '#ff0000', '#ff9900', '#ffff00', '#00ff00', '#00ffff', '#4a86e8', '#0000ff', '#9900ff', '#ff00ff',
  // Row 3: muted pastels
  '#e6b8af', '#f4cccc', '#fce5cd', '#fff2cc', '#d9ead3', '#d0e0e3', '#c9daf8', '#cfe2f3', '#d9d2e9', '#ead1dc',
  // Row 4: deeper tones
  '#dd7e6b', '#ea9999', '#f9cb9c', '#ffe599', '#b6d7a8', '#a2c4c9', '#a4c2f4', '#9fc5e8', '#b4a7d6', '#d5a6bd',
  // Row 5: rich darks
  '#cc4125', '#e06666', '#f6b26b', '#ffd966', '#93c47d', '#76a5af', '#6d9eeb', '#6fa8dc', '#8e7cc3', '#c27ba0',
  // Row 6: deep darks
  '#a61c00', '#cc0000', '#e69138', '#f1c232', '#6aa84f', '#45818e', '#3c78d8', '#3d85c6', '#674ea7', '#a64d79',
];

const HIGHLIGHT_COLOR_SWATCHES = [
  '#ffff00', '#00ff00', '#00ffff', '#ff00ff', '#ff0000', '#0000ff',
  '#fcf3cf', '#d5f5e3', '#d6eaf8', '#fadbd8', '#e8daef', '#fdebd0',
  '#f9e79f', '#abebc6', '#aed6f1', '#f5b7b1', '#d2b4de', '#fad7a0',
  '#f4d03f', '#58d68d', '#5dade2', '#ec7063', '#af7ac5', '#f0b27a',
  '#f39c12', '#27ae60', '#2e86c1', '#e74c3c', '#8e44ad', '#e67e22',
  '#ffffff', '#f2f3f4', '#d5d8dc', '#aab7b8', '#808b96', '#2c3e50',
];

let activeColorPicker = null; // 'text' | 'highlight' | null
let currentTextColor = '#000000';
let currentHighlightColor = '#ffff00';

// Build swatch grids
function buildSwatches(containerId, swatches, onPick) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = '';
  for (const color of swatches) {
    const swatch = document.createElement('button');
    swatch.className = 'color-swatch';
    swatch.style.background = color;
    swatch.title = color;
    if (color === '#ffffff' || color === '#efefef' || color === '#f3f3f3') {
      swatch.style.border = '1px solid var(--border)';
    }
    swatch.addEventListener('click', (e) => {
      e.stopPropagation();
      onPick(color);
    });
    container.appendChild(swatch);
  }
}

function toggleColorPicker(which) {
  const textPicker = document.getElementById('text-color-picker');
  const highlightPicker = document.getElementById('highlight-color-picker');

  if (which === 'text') {
    if (activeColorPicker === 'text') {
      textPicker.classList.remove('open');
      activeColorPicker = null;
    } else {
      textPicker.classList.add('open');
      highlightPicker.classList.remove('open');
      activeColorPicker = 'text';
    }
  } else {
    if (activeColorPicker === 'highlight') {
      highlightPicker.classList.remove('open');
      activeColorPicker = null;
    } else {
      highlightPicker.classList.add('open');
      textPicker.classList.remove('open');
      activeColorPicker = 'highlight';
    }
  }
}

function applyTextColor(color) {
  myStyles.foreColor = color;
  currentTextColor = color;
  editorEl.focus();
  document.execCommand('foreColor', false, color);
  sendFormatOp('foreColor', color);
  const bar = document.getElementById('text-color-bar');
  if (bar) bar.style.background = color;
  closeAllColorPickers();
}

function applyHighlightColor(color) {
  myStyles.hiliteColor = color;
  currentHighlightColor = color;
  editorEl.focus();
  document.execCommand('hiliteColor', false, color);
  sendFormatOp('hiliteColor', color);
  const bar = document.getElementById('highlight-color-bar');
  if (bar) bar.style.background = color;
  closeAllColorPickers();
}

function resetTextColor() {
  myStyles.foreColor = '#000000';
  editorEl.focus();
  document.execCommand('foreColor', false, '#000000');
  sendFormatOp('foreColor', '#000000');
  currentTextColor = '#000000';
  const bar = document.getElementById('text-color-bar');
  if (bar) bar.style.background = '#000000';
  closeAllColorPickers();
}

function resetHighlightColor() {
  myStyles.hiliteColor = 'transparent';
  editorEl.focus();
  document.execCommand('removeFormat', false, null);
  sendFormatOp('removeFormat', null);
  currentHighlightColor = 'transparent';
  const bar = document.getElementById('highlight-color-bar');
  if (bar) bar.style.background = 'transparent';
  closeAllColorPickers();
}

function closeAllColorPickers() {
  document.getElementById('text-color-picker')?.classList.remove('open');
  document.getElementById('highlight-color-picker')?.classList.remove('open');
  activeColorPicker = null;
}

// Close color pickers when clicking outside
document.addEventListener('click', (e) => {
  if (activeColorPicker && !e.target.closest('.tb-color-wrapper')) {
    closeAllColorPickers();
  }
});

// Initialize swatches on load
buildSwatches('text-swatches', TEXT_COLOR_SWATCHES, applyTextColor);
buildSwatches('highlight-swatches', HIGHLIGHT_COLOR_SWATCHES, applyHighlightColor);

// Set initial bar colors
document.getElementById('text-color-bar').style.background = '#000000';
document.getElementById('highlight-color-bar').style.background = '#ffff00';

window.execFormat = execFormat;
window.setHeading = setHeading;
window.setFontFamily = setFontFamily;
window.setFontSize = setFontSize;
window.toggleColorPicker = toggleColorPicker;
window.applyTextColor = applyTextColor;
window.applyHighlightColor = applyHighlightColor;
window.resetTextColor = resetTextColor;
window.resetHighlightColor = resetHighlightColor;
window.toggleVersionPanel = toggleVersionPanel;
window.saveSnapshot = saveSnapshot;

// ─── UI Helpers ────────────────────────────────────────────────────────────────
function setStatus(state) {
  statusDot.className = `status-dot ${state}`;
  statusText.textContent = state === 'connected' ? 'Connected' :
                           state === 'disconnected' ? 'Reconnecting...' : 'Error';
}

function updateCounts() {
  const text = docContent;
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  wordCountEl.textContent = `${words} words`;
  charCountEl.textContent = `${text.length} chars`;
}

let saveSnapshotTimer = null;
function scheduleSaveSnapshot() {
  clearTimeout(saveSnapshotTimer);
  saveSnapshotTimer = setTimeout(() => {
    saveSnapshotTimer = null;
    if (ws && isConnected) {
      const clone = editorEl.cloneNode(true);
      clone.querySelectorAll('.remote-cursor, .remote-cursor-marker').forEach(c => c.remove());
      ws.send(JSON.stringify({ type: 'html-sync', targetClientId: 'server-cache', html: clone.innerHTML }));
    }
  }, 2000);

  saveIndicator.textContent = 'Saving...';
  saveIndicator.classList.add('saving');
  setTimeout(() => {
    saveIndicator.classList.remove('saving');
    saveIndicator.textContent = 'Saved ✓';
    setTimeout(() => { saveIndicator.textContent = ''; }, 1500);
  }, 1200);
}

function updateSaveIndicator() {}

function startPing() {
  setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      lastPingSent = Date.now();
      ws.send(JSON.stringify({ type: 'ping' }));
    }
  }, 5000);
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ─── Caret Utilities ───────────────────────────────────────────────────────────
/**
 * Get the caret offset as a character position within the editor's text content.
 * Excludes remote cursor overlays from the count.
 */
function getCaretOffset() {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return 0;

  const range = sel.getRangeAt(0);
  let offset = 0;

  function countBefore(node, stopNode, stopOffset) {
    if (node === stopNode) {
      if (node.nodeType === Node.TEXT_NODE) {
        offset += stopOffset;
      }
      return true;
    }
    if (node.nodeType === Node.TEXT_NODE) {
      // Check that this text node isn't inside a remote cursor element
      if (!isInsideRemoteCursor(node)) {
        offset += node.textContent.length;
      }
      return false;
    }
    if (node.nodeType === Node.ELEMENT_NODE) {
      // Skip remote-cursor elements entirely
      if (node.classList && (node.classList.contains('remote-cursor'))) {
        return false;
      }
      for (const child of node.childNodes) {
        if (countBefore(child, stopNode, stopOffset)) return true;
      }
    }
    return false;
  }

  countBefore(editorEl, range.startContainer, range.startOffset);
  return offset;
}

/**
 * Check if a node is inside a remote cursor element.
 */
function isInsideRemoteCursor(node) {
  let n = node;
  while (n && n !== editorEl) {
    if (n.nodeType === Node.ELEMENT_NODE && n.classList &&
        n.classList.contains('remote-cursor')) {
      return true;
    }
    n = n.parentNode;
  }
  return false;
}

function setCaretOffset(offset) {
  const sel = window.getSelection();
  const range = document.createRange();
  let currentOffset = 0;
  let found = false;

  function traverse(node) {
    if (found) return;
    if (node.nodeType === Node.TEXT_NODE) {
      // Skip text inside remote cursor markers
      if (isInsideRemoteCursor(node)) return;
      const len = node.textContent.length;
      if (currentOffset + len >= offset) {
        range.setStart(node, offset - currentOffset);
        range.collapse(true);
        found = true;
      } else {
        currentOffset += len;
      }
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      // Skip remote cursor elements
      if (node.classList && node.classList.contains('remote-cursor')) return;
      for (const child of node.childNodes) {
        traverse(child);
        if (found) break;
      }
    }
  }

  traverse(editorEl);
  if (!found) {
    range.selectNodeContents(editorEl);
    range.collapse(false);
  }

  sel.removeAllRanges();
  sel.addRange(range);
}

// ─── Join Modal ────────────────────────────────────────────────────────────────
function generateUsername() {
  const adjectives = ['Swift', 'Clever', 'Bold', 'Bright', 'Sharp', 'Cool', 'Epic'];
  const nouns = ['Coder', 'Hacker', 'Writer', 'Nerd', 'Dev', 'Wizard', 'Ninja'];
  return adjectives[Math.floor(Math.random() * adjectives.length)] +
         nouns[Math.floor(Math.random() * nouns.length)];
}

usernameInput.value = generateUsername();
roomInput.value = 'collab-doc';

joinBtn.addEventListener('click', () => {
  const username = usernameInput.value.trim() || generateUsername();
  const docId = roomInput.value.trim() || 'collab-doc';
  myDocId = docId;

  joinModal.classList.add('hide');
  setTimeout(() => joinModal.style.display = 'none', 400);
  connect(username, docId);

  docTitle.textContent = docId;
  lastContent = '';
  docContent = '';
});

usernameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') joinBtn.click();
});
roomInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') joinBtn.click();
});

// ─── Share Link ────────────────────────────────────────────────────────────────
document.getElementById('share-btn')?.addEventListener('click', () => {
  const url = `${location.origin}?room=${encodeURIComponent(myDocId)}`;
  navigator.clipboard.writeText(url).then(() => {
    showToast(`Link copied!`, 'success', 3000);
  }).catch(() => {
    prompt('Copy this link:', url);
  });
});

// ─── Room from URL ─────────────────────────────────────────────────────────────
const urlParams = new URLSearchParams(location.search);
const roomFromUrl = urlParams.get('room');
if (roomFromUrl) {
  roomInput.value = decodeURIComponent(roomFromUrl);
}

// ─── System Design Panel ──────────────────────────────────────────────────────
function toggleSystemPanel() {
  const panel = document.getElementById('system-panel');
  panel.classList.toggle('open');
}
window.toggleSystemPanel = toggleSystemPanel;

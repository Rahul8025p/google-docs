/**
 * server.js - Production WebSocket Server
 * 
 * SYSTEM DESIGN:
 * - Event-based architecture (EventEmitter pattern)
 * - Room isolation for horizontal scaling simulation
 * - Mutex/lock pattern for operation serialization
 * - Op queue per document (concurrency control)
 * - Version history with snapshots
 * - Race condition prevention via sequential op IDs
 * 
 * PRODUCTION FEATURES:
 * - Environment-based configuration (PORT, NODE_ENV, etc.)
 * - Health-check endpoint for cloud monitoring
 * - Rate limiting per IP (connection flood prevention)
 * - Graceful shutdown with connection draining
 * - CORS / origin validation for WebSocket upgrades
 * - Connection limits (MAX_CONNECTIONS)
 * - WebSocket compression (permessage-deflate)
 */

'use strict';

const http = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const { applyOp, serverTransform } = require('./ot-engine');
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');

// ─── Configuration ─────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT, 10) || 3001;
const NODE_ENV = process.env.NODE_ENV || 'development';
const MAX_CONNECTIONS = parseInt(process.env.MAX_CONNECTIONS, 10) || 100;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim());
const IS_PROD = NODE_ENV === 'production';

// ─── Event Bus ─────────────────────────────────────────────────────────────────
class EventBus extends EventEmitter {}
const eventBus = new EventBus();

// ─── Mutex (Concurrency Control) ───────────────────────────────────────────────
class Mutex {
  constructor() {
    this._queue = [];
    this._locked = false;
  }

  async acquire() {
    return new Promise((resolve) => {
      if (!this._locked) {
        this._locked = true;
        resolve();
      } else {
        this._queue.push(resolve);
      }
    });
  }

  release() {
    if (this._queue.length > 0) {
      const next = this._queue.shift();
      next();
    } else {
      this._locked = false;
    }
  }

  async runExclusive(fn) {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

// ─── Rate Limiter ──────────────────────────────────────────────────────────────
class RateLimiter {
  constructor(maxRequests = 10, windowMs = 60000) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
    this.clients = new Map(); // ip → { count, resetAt }
  }

  isAllowed(ip) {
    const now = Date.now();
    let entry = this.clients.get(ip);

    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + this.windowMs };
      this.clients.set(ip, entry);
    }

    entry.count++;
    return entry.count <= this.maxRequests;
  }

  // Periodic cleanup of expired entries
  cleanup() {
    const now = Date.now();
    for (const [ip, entry] of this.clients) {
      if (now > entry.resetAt) this.clients.delete(ip);
    }
  }
}

const connectionLimiter = new RateLimiter(10, 60000); // 10 connections/minute per IP

// Clean up rate limiter every 5 minutes
setInterval(() => connectionLimiter.cleanup(), 300000);

// ─── Document Room ─────────────────────────────────────────────────────────────
class DocumentRoom {
  constructor(docId) {
    this.docId = docId;
    this.content = '';
    this.revision = 0;
    this.clients = new Map(); // clientId → { ws, color, username, cursor }
    this.opHistory = [];      // All ops applied (for OT transform)
    this.versionHistory = []; // Snapshots for version history
    this.mutex = new Mutex(); // Serializes op application (LOCK)
    this.pendingOps = [];     // Op queue (bounded buffer)
    this.saveTimer = null;

    // Take initial snapshot
    this._snapshot('Initial document');
  }

  _snapshot(label) {
    this.versionHistory.push({
      id: uuidv4(),
      revision: this.revision,
      content: this.content,
      timestamp: Date.now(),
      label: label || `Version ${this.versionHistory.length + 1}`,
      wordCount: this.content.split(/\s+/).filter(Boolean).length
    });
    // Keep last 50 versions
    if (this.versionHistory.length > 50) {
      this.versionHistory = this.versionHistory.slice(-50);
    }
  }

  async applyOperation(op, senderClientId) {
    // MUTEX: ensure only one op applies at a time (prevent race conditions)
    return await this.mutex.runExclusive(() => {
      // Collect all ops since client's revision (concurrent ops)
      const concurrentOps = this.opHistory.slice(op.revision);

      // SERVER TRANSFORM: adjust op for concurrent changes
      const transformedOp = serverTransform(op, concurrentOps);
      transformedOp.revision = this.revision;
      transformedOp.serverRevision = this.revision;

      // APPLY to authoritative document
      const prevContent = this.content;
      this.content = applyOp(this.content, transformedOp);
      this.revision++;
      this.opHistory.push(transformedOp);

      // Bounded history (keep last 1000 ops)
      if (this.opHistory.length > 1000) {
        this.opHistory = this.opHistory.slice(-500);
      }

      // Auto-snapshot every 20 operations
      if (this.revision % 20 === 0) {
        this._snapshot(`Auto-save at rev ${this.revision}`);
      }

      // Emit event for broadcasting
      eventBus.emit('op:applied', {
        docId: this.docId,
        op: transformedOp,
        senderClientId,
        revision: this.revision
      });

      return transformedOp;
    });
  }

  addClient(clientId, ws, username, color) {
    this.clients.set(clientId, { ws, color, username, cursor: 0, lastActive: Date.now() });
    eventBus.emit('client:join', { docId: this.docId, clientId, username, color });
  }

  removeClient(clientId) {
    const client = this.clients.get(clientId);
    this.clients.delete(clientId);
    if (client) {
      eventBus.emit('client:leave', { docId: this.docId, clientId, username: client.username });
    }
  }

  getPresenceList() {
    return Array.from(this.clients.entries()).map(([id, c]) => ({
      clientId: id,
      username: c.username,
      color: c.color,
      cursor: c.cursor
    }));
  }

  broadcast(message, excludeClientId = null) {
    const data = JSON.stringify(message);
    for (const [clientId, { ws }] of this.clients) {
      if (clientId !== excludeClientId && ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    }
  }

  broadcastToAll(message) {
    const data = JSON.stringify(message);
    for (const { ws } of this.clients.values()) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    }
  }

  restoreVersion(versionId) {
    const version = this.versionHistory.find(v => v.id === versionId);
    if (!version) return null;

    return this.mutex.runExclusive(() => {
      this.content = version.content;
      this.revision++;
      this._snapshot(`Restored to ${version.label}`);

      eventBus.emit('doc:restored', {
        docId: this.docId,
        content: this.content,
        revision: this.revision
      });

      return this.content;
    });
  }
}

// ─── Room Manager (Horizontal Scaling Simulation) ──────────────────────────────
class RoomManager {
  constructor() {
    this.rooms = new Map();
  }

  getOrCreate(docId) {
    if (!this.rooms.has(docId)) {
      this.rooms.set(docId, new DocumentRoom(docId));
      console.log(`[RoomManager] Created room: ${docId}`);
    }
    return this.rooms.get(docId);
  }

  get(docId) {
    return this.rooms.get(docId);
  }

  cleanup(docId) {
    const room = this.rooms.get(docId);
    if (room && room.clients.size === 0) {
      this.rooms.delete(docId);
      console.log(`[RoomManager] Cleaned up room: ${docId}`);
    }
  }

  getStats() {
    const stats = { rooms: this.rooms.size, clients: 0, ops: 0 };
    for (const room of this.rooms.values()) {
      stats.clients += room.clients.size;
      stats.ops += room.opHistory.length;
    }
    return stats;
  }
}

const roomManager = new RoomManager();

// ─── User Colors ───────────────────────────────────────────────────────────────
const USER_COLORS = [
  '#6C63FF', '#FF6584', '#43D9AD', '#FF9F43',
  '#54A0FF', '#FF6B6B', '#5F27CD', '#01CBC6',
  '#FFC312', '#C4E538'
];
let colorIndex = 0;
function nextColor() {
  return USER_COLORS[colorIndex++ % USER_COLORS.length];
}

// ─── MIME Types ────────────────────────────────────────────────────────────────
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon'
};

// ─── HTTP Server (serves static files + health check) ──────────────────────────
const server = http.createServer((req, res) => {

  // ── Health Check Endpoint ──
  if (req.url === '/health' || req.url === '/healthz') {
    const stats = roomManager.getStats();
    const payload = {
      status: 'ok',
      uptime: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
      env: NODE_ENV,
      connections: stats.clients,
      rooms: stats.rooms,
      totalOps: stats.ops,
      memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024)
    };
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache'
    });
    res.end(JSON.stringify(payload));
    return;
  }

  // ── Static Files ──
  const staticFiles = {
    '/': { file: 'index.html', type: 'text/html' },
    '/editor.js': { file: 'editor.js', type: 'application/javascript' },
    '/ot-client.js': { file: 'ot-client.js', type: 'application/javascript' },
    '/styles.css': { file: 'styles.css', type: 'text/css' }
  };

  const mapping = staticFiles[req.url] || staticFiles['/'];
  const filePath = path.join(__dirname, mapping.file);
  const ext = path.extname(filePath);

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }

    const contentType = MIME_TYPES[ext] || mapping.type || 'application/octet-stream';
    const headers = { 'Content-Type': contentType };

    // Cache static assets in production
    if (IS_PROD && ext !== '.html') {
      headers['Cache-Control'] = 'public, max-age=86400'; // 1 day
    } else {
      headers['Cache-Control'] = 'no-cache';
    }

    // Security headers
    headers['X-Content-Type-Options'] = 'nosniff';
    headers['X-Frame-Options'] = 'DENY';

    res.writeHead(200, headers);
    res.end(data);
  });
});

// ─── Origin Validation ─────────────────────────────────────────────────────────
function isOriginAllowed(origin) {
  if (ALLOWED_ORIGINS.includes('*')) return true;
  if (!origin) return !IS_PROD; // Allow missing origin in development only
  return ALLOWED_ORIGINS.some(allowed => {
    if (allowed === origin) return true;
    // Support wildcard subdomains: *.example.com
    if (allowed.startsWith('*.')) {
      const domain = allowed.slice(2);
      return origin.endsWith(domain);
    }
    return false;
  });
}

// ─── WebSocket Server ──────────────────────────────────────────────────────────
const wss = new WebSocket.Server({
  server,
  perMessageDeflate: {
    zlibDeflateOptions: { chunkSize: 1024, memLevel: 7, level: 3 },
    zlibInflateOptions: { chunkSize: 10 * 1024 },
    threshold: 128 // Only compress messages > 128 bytes
  },
  verifyClient: ({ req, origin }, callback) => {
    // Rate limiting
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;
    if (!connectionLimiter.isAllowed(ip)) {
      console.warn(`[RateLimit] Connection rejected from ${ip}`);
      callback(false, 429, 'Too Many Requests');
      return;
    }

    // Connection limit
    if (wss.clients.size >= MAX_CONNECTIONS) {
      console.warn(`[Limit] Max connections (${MAX_CONNECTIONS}) reached`);
      callback(false, 503, 'Server at capacity');
      return;
    }

    // Origin validation
    if (!isOriginAllowed(origin)) {
      console.warn(`[CORS] Rejected origin: ${origin}`);
      callback(false, 403, 'Forbidden');
      return;
    }

    callback(true);
  }
});

// Track total connections for monitoring
let totalConnectionsServed = 0;

wss.on('connection', (ws, req) => {
  const clientId = uuidv4();
  let room = null;
  let clientMeta = null;
  totalConnectionsServed++;

  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;
  console.log(`[WS] Client connected: ${clientId} from ${ip}`);

  // HEARTBEAT: detect stale connections (OS-level resource management)
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', async (rawData) => {
    let msg;
    try {
      msg = JSON.parse(rawData.toString());
    } catch {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
      return;
    }

    try {
      await handleMessage(ws, clientId, msg, () => room, (r) => { room = r; }, (m) => { clientMeta = m; });
    } catch (err) {
      console.error(`[WS] Error handling message:`, err);
      ws.send(JSON.stringify({ type: 'error', message: err.message }));
    }
  });

  ws.on('close', () => {
    if (room && clientMeta) {
      room.removeClient(clientId);
      room.broadcast({
        type: 'presence:leave',
        clientId,
        username: clientMeta.username,
        presence: room.getPresenceList()
      });
      roomManager.cleanup(room.docId);
      console.log(`[WS] ${clientMeta?.username} left room ${room?.docId}`);
    }
  });

  ws.on('error', (err) => {
    console.error(`[WS] Socket error for ${clientId}:`, err.message);
  });
});

// ─── Message Handler ───────────────────────────────────────────────────────────
async function handleMessage(ws, clientId, msg, getRoom, setRoom, setMeta) {
  switch (msg.type) {

    case 'join': {
      const docId = msg.docId || 'default';
      const room = roomManager.getOrCreate(docId);
      const username = msg.username || `User${Math.floor(Math.random() * 1000)}`;
      const color = nextColor();

      room.addClient(clientId, ws, username, color);
      setRoom(room);
      setMeta({ username, color });

      // Send current document state to joining client
      ws.send(JSON.stringify({
        type: 'init',
        clientId,
        docId,
        content: room.content,
        html: room.html,
        revision: room.revision,
        color,
        username,
        presence: room.getPresenceList(),
        versionHistory: room.versionHistory.slice(-10)
      }));

      // Ask the first OTHER client to provide an HTML sync for the new client
      if (room.clients.size > 1) {
        for (const [otherId, otherClient] of room.clients.entries()) {
          if (otherId !== clientId) {
            otherClient.ws.send(JSON.stringify({ type: 'request-html-sync', targetClientId: clientId }));
            break;
          }
        }
      }

      // Notify others of join
      room.broadcast({
        type: 'presence:join',
        clientId,
        username,
        color,
        presence: room.getPresenceList()
      }, clientId);

      console.log(`[WS] ${username} joined doc ${docId} (rev ${room.revision})`);
      break;
    }

    case 'op': {
      const room = getRoom();
      if (!room) { ws.send(JSON.stringify({ type: 'error', message: 'Not in a room' })); return; }

      // Validate op
      if (!msg.op || !msg.op.type) {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid operation' }));
        return;
      }

      // Tag op with client info
      const op = {
        ...msg.op,
        clientId,
        revision: msg.revision || 0,
        id: uuidv4()
      };

      // APPLY via OT (mutex-protected)
      const transformedOp = await room.applyOperation(op, clientId);

      // ACK to sender
      ws.send(JSON.stringify({
        type: 'ack',
        opId: msg.opId,
        serverRevision: room.revision
      }));

      // Broadcast transformed op to all other clients
      room.broadcast({
        type: 'op',
        op: transformedOp,
        serverRevision: room.revision
      }, clientId);

      break;
    }

    case 'cursor': {
      const room = getRoom();
      if (!room) return;

      const client = room.clients.get(clientId);
      if (client) client.cursor = msg.cursor;

      room.broadcast({
        type: 'cursor',
        clientId,
        cursor: msg.cursor,
        username: client?.username,
        color: client?.color
      }, clientId);
      break;
    }

    case 'getVersionHistory': {
      const room = getRoom();
      if (!room) return;
      ws.send(JSON.stringify({
        type: 'versionHistory',
        versions: room.versionHistory
      }));
      break;
    }

    case 'restoreVersion': {
      const room = getRoom();
      if (!room) return;
      const content = await room.restoreVersion(msg.versionId);
      if (content !== null) {
        room.broadcastToAll({
          type: 'restore',
          content,
          revision: room.revision,
          restoredBy: room.clients.get(clientId)?.username
        });
      }
      break;
    }

    case 'saveSnapshot': {
      const room = getRoom();
      if (!room) return;
      room._snapshot(msg.label || `Manual save at rev ${room.revision}`);
      ws.send(JSON.stringify({
        type: 'versionHistory',
        versions: room.versionHistory
      }));
      break;
    }

    case 'ping': {
      ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
      break;
    }

    case 'format': {
      const room = getRoom();
      if (!room) return;

      const client = room.clients.get(clientId);
      room.broadcast({
        type: 'format',
        clientId,
        cmd: msg.cmd,
        value: msg.value,
        start: msg.start,
        end: msg.end,
        username: client?.username
      }, clientId);
      break;
    }

    case 'html-sync': {
      const room = getRoom();
      if (!room) return;
      room.html = msg.html;
      const target = room.clients.get(msg.targetClientId);
      if (target) {
        target.ws.send(JSON.stringify({ type: 'apply-html-sync', html: msg.html }));
      }
      break;
    }

    default:
      ws.send(JSON.stringify({ type: 'error', message: `Unknown message type: ${msg.type}` }));
  }
}

// ─── Heartbeat (Dead connection cleanup) ───────────────────────────────────────
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) {
      ws.terminate();
      return;
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => clearInterval(heartbeat));

// ─── Event Bus Listeners ───────────────────────────────────────────────────────
eventBus.on('op:applied', ({ docId, op, senderClientId, revision }) => {
  // Future: could write to a distributed log (Kafka, etc.)
  // For now: just log
  // console.log(`[Event] op:applied doc=${docId} rev=${revision} type=${op.type}`);
});

eventBus.on('client:join', ({ docId, clientId, username }) => {
  console.log(`[Event] client:join doc=${docId} user=${username}`);
});

eventBus.on('client:leave', ({ docId, clientId, username }) => {
  console.log(`[Event] client:leave doc=${docId} user=${username}`);
});

eventBus.on('doc:restored', ({ docId, revision }) => {
  console.log(`[Event] doc:restored doc=${docId} rev=${revision}`);
});

// ─── Stats endpoint ─────────────────────────────────────────────────────────────
setInterval(() => {
  const stats = roomManager.getStats();
  if (stats.clients > 0) {
    console.log(`[Stats] Rooms: ${stats.rooms} | Clients: ${stats.clients} | Ops: ${stats.ops}`);
  }
}, 60000);

// ─── Graceful Shutdown ─────────────────────────────────────────────────────────
let isShuttingDown = false;

function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`\n[Server] ${signal} received. Starting graceful shutdown...`);

  // 1. Stop accepting new connections
  server.close(() => {
    console.log('[Server] HTTP server closed.');
  });

  // 2. Notify all connected clients
  wss.clients.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Server is shutting down. Please reconnect shortly.'
      }));
    }
  });

  // 3. Close WebSocket server (terminates all connections)
  wss.close(() => {
    console.log('[Server] WebSocket server closed.');
  });

  // 4. Clear intervals
  clearInterval(heartbeat);

  // 5. Force exit after timeout (give connections 5s to drain)
  setTimeout(() => {
    console.log('[Server] Forcing exit after timeout.');
    process.exit(0);
  }, 5000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ─── Start Server ──────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════╗
║   Real-Time Collaborative Editor                   ║
║   Environment: ${NODE_ENV.padEnd(34)}║
║   http://localhost:${String(PORT).padEnd(31)}║
║   WebSocket: ws://localhost:${String(PORT).padEnd(22)}║
║   Health: http://localhost:${String(PORT).padEnd(23)}║
║   Max connections: ${String(MAX_CONNECTIONS).padEnd(30)}║
╚════════════════════════════════════════════════════╝
  `);
});

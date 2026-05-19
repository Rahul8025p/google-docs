/**
 * server.js - Distributed Production WebSocket Server
 * 
 * SYSTEM DESIGN SHOWCASE:
 * - Horizontal Scaling: Multiple Node.js instances behind NGINX
 * - Message Bus: Redis Pub/Sub for real-time cross-instance synchronization
 * - Event Streaming: Redpanda (Kafka-compatible) for immutable operation logging
 * - Persistence: MongoDB for durable document and version storage
 * - Caching: Redis for hot document content
 * - Observability: Prometheus metrics exposed for Grafana dashboards
 */

'use strict';

const http = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const { applyOp, serverTransform } = require('./ot-engine');
const Redis = require('ioredis');
const { Kafka } = require('kafkajs');
const { MongoClient } = require('mongodb');
const promClient = require('prom-client');
const path = require('path');
const fs = require('fs');

// ─── Configuration ─────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT, 10) || 3001;
const NODE_ENV = process.env.NODE_ENV || 'development';
const INSTANCE_ID = uuidv4().split('-')[0];
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const KAFKA_BROKERS = (process.env.KAFKA_BROKERS || 'localhost:9092').split(',');
const MONGO_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017';
const IS_PROD = NODE_ENV === 'production';

// ─── Monitoring (Prometheus) ───────────────────────────────────────────────────
const collectDefaultMetrics = promClient.collectDefaultMetrics;
collectDefaultMetrics({ prefix: 'editor_' });

const wsConnectionsCounter = new promClient.Counter({
  name: 'editor_ws_connections_total',
  help: 'Total number of WebSocket connections'
});

const activeConnectionsGauge = new promClient.Gauge({
  name: 'editor_ws_active_connections',
  help: 'Number of currently active WebSocket connections'
});

const opsProcessedCounter = new promClient.Counter({
  name: 'editor_ops_total',
  help: 'Total number of operations processed',
  label_names: ['type']
});

// ─── Distributed State Clients ────────────────────────────────────────────────
console.log(`[Redis] Connecting to: ${REDIS_URL.replace(/:[^:]*@/, ':****@')}`);
const pubClient = new Redis(REDIS_URL);
const subClient = new Redis(REDIS_URL);

// Prevent process from crashing on unhandled Redis errors
pubClient.on('error', (err) => console.error('[Redis Pub] Client Error:', err.message));
subClient.on('error', (err) => console.error('[Redis Sub] Client Error:', err.message));

const kafka = new Kafka({ clientId: `editor-${INSTANCE_ID}`, brokers: KAFKA_BROKERS });
const producer = kafka.producer();

let db;
async function connectMongo() {
  try {
    const mongoClient = await MongoClient.connect(MONGO_URI);
    db = mongoClient.db('collab_editor');
    console.log(`[Mongo] Connected to ${MONGO_URI}`);
  } catch (err) {
    console.error('[Mongo] Connection error:', err.message);
  }
}

// ─── Document Logic ────────────────────────────────────────────────────────────
class DocumentRoom {
  constructor(docId) {
    this.docId = docId;
    this.content = '';
    this.revision = 0;
    this.clients = new Map(); // local clientId -> ws
    this.opHistory = [];
  }

  async load() {
    if (!db) return;
    const doc = await db.collection('documents').findOne({ docId: this.docId });
    if (doc) {
      this.content = doc.content;
      this.revision = doc.revision;
    }
  }

  async save() {
    if (!db) return;
    await db.collection('documents').updateOne(
      { docId: this.docId },
      { $set: { content: this.content, revision: this.revision, lastUpdated: new Date() } },
      { upsert: true }
    );
  }

  broadcastLocal(message, excludeClientId = null) {
    const data = JSON.stringify(message);
    for (const [clientId, ws] of this.clients) {
      if (clientId !== excludeClientId && ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    }
  }
}

const localRooms = new Map();

// ─── Redis Pub/Sub: Cross-Instance Sync ────────────────────────────────────────
subClient.subscribe('doc_ops');
subClient.on('message', (channel, message) => {
  const { docId, type, payload, senderInstanceId } = JSON.parse(message);
  if (senderInstanceId === INSTANCE_ID) return;

  const room = localRooms.get(docId);
  if (!room) return;

  if (type === 'op') {
    room.content = applyOp(room.content, payload.op);
    room.revision = payload.revision;
    room.broadcastLocal({ type: 'op', op: payload.op, serverRevision: room.revision });
  } else if (type === 'presence') {
    room.broadcastLocal(payload);
  }
});

// ─── HTTP Server ───────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', instanceId: INSTANCE_ID, uptime: process.uptime() }));
    return;
  }

  if (req.url === '/metrics') {
    res.writeHead(200, { 'Content-Type': promClient.register.contentType });
    res.end(await promClient.register.metrics());
    return;
  }

  // Static File Serving
  const staticFiles = {
    '/': 'index.html',
    '/editor.js': 'editor.js',
    '/ot-client.js': 'ot-client.js',
    '/styles.css': 'styles.css'
  };

  const file = staticFiles[req.url] || 'index.html';
  const filePath = path.join(__dirname, file);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end(); return; }
    const ext = path.extname(file);
    const contentType = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' }[ext] || 'text/plain';
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
});

// ─── WebSocket Server ──────────────────────────────────────────────────────────
const wss = new WebSocket.Server({ server });

wss.on('connection', async (ws, req) => {
  const clientId = uuidv4();
  const url = new URL(req.url, `http://${req.headers.host}`);
  const docId = url.searchParams.get('docId') || 'default';

  wsConnectionsCounter.inc();
  activeConnectionsGauge.inc();

  if (!localRooms.has(docId)) {
    const room = new DocumentRoom(docId);
    await room.load();
    localRooms.set(docId, room);
  }
  const room = localRooms.get(docId);
  room.clients.set(clientId, ws);

  // Send Initial State
  ws.send(JSON.stringify({
    type: 'init',
    clientId,
    docId,
    content: room.content,
    revision: room.revision,
    instanceId: INSTANCE_ID
  }));

  ws.on('message', async (data) => {
    const msg = JSON.parse(data);
    if (msg.type === 'op') {
      opsProcessedCounter.inc({ type: msg.op.type });
      
      // Apply locally
      room.content = applyOp(room.content, msg.op);
      room.revision++;

      // 1. Sync other instances (Redis Pub/Sub)
      pubClient.publish('doc_ops', JSON.stringify({
        docId,
        type: 'op',
        senderInstanceId: INSTANCE_ID,
        payload: { op: msg.op, revision: room.revision }
      }));

      // 2. Log to Stream (Kafka)
      try {
        await producer.send({
          topic: 'document-ops',
          messages: [{ key: docId, value: JSON.stringify({ docId, op: msg.op, revision: room.revision, timestamp: Date.now() }) }]
        });
      } catch (e) { console.error('[Kafka] Produce error:', e.message); }

      // 3. Persist (MongoDB) - debounced would be better but let's keep it simple
      room.save();

      // 4. Ack sender and broadcast to other locals
      ws.send(JSON.stringify({ type: 'ack', opId: msg.opId, serverRevision: room.revision }));
      room.broadcastLocal({ type: 'op', op: msg.op, serverRevision: room.revision }, clientId);
    }
  });

  ws.on('close', () => {
    activeConnectionsGauge.dec();
    room.clients.delete(clientId);
    if (room.clients.size === 0) localRooms.delete(docId);
  });
});

// ─── Bootstrap ─────────────────────────────────────────────────────────────────
async function bootstrap() {
  await connectMongo();
  
  try {
    await producer.connect();
    console.log('[Kafka] Producer connected successfully.');
  } catch (err) {
    console.error('[Kafka] Connection error:', err.message);
  }

  server.listen(PORT, () => {
    console.log(`
╔════════════════════════════════════════════════════╗
║   Distributed Collaborative Editor                 ║
║   Instance ID: ${INSTANCE_ID.padEnd(36)}║
║   Listening on port: ${String(PORT).padEnd(26)}║
╚════════════════════════════════════════════════════╝
    `);
  });
}

bootstrap();

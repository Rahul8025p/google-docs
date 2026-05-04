/**
 * ot-client.js - Client-side OT Engine
 * 
 * Handles:
 * - Local op generation from editor events
 * - Client-side OT state machine (Revision + Pending + Inflight)
 * - Reconciliation with server transforms
 * - Cursor position adjustment after remote ops
 */
'use strict';

class OTClient {
  constructor(onApplyRemoteOp, onSendOp) {
    this.revision = 0;           // Last acknowledged server revision
    this.inflightOp = null;      // Op sent, awaiting ACK
    this.pendingOps = [];        // Ops buffered while inflight is outstanding
    this.onApplyRemoteOp = onApplyRemoteOp;
    this.onSendOp = onSendOp;
    this.clientId = null;
    this._opIdCounter = 0;
  }

  /**
   * Called when user makes a local edit.
   * Queues or sends op depending on inflight state.
   */
  submitOp(op) {
    const taggedOp = { ...op, revision: this.revision };
    const opId = `op_${++this._opIdCounter}`;

    if (!this.inflightOp) {
      // Send immediately
      this.inflightOp = { op: taggedOp, opId };
      this.onSendOp(taggedOp, opId);
    } else {
      // Buffer: transform against inflight op for local consistency
      this.pendingOps.push(taggedOp);
    }
  }

  /**
   * Server ACK received. Advance revision. Flush pending.
   */
  handleAck(opId, serverRevision) {
    if (!this.inflightOp || this.inflightOp.opId !== opId) return;

    this.revision = serverRevision;
    this.inflightOp = null;

    // Send next pending op if any
    if (this.pendingOps.length > 0) {
      const nextOp = this.pendingOps.shift();
      nextOp.revision = this.revision;
      const opId2 = `op_${++this._opIdCounter}`;
      this.inflightOp = { op: nextOp, opId: opId2 };
      this.onSendOp(nextOp, opId2);
    }
  }

  /**
   * Remote op received from server (another user's transformed op).
   * Must transform against our inflight + pending ops.
   */
  handleRemoteOp(serverOp, serverRevision) {
    // Transform serverOp against inflight (if any)
    let remoteOp = { ...serverOp };

    if (this.inflightOp) {
      const [remotePrime, inflightPrime] = otTransform(remoteOp, this.inflightOp.op);
      remoteOp = remotePrime;
      this.inflightOp = { ...this.inflightOp, op: inflightPrime };
    }

    // Transform against pending ops
    const newPending = [];
    for (const pendingOp of this.pendingOps) {
      const [remotePrime2, pendingPrime] = otTransform(remoteOp, pendingOp);
      remoteOp = remotePrime2;
      newPending.push(pendingPrime);
    }
    this.pendingOps = newPending;

    this.revision = serverRevision;
    this.onApplyRemoteOp(remoteOp);
  }

  /**
   * Full document restore (version rollback).
   */
  handleRestore(content, revision) {
    this.revision = revision;
    this.inflightOp = null;
    this.pendingOps = [];
    this.onApplyRemoteOp({ type: 'restore', content });
  }
}

// ─── OT Transform (client-side, subset of server engine) ──────────────────────
function otTransform(opA, opB) {
  if (!opA || !opB) return [opA, opB];
  if (opA.type === 'insert' && opB.type === 'insert') {
    return transformII(opA, opB);
  } else if (opA.type === 'insert' && opB.type === 'delete') {
    return transformID(opA, opB);
  } else if (opA.type === 'delete' && opB.type === 'insert') {
    const [b2, a2] = transformID(opB, opA);
    return [a2, b2];
  } else if (opA.type === 'delete' && opB.type === 'delete') {
    return transformDD(opA, opB);
  }
  return [opA, opB];
}

function transformII(a, b) {
  let aPrime = { ...a }, bPrime = { ...b };
  if (a.pos < b.pos) {
    bPrime.pos = b.pos + a.text.length;
  } else if (a.pos > b.pos) {
    aPrime.pos = a.pos + b.text.length;
  } else {
    if ((a.clientId || '') <= (b.clientId || '')) {
      bPrime.pos = b.pos + a.text.length;
    } else {
      aPrime.pos = a.pos + b.text.length;
    }
  }
  return [aPrime, bPrime];
}

function transformID(ins, del) {
  let insPrime = { ...ins }, delPrime = { ...del };
  if (ins.pos <= del.pos) {
    delPrime.pos = del.pos + ins.text.length;
  } else if (ins.pos > del.pos + del.len) {
    insPrime.pos = ins.pos - del.len;
  } else {
    insPrime.pos = del.pos;
    delPrime.len = del.len + ins.text.length;
  }
  return [insPrime, delPrime];
}

function transformDD(a, b) {
  let aPrime = { ...a }, bPrime = { ...b };
  const aEnd = a.pos + a.len, bEnd = b.pos + b.len;
  if (aEnd <= b.pos) {
    bPrime.pos = b.pos - a.len;
  } else if (bEnd <= a.pos) {
    aPrime.pos = a.pos - b.len;
  } else {
    const overlapLen = Math.min(aEnd, bEnd) - Math.max(a.pos, b.pos);
    aPrime = { ...a, pos: Math.min(a.pos, b.pos), len: Math.max(0, a.len - overlapLen) };
    bPrime = { ...b, pos: Math.min(a.pos, b.pos), len: Math.max(0, b.len - overlapLen) };
  }
  return [aPrime, bPrime];
}

/**
 * Adjust a cursor position when an op is applied elsewhere.
 */
function adjustCursor(cursor, op) {
  if (!op) return cursor;
  if (op.type === 'insert') {
    if (op.pos <= cursor) return cursor + op.text.length;
  } else if (op.type === 'delete') {
    if (op.pos + op.len <= cursor) return cursor - op.len;
    if (op.pos < cursor) return op.pos;
  }
  return cursor;
}

// Export
window.OTClient = OTClient;
window.otTransform = otTransform;
window.adjustCursor = adjustCursor;

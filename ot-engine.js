/**
 * ot-engine.js - Operational Transform Engine
 * 
 * Implements the classic OT algorithm for string operations.
 * Operations: insert(pos, text) | delete(pos, len)
 * 
 * CONCURRENCY: All transform functions are pure/deterministic —
 * safe to call from multiple concurrent contexts.
 */

'use strict';

/**
 * Operation schema:
 * { type: 'insert', pos: number, text: string, clientId: string, revision: number }
 * { type: 'delete', pos: number, len: number, clientId: string, revision: number }
 * { type: 'style', pos: number, len: number, style: object, clientId: string, revision: number }
 */

/**
 * Transform operation A against operation B.
 * Returns [A', B'] where A' can be applied after B, B' after A.
 */
function transform(opA, opB) {
  if (opA.type === 'insert' && opB.type === 'insert') {
    return transformInsertInsert(opA, opB);
  } else if (opA.type === 'insert' && opB.type === 'delete') {
    return transformInsertDelete(opA, opB);
  } else if (opA.type === 'delete' && opB.type === 'insert') {
    const [bPrime, aPrime] = transformInsertDelete(opB, opA);
    return [aPrime, bPrime];
  } else if (opA.type === 'delete' && opB.type === 'delete') {
    return transformDeleteDelete(opA, opB);
  } else if (opA.type === 'style' || opB.type === 'style') {
    return transformWithStyle(opA, opB);
  }
  return [opA, opB];
}

function transformInsertInsert(opA, opB) {
  let aPrime = { ...opA };
  let bPrime = { ...opB };

  if (opA.pos < opB.pos) {
    // A inserts before B: B shifts right
    bPrime = { ...opB, pos: opB.pos + opA.text.length };
  } else if (opA.pos > opB.pos) {
    // B inserts before A: A shifts right
    aPrime = { ...opA, pos: opA.pos + opB.text.length };
  } else {
    // Same position: break tie by clientId (lexicographic)
    if (opA.clientId <= opB.clientId) {
      bPrime = { ...opB, pos: opB.pos + opA.text.length };
    } else {
      aPrime = { ...opA, pos: opA.pos + opB.text.length };
    }
  }
  return [aPrime, bPrime];
}

function transformInsertDelete(opInsert, opDelete) {
  let insertPrime = { ...opInsert };
  let deletePrime = { ...opDelete };

  if (opInsert.pos <= opDelete.pos) {
    // Insert is before or at delete start: delete shifts right
    deletePrime = { ...opDelete, pos: opDelete.pos + opInsert.text.length };
  } else if (opInsert.pos > opDelete.pos + opDelete.len) {
    // Insert is after delete range: insert shifts left
    insertPrime = { ...opInsert, pos: opInsert.pos - opDelete.len };
  } else {
    // Insert is within delete range: anchor insert to delete start
    insertPrime = { ...opInsert, pos: opDelete.pos };
    deletePrime = {
      ...opDelete,
      len: opDelete.len + opInsert.text.length
    };
  }
  return [insertPrime, deletePrime];
}

function transformDeleteDelete(opA, opB) {
  let aPrime = { ...opA };
  let bPrime = { ...opB };

  const aEnd = opA.pos + opA.len;
  const bEnd = opB.pos + opB.len;

  if (aEnd <= opB.pos) {
    // A entirely before B
    bPrime = { ...opB, pos: opB.pos - opA.len };
  } else if (bEnd <= opA.pos) {
    // B entirely before A
    aPrime = { ...opA, pos: opA.pos - opB.len };
  } else {
    // Overlapping deletes
    const overlapStart = Math.max(opA.pos, opB.pos);
    const overlapEnd = Math.min(aEnd, bEnd);
    const overlapLen = overlapEnd - overlapStart;

    // A': adjust for B's non-overlapping prefix
    const bBeforeA = Math.max(0, opA.pos - opB.pos);
    aPrime = {
      ...opA,
      pos: Math.min(opA.pos, opB.pos),
      len: opA.len - overlapLen - Math.max(0, bEnd - aEnd < 0 ? 0 : Math.min(bEnd - aEnd, opA.len))
    };
    // Simplified: just subtract overlap
    aPrime = { ...opA, pos: opA.pos - Math.min(opA.pos - opB.pos, opB.len), len: Math.max(0, opA.len - overlapLen) };
    bPrime = { ...opB, pos: opB.pos - Math.min(opB.pos - opA.pos, opA.len), len: Math.max(0, opB.len - overlapLen) };
  }

  return [aPrime, bPrime];
}

function transformWithStyle(opA, opB) {
  // Style operations are idempotent — last writer wins
  return [opA, opB];
}

/**
 * Apply an operation to a string document.
 * ATOMIC: returns new string without mutating original.
 */
function applyOp(doc, op) {
  if (op.type === 'insert') {
    const pos = Math.min(op.pos, doc.length);
    return doc.slice(0, pos) + op.text + doc.slice(pos);
  } else if (op.type === 'delete') {
    const pos = Math.min(op.pos, doc.length);
    const len = Math.min(op.len, doc.length - pos);
    return doc.slice(0, pos) + doc.slice(pos + len);
  }
  return doc;
}

/**
 * Compose two operations into one (for compaction).
 */
function compose(op1, op2) {
  // Simple composition for history compaction
  return [op1, op2]; // Return as sequence for now
}

/**
 * Server-side OT: transform incoming op against all concurrent ops
 * that have been applied since the client's revision.
 */
function serverTransform(incomingOp, concurrentOps) {
  let op = { ...incomingOp };
  for (const concurrentOp of concurrentOps) {
    const [opPrime] = transform(op, concurrentOp);
    op = opPrime;
  }
  return op;
}

module.exports = { transform, applyOp, serverTransform, compose };

/**
 * history.js — Undo/Redo stack and Checkpoint management.
 * Pure data logic — no DOM access.
 * Undo history and rollback checkpoints are kept SEPARATE.
 */

// ─── Undo / Redo Stack ─────────────────────────────────────────────────────

const MAX_UNDO = 50;

const _undoStack = [];  // snapshots (oldest first)
const _redoStack = [];  // snapshots (most-recent-undone first)

/**
 * Pushes a deep-cloned state snapshot onto the undo stack.
 * Also clears the redo stack (new action invalidates redo history).
 * @param {object} snapshot — result of Model.cloneState()
 */
function pushUndo(snapshot) {
  _undoStack.push(JSON.parse(JSON.stringify(snapshot)));
  if (_undoStack.length > MAX_UNDO) _undoStack.shift(); // drop oldest
  _redoStack.length = 0; // clear redo on any new action
}

/**
 * Pops the most recent snapshot from the undo stack.
 * Pushes the current snapshot (provided by caller) onto the redo stack.
 * @param {object} currentSnapshot — the current state before undoing
 * @returns {object|null} — snapshot to restore, or null if stack empty
 */
function undo(currentSnapshot) {
  if (_undoStack.length === 0) return null;
  _redoStack.push(JSON.parse(JSON.stringify(currentSnapshot)));
  return _undoStack.pop();
}

/**
 * Pops the most recent snapshot from the redo stack.
 * Pushes the current snapshot (provided by caller) onto the undo stack.
 * @param {object} currentSnapshot
 * @returns {object|null}
 */
function redo(currentSnapshot) {
  if (_redoStack.length === 0) return null;
  _undoStack.push(JSON.parse(JSON.stringify(currentSnapshot)));
  return _redoStack.pop();
}

/** Returns number of available undo steps. */
function getUndoCount() { return _undoStack.length; }

/** Returns number of available redo steps. */
function getRedoCount() { return _redoStack.length; }

/** Clears all undo and redo history. */
function clearHistory() {
  _undoStack.length = 0;
  _redoStack.length = 0;
}

// ─── Checkpoints ──────────────────────────────────────────────────────────

let _checkpointIdCounter = 0;

/**
 * Each checkpoint:
 * {
 *   id        : number   — unique id
 *   label     : string   — human label
 *   savedAt   : string   — ISO timestamp
 *   snapshot  : object   — deep-cloned state
 * }
 */
const _checkpoints = [];

/**
 * Saves a checkpoint. Returns the checkpoint object.
 * @param {object} snapshot — from Model.cloneState()
 * @param {string} label
 * @returns {object} checkpoint
 */
function saveCheckpoint(snapshot, label) {
  const checkpoint = {
    id: ++_checkpointIdCounter,
    label: label || `Checkpoint ${_checkpointIdCounter}`,
    savedAt: new Date().toLocaleTimeString(),
    snapshot: JSON.parse(JSON.stringify(snapshot)),
  };
  // Embed label/time in snapshot for rollback descriptions
  checkpoint.snapshot._label = checkpoint.label;
  checkpoint.snapshot._savedAt = checkpoint.savedAt;
  _checkpoints.push(checkpoint);
  return checkpoint;
}

/** Returns all checkpoints (array, newest last). */
function getCheckpoints() { return [..._checkpoints]; }

/**
 * Deletes a checkpoint by id.
 * @returns {boolean} true if found and removed
 */
function deleteCheckpoint(id) {
  const idx = _checkpoints.findIndex((c) => c.id === id);
  if (idx === -1) return false;
  _checkpoints.splice(idx, 1);
  return true;
}

/** Removes all checkpoints. */
function clearCheckpoints() { _checkpoints.length = 0; }

/** Returns true if there is at least one checkpoint. */
function hasCheckpoints() { return _checkpoints.length > 0; }

export {
  pushUndo, undo, redo,
  getUndoCount, getRedoCount, clearHistory,
  saveCheckpoint, getCheckpoints, deleteCheckpoint,
  clearCheckpoints, hasCheckpoints,
};

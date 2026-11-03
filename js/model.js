/**
 * model.js — Pure data model for the Deadlock Detection Simulator.
 * No DOM access. All mutations return { ok: bool, error: string }.
 * Extended in Phase 5-7 to include processMeta (priority, preemptCount).
 */

/**
 * The central state object:
 *   processes   : string[]
 *   resources   : { id: string, total: number }[]
 *   allocation  : { [pid]: { [rid]: number } }
 *   request     : { [pid]: { [rid]: number } }
 *   processMeta : { [pid]: { priority: number, preemptCount: number } }
 *
 * NOTE: `available` is NEVER stored; always computed via getAvailable().
 */
const _state = {
  processes: [],
  resources: [],
  allocation: {},
  request: {},
  processMeta: {},
};

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Returns true if v is a non-negative integer. */
function isNonNegInt(v) {
  return Number.isInteger(v) && v >= 0;
}

/** Deep-clone the state (useful for snapshots / recovery module). */
function cloneState() {
  return JSON.parse(JSON.stringify(_state));
}

/** Returns the total instances allocated for a resource across all processes. */
function _totalAllocated(rid) {
  return _state.processes.reduce(
    (sum, pid) => sum + (_state.allocation[pid]?.[rid] ?? 0),
    0
  );
}

// ─── Read-only accessors ───────────────────────────────────────────────────

/**
 * Returns available[rid] for every resource.
 * available[rid] = total[rid] − Σ allocation[p][rid]
 */
function getAvailable() {
  const available = {};
  for (const { id, total } of _state.resources) {
    available[id] = total - _totalAllocated(id);
  }
  return available;
}

/** Returns a shallow-safe view of the current state (not a deep clone). */
function getState() {
  return _state;
}

/** Returns process meta for a single process (priority, preemptCount). */
function getProcessMeta(pid) {
  return _state.processMeta[pid] ?? { priority: 1, preemptCount: 0 };
}

/** Returns all process metadata map. */
function getAllProcessMeta() {
  return _state.processMeta;
}

// ─── Process CRUD ──────────────────────────────────────────────────────────

/**
 * Adds a new process.
 * @param {string} pid
 * @param {number} [priority=1]
 * @returns {{ ok: boolean, error?: string }}
 */
function addProcess(pid, priority = 1) {
  pid = String(pid).trim();
  if (!pid) return { ok: false, error: "Process ID cannot be empty." };
  if (/\s/.test(pid)) return { ok: false, error: "Process ID must not contain spaces." };
  if (_state.processes.includes(pid))
    return { ok: false, error: `Process "${pid}" already exists.` };

  priority = Number(priority);
  if (!Number.isInteger(priority) || priority < 1)
    return { ok: false, error: "Priority must be a positive integer." };

  _state.processes.push(pid);
  _state.allocation[pid] = {};
  _state.request[pid] = {};
  _state.processMeta[pid] = { priority, preemptCount: 0 };
  for (const { id: rid } of _state.resources) {
    _state.allocation[pid][rid] = 0;
    _state.request[pid][rid] = 0;
  }
  return { ok: true };
}

/**
 * Removes a process and its rows from both matrices.
 */
function removeProcess(pid) {
  const idx = _state.processes.indexOf(pid);
  if (idx === -1) return { ok: false, error: `Process "${pid}" not found.` };
  _state.processes.splice(idx, 1);
  delete _state.allocation[pid];
  delete _state.request[pid];
  delete _state.processMeta[pid];
  return { ok: true };
}

// ─── Resource CRUD ─────────────────────────────────────────────────────────

/**
 * Adds a new resource.
 * @param {string} rid
 * @param {number} total — positive integer
 */
function addResource(rid, total) {
  rid = String(rid).trim();
  if (!rid) return { ok: false, error: "Resource ID cannot be empty." };
  if (/\s/.test(rid)) return { ok: false, error: "Resource ID must not contain spaces." };
  if (_state.resources.some((r) => r.id === rid))
    return { ok: false, error: `Resource "${rid}" already exists.` };

  total = Number(total);
  if (!isNonNegInt(total) || total < 1)
    return { ok: false, error: "Total instances must be a positive integer." };

  _state.resources.push({ id: rid, total });
  for (const pid of _state.processes) {
    _state.allocation[pid][rid] = 0;
    _state.request[pid][rid] = 0;
  }
  return { ok: true };
}

/**
 * Removes a resource and its columns from both matrices.
 */
function removeResource(rid) {
  const idx = _state.resources.findIndex((r) => r.id === rid);
  if (idx === -1) return { ok: false, error: `Resource "${rid}" not found.` };
  _state.resources.splice(idx, 1);
  for (const pid of _state.processes) {
    delete _state.allocation[pid]?.[rid];
    delete _state.request[pid]?.[rid];
  }
  return { ok: true };
}

// ─── Matrix setters ────────────────────────────────────────────────────────

/**
 * Sets allocation[pid][rid] = count.
 * Validates total allocation does not exceed resource total.
 */
function setAllocation(pid, rid, count) {
  count = Number(count);
  if (!isNonNegInt(count))
    return { ok: false, error: `Allocation must be a non-negative integer (got ${count}).` };
  if (!_state.processes.includes(pid))
    return { ok: false, error: `Process "${pid}" not found.` };

  const res = _state.resources.find((r) => r.id === rid);
  if (!res) return { ok: false, error: `Resource "${rid}" not found.` };

  const otherAlloc = _state.processes
    .filter((p) => p !== pid)
    .reduce((s, p) => s + (_state.allocation[p]?.[rid] ?? 0), 0);

  if (otherAlloc + count > res.total)
    return {
      ok: false,
      error: `Allocation exceeds total instances of "${rid}" (${res.total}). Others hold ${otherAlloc}.`,
    };

  _state.allocation[pid][rid] = count;
  return { ok: true };
}

/**
 * Sets request[pid][rid] = count.
 * Validates count does not exceed resource total.
 */
function setRequest(pid, rid, count) {
  count = Number(count);
  if (!isNonNegInt(count))
    return { ok: false, error: `Request must be a non-negative integer (got ${count}).` };
  if (!_state.processes.includes(pid))
    return { ok: false, error: `Process "${pid}" not found.` };

  const res = _state.resources.find((r) => r.id === rid);
  if (!res) return { ok: false, error: `Resource "${rid}" not found.` };

  if (count > res.total)
    return {
      ok: false,
      error: `Request for "${rid}" (${count}) exceeds total instances (${res.total}).`,
    };

  _state.request[pid][rid] = count;
  return { ok: true };
}

/**
 * Sets the priority for a process (positive integer, higher = more important).
 */
function setPriority(pid, priority) {
  priority = Number(priority);
  if (!Number.isInteger(priority) || priority < 1)
    return { ok: false, error: "Priority must be a positive integer." };
  if (!_state.processes.includes(pid))
    return { ok: false, error: `Process "${pid}" not found.` };
  _state.processMeta[pid] = { ..._state.processMeta[pid], priority };
  return { ok: true };
}

/**
 * Increments the preemptCount for a process (for starvation tracking).
 */
function incrementPreemptCount(pid) {
  if (!_state.processMeta[pid]) return;
  _state.processMeta[pid].preemptCount = (_state.processMeta[pid].preemptCount ?? 0) + 1;
}

/** Resets all preemptCounts to 0. */
function resetAllPreemptCounts() {
  for (const pid of _state.processes) {
    if (_state.processMeta[pid]) _state.processMeta[pid].preemptCount = 0;
  }
}

// ─── Bulk load / reset ─────────────────────────────────────────────────────

/**
 * Completely replaces the state with a deep copy of snapshot.
 * Used by preset loader, recovery module, and undo/redo.
 */
function loadState(snapshot) {
  const s = JSON.parse(JSON.stringify(snapshot));
  _state.processes = s.processes ?? [];
  _state.resources = s.resources ?? [];
  _state.allocation = s.allocation ?? {};
  _state.request = s.request ?? {};
  // Initialise missing processMeta for backward compatibility
  _state.processMeta = s.processMeta ?? {};
  for (const pid of _state.processes) {
    if (!_state.processMeta[pid]) {
      _state.processMeta[pid] = { priority: 1, preemptCount: 0 };
    }
  }
}

/** Resets the state to empty. */
function resetState() {
  _state.processes = [];
  _state.resources = [];
  _state.allocation = {};
  _state.request = {};
  _state.processMeta = {};
}

export {
  addProcess, removeProcess,
  addResource, removeResource,
  setAllocation, setRequest,
  setPriority, incrementPreemptCount, resetAllPreemptCounts,
  getAvailable, getState, cloneState,
  getProcessMeta, getAllProcessMeta,
  loadState, resetState,
};

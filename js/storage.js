/**
 * storage.js — localStorage save/load and JSON export/import.
 * DOM access is limited to creating download links and reading file inputs.
 * All localStorage operations are wrapped in try/catch.
 */

const LS_PREFIX = "deadlock-sim:scenario:";
const SCHEMA_VERSION = 1;

// ─── Validation ────────────────────────────────────────────────────────────

/**
 * Validates a raw parsed snapshot object.
 * Checks: required fields, no negative numbers, allocation within totals,
 *         matching ids in matrices.
 * @returns {{ ok: boolean, error?: string }}
 */
function validateSnapshot(raw) {
  if (!raw || typeof raw !== "object")
    return { ok: false, error: "Invalid JSON: expected an object." };
  if (!Array.isArray(raw.processes))
    return { ok: false, error: "Missing or invalid 'processes' array." };
  if (!Array.isArray(raw.resources))
    return { ok: false, error: "Missing or invalid 'resources' array." };
  if (!raw.allocation || typeof raw.allocation !== "object")
    return { ok: false, error: "Missing or invalid 'allocation' object." };
  if (!raw.request || typeof raw.request !== "object")
    return { ok: false, error: "Missing or invalid 'request' object." };

  // Validate resources
  for (const r of raw.resources) {
    if (!r.id || typeof r.id !== "string")
      return { ok: false, error: `Resource missing or invalid id: ${JSON.stringify(r)}.` };
    if (!Number.isInteger(r.total) || r.total < 1)
      return { ok: false, error: `Resource "${r.id}" total must be a positive integer.` };
  }

  const rids = raw.resources.map((r) => r.id);
  const pidSet = new Set(raw.processes);

  // Check for duplicate process ids
  if (pidSet.size !== raw.processes.length)
    return { ok: false, error: "Duplicate process IDs found." };

  // Check for duplicate resource ids
  const ridSet = new Set(rids);
  if (ridSet.size !== rids.length)
    return { ok: false, error: "Duplicate resource IDs found." };

  // Validate allocation and request per process
  for (const pid of raw.processes) {
    if (typeof pid !== "string" || !pid.trim())
      return { ok: false, error: `Invalid process ID: ${JSON.stringify(pid)}.` };

    for (const rid of rids) {
      const alloc = raw.allocation[pid]?.[rid] ?? 0;
      const req   = raw.request[pid]?.[rid] ?? 0;

      if (!Number.isInteger(alloc) || alloc < 0)
        return { ok: false, error: `allocation["${pid}"]["${rid}"] must be a non-negative integer.` };
      if (!Number.isInteger(req) || req < 0)
        return { ok: false, error: `request["${pid}"]["${rid}"] must be a non-negative integer.` };

      const res = raw.resources.find((r) => r.id === rid);
      if (req > res.total)
        return { ok: false, error: `request["${pid}"]["${rid}"] (${req}) exceeds total instances (${res.total}).` };
    }
  }

  // Validate total allocation per resource does not exceed total
  for (const { id: rid, total } of raw.resources) {
    const used = raw.processes.reduce((s, pid) => s + (raw.allocation[pid]?.[rid] ?? 0), 0);
    if (used > total)
      return { ok: false, error: `Total allocation of "${rid}" (${used}) exceeds total instances (${total}).` };
  }

  return { ok: true };
}

// ─── localStorage ──────────────────────────────────────────────────────────

/**
 * Saves a scenario to localStorage under a given name.
 * @param {string} name
 * @param {object} snapshot — from Model.cloneState()
 * @returns {{ ok: boolean, error?: string }}
 */
function saveScenario(name, snapshot) {
  name = String(name).trim();
  if (!name) return { ok: false, error: "Scenario name cannot be empty." };
  try {
    const data = JSON.stringify({
      version: SCHEMA_VERSION,
      savedAt: new Date().toISOString(),
      snapshot,
    });
    localStorage.setItem(LS_PREFIX + name, data);
    return { ok: true };
  } catch (e) {
    if (e.name === "QuotaExceededError")
      return { ok: false, error: "Storage is full. Delete some saved scenarios first." };
    return { ok: false, error: `Could not save: ${e.message}` };
  }
}

/**
 * Lists all saved scenarios.
 * @returns {Array<{ name: string, savedAt: string }>}
 */
function listScenarios() {
  const scenarios = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key.startsWith(LS_PREFIX)) continue;
      const name = key.slice(LS_PREFIX.length);
      try {
        const raw = JSON.parse(localStorage.getItem(key));
        scenarios.push({ name, savedAt: raw.savedAt ?? "unknown" });
      } catch {
        scenarios.push({ name, savedAt: "corrupted" });
      }
    }
  } catch (e) {
    // localStorage might be unavailable (private mode etc.)
  }
  return scenarios.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Loads a scenario from localStorage by name.
 * @returns {{ ok: boolean, snapshot?: object, error?: string }}
 */
function loadScenario(name) {
  try {
    const raw = localStorage.getItem(LS_PREFIX + name);
    if (raw === null) return { ok: false, error: `Scenario "${name}" not found.` };
    const data = JSON.parse(raw);
    if (!data.snapshot) return { ok: false, error: `Scenario "${name}" has corrupted data (missing snapshot).` };
    const valid = validateSnapshot(data.snapshot);
    if (!valid.ok) return { ok: false, error: `Scenario "${name}" is invalid: ${valid.error}` };
    return { ok: true, snapshot: data.snapshot };
  } catch (e) {
    return { ok: false, error: `Could not load scenario "${name}": ${e.message}` };
  }
}

/**
 * Deletes a scenario from localStorage.
 * @returns {{ ok: boolean, error?: string }}
 */
function deleteScenario(name) {
  try {
    const key = LS_PREFIX + name;
    if (localStorage.getItem(key) === null)
      return { ok: false, error: `Scenario "${name}" not found.` };
    localStorage.removeItem(key);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `Could not delete scenario: ${e.message}` };
  }
}

// ─── JSON Export ───────────────────────────────────────────────────────────

/**
 * Triggers a browser download of the state as a .json file.
 * @param {object} snapshot — from Model.cloneState()
 * @param {string} [filename]
 */
function exportJSON(snapshot, filename) {
  const data = JSON.stringify(
    { version: SCHEMA_VERSION, exportedAt: new Date().toISOString(), snapshot },
    null,
    2
  );
  const blob = new Blob([data], { type: "application/json" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href     = url;
  a.download = filename || `deadlock-state-${Date.now()}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ─── JSON Import ───────────────────────────────────────────────────────────

/**
 * Reads and validates a JSON file chosen by the user.
 * @param {File} file — from an <input type="file"> change event
 * @returns {Promise<{ ok: boolean, snapshot?: object, error?: string }>}
 */
function importJSON(file) {
  return new Promise((resolve) => {
    if (!file) {
      resolve({ ok: false, error: "No file selected." });
      return;
    }
    if (!file.name.endsWith(".json")) {
      resolve({ ok: false, error: "File must be a .json file." });
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = JSON.parse(e.target.result);
        // Support both wrapped format and bare snapshots
        const snapshot = data.snapshot ?? data;
        const valid = validateSnapshot(snapshot);
        if (!valid.ok) {
          resolve({ ok: false, error: `Invalid file: ${valid.error}` });
          return;
        }
        resolve({ ok: true, snapshot });
      } catch (err) {
        resolve({ ok: false, error: `Could not parse JSON: ${err.message}` });
      }
    };
    reader.onerror = () => {
      resolve({ ok: false, error: "Failed to read file." });
    };
    reader.readAsText(file);
  });
}

export {
  validateSnapshot,
  saveScenario, listScenarios, loadScenario, deleteScenario,
  exportJSON, importJSON,
};

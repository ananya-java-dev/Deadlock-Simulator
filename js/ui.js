/**
 * ui.js — All DOM manipulation: forms, tables, panels, banners, error display.
 * Receives callbacks from main.js so that it stays decoupled from the model
 * and detector directly.
 */

// ─── Error / success flash ─────────────────────────────────────────────────

/**
 * Shows an error message in the given container element.
 * @param {HTMLElement} el  — the error-display div
 * @param {string} msg
 */
function showError(el, msg) {
  el.textContent = msg;
  el.classList.add("visible");
  clearTimeout(el._timer);
  el._timer = setTimeout(() => hideError(el), 6000);
}

function hideError(el) {
  el.classList.remove("visible");
  el.textContent = "";
}

// ─── Matrix rendering ──────────────────────────────────────────────────────

/**
 * Renders the Allocation and Request matrices as editable HTML tables,
 * and the Available vector as a read-only row.
 *
 * @param {HTMLElement} matrixPanel
 * @param {object} state       — from model.getState()
 * @param {object} available   — from model.getAvailable()
 * @param {Function} onAllocChange  — (pid, rid, value) => result
 * @param {Function} onReqChange    — (pid, rid, value) => result
 * @param {Function} onRemoveProcess — (pid) => void
 * @param {Function} onRemoveResource — (rid) => void
 */
function renderMatrices(
  matrixPanel,
  state,
  available,
  onAllocChange,
  onReqChange,
  onRemoveProcess,
  onRemoveResource
) {
  const { processes, resources, allocation, request } = state;

  matrixPanel.innerHTML = "";

  if (processes.length === 0 || resources.length === 0) {
    matrixPanel.innerHTML =
      "<p class='empty-hint'>Add at least one process and one resource to see matrices.</p>";
    return;
  }

  // ── Allocation table ──────────────────────────────────────────────────
  matrixPanel.appendChild(makeMatrixTable(
    "Allocation",
    processes, resources, allocation,
    true, onAllocChange, onRemoveProcess, onRemoveResource
  ));

  // ── Request table ─────────────────────────────────────────────────────
  matrixPanel.appendChild(makeMatrixTable(
    "Request",
    processes, resources, request,
    true, onReqChange, null, null
  ));

  // ── Available row ──────────────────────────────────────────────────────
  const avSection = document.createElement("div");
  avSection.className = "matrix-section";

  const avTitle = document.createElement("h4");
  avTitle.textContent = "Available";
  avSection.appendChild(avTitle);

  const avTable = document.createElement("table");
  avTable.className = "matrix-table";

  // Header
  const thead = avTable.createTHead();
  const hRow = thead.insertRow();
  for (const { id: rid } of resources) {
    const th = document.createElement("th");
    th.textContent = rid;
    hRow.appendChild(th);
  }

  // Values
  const tbody = avTable.createTBody();
  const vRow = tbody.insertRow();
  for (const { id: rid } of resources) {
    const td = vRow.insertCell();
    td.textContent = available[rid] ?? 0;
    td.className = "avail-cell";
  }

  avSection.appendChild(avTable);
  matrixPanel.appendChild(avSection);
}

/**
 * Builds one editable (or read-only) matrix table.
 */
function makeMatrixTable(
  title,
  processes,
  resources,
  matrix,
  editable,
  onChange,
  onRemoveProcess,
  onRemoveResource
) {
  const section = document.createElement("div");
  section.className = "matrix-section";

  const h4 = document.createElement("h4");
  h4.textContent = title;
  section.appendChild(h4);

  const table = document.createElement("table");
  table.className = "matrix-table";

  // ── Header row: resource ids ───────────────────────────────────────────
  const thead = table.createTHead();
  const hRow = thead.insertRow();

  // empty corner cell
  const corner = document.createElement("th");
  corner.textContent = "P \\ R";
  hRow.appendChild(corner);

  for (const { id: rid } of resources) {
    const th = document.createElement("th");
    th.textContent = rid;

    // Add remove-resource button only in Allocation table
    if (onRemoveResource) {
      const btn = document.createElement("button");
      btn.textContent = "×";
      btn.className = "remove-btn";
      btn.title = `Remove resource ${rid}`;
      btn.addEventListener("click", () => onRemoveResource(rid));
      th.appendChild(btn);
    }
    hRow.appendChild(th);
  }

  // ── Body: one row per process ──────────────────────────────────────────
  const tbody = table.createTBody();
  for (const pid of processes) {
    const row = tbody.insertRow();

    // Process label cell
    const labelCell = row.insertCell();
    labelCell.className = "proc-label";
    labelCell.textContent = pid;

    if (onRemoveProcess) {
      const btn = document.createElement("button");
      btn.textContent = "×";
      btn.className = "remove-btn";
      btn.title = `Remove process ${pid}`;
      btn.addEventListener("click", () => onRemoveProcess(pid));
      labelCell.appendChild(btn);
    }

    // Value cells per resource
    for (const { id: rid } of resources) {
      const td = row.insertCell();
      const val = matrix[pid]?.[rid] ?? 0;

      if (editable) {
        const input = document.createElement("input");
        input.type = "number";
        input.min = "0";
        input.step = "1";
        input.value = val;
        input.className = "matrix-input";
        input.dataset.pid = pid;
        input.dataset.rid = rid;

        input.addEventListener("change", (e) => {
          const v = parseInt(e.target.value, 10);
          if (isNaN(v)) { e.target.value = val; return; }
          onChange(pid, rid, v, e.target);
        });

        td.appendChild(input);
      } else {
        td.textContent = val;
      }
    }
  }

  table.appendChild(tbody);
  section.appendChild(table);
  return section;
}

// ─── Detection log ─────────────────────────────────────────────────────────

/**
 * Renders the step-by-step detection log.
 * @param {HTMLElement} logPanel
 * @param {Array} steps   — from detectDeadlock().steps
 * @param {string[]} rids — resource ids for column headers
 */
function renderDetectionLog(logPanel, steps, rids) {
  logPanel.innerHTML = "";

  if (!steps || steps.length === 0) {
    logPanel.innerHTML = "<p class='empty-hint'>Run detection to see the algorithm trace.</p>";
    return;
  }

  const table = document.createElement("table");
  table.className = "log-table";

  // Header
  const thead = table.createTHead();
  const hRow = thead.insertRow();
  ["Step", "Process", "Work Before", "Work After", "Explanation"].forEach((text) => {
    const th = document.createElement("th");
    th.textContent = text;
    hRow.appendChild(th);
  });

  const tbody = table.createTBody();
  for (const step of steps) {
    const row = tbody.insertRow();
    row.insertCell().textContent = step.stepNum;
    row.insertCell().textContent = step.process ?? "—";
    row.insertCell().textContent = formatVec(step.workBefore, rids);
    row.insertCell().textContent = formatVec(step.workAfter, rids);
    const expCell = row.insertCell();
    expCell.textContent = step.explanation;
    expCell.className = "explanation-cell";
    if (!step.process) row.classList.add("stuck-row");
  }

  table.appendChild(tbody);
  logPanel.appendChild(table);
}

function formatVec(vec, rids) {
  if (!vec || rids.length === 0) return "[]";
  return "[" + rids.map((r) => vec[r] ?? 0).join(", ") + "]";
}

// ─── Verdict banner ────────────────────────────────────────────────────────

/**
 * Renders the final verdict banner.
 * @param {HTMLElement} bannerEl
 * @param {{ isDeadlock, deadlockedProcesses, completionSequence }} result
 */
function renderVerdict(bannerEl, result) {
  bannerEl.className = "verdict-banner";
  if (result.isDeadlock) {
    bannerEl.classList.add("verdict-deadlock");
    bannerEl.innerHTML =
      `<span class="verdict-icon">🔴</span>` +
      `<span><strong>Deadlock detected!</strong> ` +
      `Deadlocked processes: <strong>${result.deadlockedProcesses.join(", ")}</strong></span>`;
  } else {
    bannerEl.classList.add("verdict-safe");
    bannerEl.innerHTML =
      `<span class="verdict-icon">🟢</span>` +
      `<span><strong>No deadlock.</strong> ` +
      `Completion sequence: <strong>${result.completionSequence.join(" → ")}</strong></span>`;
  }
  bannerEl.style.display = "flex";
}

/** Hides the verdict banner. */
function clearVerdict(bannerEl) {
  bannerEl.style.display = "none";
  bannerEl.className = "verdict-banner";
  bannerEl.innerHTML = "";
}

// ─── Preset dropdown ───────────────────────────────────────────────────────

/**
 * Populates a <select> element with preset options.
 * @param {HTMLSelectElement} selectEl
 * @param {Array<{label:string}>} presets
 */
function populatePresetDropdown(selectEl, presets) {
  // Keep the placeholder option
  presets.forEach((p, i) => {
    const opt = document.createElement("option");
    opt.value = i;
    opt.textContent = p.label;
    selectEl.appendChild(opt);
  });
}

export {
  showError,
  hideError,
  renderMatrices,
  renderDetectionLog,
  renderVerdict,
  clearVerdict,
  populatePresetDropdown,
};

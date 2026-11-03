/**
 * main.js — Wires ALL modules together: model, detector, graph, ui,
 *           recovery, history, storage and compare.
 * This is the only file that imports from all other modules.
 */

import * as Model    from "./model.js";
import { detectDeadlock }    from "./detector.js";
import { initGraph, rebuildGraph, highlightDeadlock, clearHighlights, fitGraph } from "./graph.js";
import { showError, renderMatrices, renderDetectionLog, renderVerdict, clearVerdict, populatePresetDropdown } from "./ui.js";
import { terminateProcess, terminateAll, terminateByPolicy, preemptResource, suggestPreemptVictim, rollbackSystem, rollbackProcess, computeAvailable } from "./recovery.js";
import { pushUndo, undo, redo, getUndoCount, getRedoCount, clearHistory, saveCheckpoint, getCheckpoints, deleteCheckpoint, clearCheckpoints, hasCheckpoints } from "./history.js";
import { saveScenario, listScenarios, loadScenario, deleteScenario, exportJSON, importJSON } from "./storage.js";
import { renderBeforeAfter, clearBeforeAfter } from "./compare.js";

// ═══════════════════════════════════════════════════════════════════════════
//  PRESETS
// ═══════════════════════════════════════════════════════════════════════════

const PRESETS = [
  {
    label: "1 — Classic Deadlock (2 procs, 2 resources)",
    state: {
      processes: ["P1","P2"],
      resources: [{ id:"R1",total:1 },{ id:"R2",total:1 }],
      allocation: { P1:{R1:1,R2:0}, P2:{R1:0,R2:1} },
      request:    { P1:{R1:0,R2:1}, P2:{R1:1,R2:0} },
      processMeta:{ P1:{priority:2,preemptCount:0}, P2:{priority:1,preemptCount:0} },
    },
  },
  {
    label: "2 — Cycle but NO Deadlock (multi-instance saves it)",
    state: {
      processes: ["P1","P2","P3"],
      resources: [{ id:"R1",total:2 },{ id:"R2",total:1 }],
      allocation: { P1:{R1:1,R2:0}, P2:{R1:1,R2:1}, P3:{R1:0,R2:0} },
      request:    { P1:{R1:0,R2:1}, P2:{R1:0,R2:0}, P3:{R1:0,R2:0} },
      processMeta:{ P1:{priority:1,preemptCount:0}, P2:{priority:1,preemptCount:0}, P3:{priority:1,preemptCount:0} },
    },
  },
  {
    label: "3 — Fully Safe State (no waiting)",
    state: {
      processes: ["P1","P2","P3"],
      resources: [{ id:"R1",total:4 },{ id:"R2",total:3 }],
      allocation: { P1:{R1:1,R2:1}, P2:{R1:1,R2:0}, P3:{R1:0,R2:1} },
      request:    { P1:{R1:0,R2:0}, P2:{R1:0,R2:0}, P3:{R1:0,R2:0} },
      processMeta:{ P1:{priority:1,preemptCount:0}, P2:{priority:1,preemptCount:0}, P3:{priority:1,preemptCount:0} },
    },
  },
  {
    label: "4 — Deadlock Fixed by One Termination",
    state: {
      processes: ["P1","P2","P3"],
      resources: [{ id:"R1",total:1 },{ id:"R2",total:1 },{ id:"R3",total:1 }],
      allocation: { P1:{R1:1,R2:0,R3:0}, P2:{R1:0,R2:1,R3:0}, P3:{R1:0,R2:0,R3:1} },
      request:    { P1:{R1:0,R2:1,R3:0}, P2:{R1:0,R2:0,R3:1}, P3:{R1:1,R2:0,R3:0} },
      processMeta:{ P1:{priority:3,preemptCount:0}, P2:{priority:1,preemptCount:0}, P3:{priority:2,preemptCount:0} },
    },
  },
  {
    label: "5 — Deadlock Fixed by Preemption",
    state: {
      processes: ["P1","P2"],
      resources: [{ id:"R1",total:1 },{ id:"R2",total:1 }],
      // Classic deadlock: P1 holds R1 wants R2; P2 holds R2 wants R1.
      // Fix via preemption: take R2 from P2 (victim) → give to P1 (recipient).
      // After: P1 gets R2 it requested, finishes, releases R1 → P2 can proceed.
      allocation: { P1:{R1:1,R2:0}, P2:{R1:0,R2:1} },
      request:    { P1:{R1:0,R2:1}, P2:{R1:1,R2:0} },
      processMeta:{ P1:{priority:2,preemptCount:0}, P2:{priority:1,preemptCount:0} },
    },
  },
  {
    label: "6 — Deadlock with Safe Checkpoint for Rollback",
    state: {
      processes: ["P1","P2"],
      resources: [{ id:"R1",total:2 },{ id:"R2",total:2 }],
      // Current state: each holds 1 of each, wants 1 more of the other
      allocation: { P1:{R1:1,R2:0}, P2:{R1:0,R2:1} },
      request:    { P1:{R1:0,R2:1}, P2:{R1:1,R2:0} },
      processMeta:{ P1:{priority:1,preemptCount:0}, P2:{priority:1,preemptCount:0} },
    },
    // This preset includes a built-in checkpoint (loaded by main.js after loading state)
    checkpoint: {
      label: "Safe state (before deadlock)",
      snapshot: {
        processes: ["P1","P2"],
        resources: [{ id:"R1",total:2 },{ id:"R2",total:2 }],
        allocation: { P1:{R1:0,R2:0}, P2:{R1:0,R2:0} },
        request:    { P1:{R1:0,R2:0}, P2:{R1:0,R2:0} },
        processMeta:{ P1:{priority:1,preemptCount:0}, P2:{priority:1,preemptCount:0} },
      },
    },
  },
];

// ═══════════════════════════════════════════════════════════════════════════
//  DOM REFERENCES
// ═══════════════════════════════════════════════════════════════════════════

const $ = (id) => document.getElementById(id);

// Graph
const graphContainer = $("graph-container");
const btnFit         = $("btn-fit");

// Header controls
const presetSelect   = $("preset-select");
const btnDetect      = $("btn-detect");
const btnReset       = $("btn-reset");
const btnUndo        = $("btn-undo");
const btnRedo        = $("btn-redo");
const undoCount      = $("undo-count");
const redoCount      = $("redo-count");

// Panels
const matrixPanel    = $("matrix-panel");
const logPanel       = $("log-panel");
const verdictBanner  = $("verdict-banner");
const errorGeneral   = $("error-general");

// Process form
const formAddProcess = $("form-add-process");
const inputPid       = $("input-pid");
const inputPriority  = $("input-priority");
const errorProcess   = $("error-process");

// Resource form
const formAddResource = $("form-add-resource");
const inputRid        = $("input-rid");
const inputTotal      = $("input-total");
const errorResource   = $("error-resource");

// Recovery panel
const recoveryPanel      = $("recovery-panel");
const tabTerminate       = $("tab-terminate");
const tabPreempt         = $("tab-preempt");
const tabRollback        = $("tab-rollback");
const paneTerminate      = $("pane-terminate");
const panePreempt        = $("pane-preempt");
const paneRollback       = $("pane-rollback");

// Termination controls
const termPidSelect      = $("term-pid-select");
const btnTermOne         = $("btn-term-one");
const btnTermAll         = $("btn-term-all");
const termPolicySelect   = $("term-policy-select");
const btnTermPolicy      = $("btn-term-policy");

// Preemption controls
const preemptVictim      = $("preempt-victim");
const preemptRid         = $("preempt-rid");
const preemptCount2      = $("preempt-count");
const preemptRecipient   = $("preempt-recipient");
const btnPreempt         = $("btn-preempt");
const btnSuggestVictim   = $("btn-suggest-victim");
const preemptWarn        = $("preempt-warn");

// Rollback controls
const rollbackCkptSelect = $("rollback-ckpt-select");
const rollbackPidSelect  = $("rollback-pid-select");
const btnRollbackSystem  = $("btn-rollback-system");
const btnRollbackProcess = $("btn-rollback-process");
const rollbackNone       = $("rollback-none");
const btnSaveCkpt        = $("btn-save-ckpt");

// Before/After panel
const comparePanel       = $("compare-panel");
const comparePanelWrap   = $("compare-panel-wrap");

// Recovery history
const recoveryHistoryList = $("recovery-history-list");

// Storage
const inputScenarioName  = $("input-scenario-name");
const btnSaveScenario    = $("btn-save-scenario");
const scenarioList       = $("scenario-list");
const btnExport          = $("btn-export");
const inputImport        = $("input-import");

// Checkpoint save
const inputCkptLabel     = $("input-ckpt-label");

// Toast
const toastContainer     = $("toast-container");

// ═══════════════════════════════════════════════════════════════════════════
//  GLOBAL STATE
// ═══════════════════════════════════════════════════════════════════════════

const cy = initGraph(graphContainer);
let _lastDetectionResult = null;
let _compareCy = { beforeCy: null, afterCy: null }; // mini graphs

// ═══════════════════════════════════════════════════════════════════════════
//  TOAST NOTIFICATIONS
// ═══════════════════════════════════════════════════════════════════════════

function toast(msg, type = "info") {
  const el = document.createElement("div");
  el.className = `toast toast-${type}`;
  el.textContent = msg;
  toastContainer.appendChild(el);
  // Animate in
  requestAnimationFrame(() => el.classList.add("toast-visible"));
  setTimeout(() => {
    el.classList.remove("toast-visible");
    setTimeout(() => el.remove(), 400);
  }, 3500);
}

// ═══════════════════════════════════════════════════════════════════════════
//  UNDO / REDO UI
// ═══════════════════════════════════════════════════════════════════════════

function updateUndoRedoButtons() {
  const uc = getUndoCount();
  const rc = getRedoCount();
  btnUndo.disabled = uc === 0;
  btnRedo.disabled = rc === 0;
  undoCount.textContent = uc > 0 ? `(${uc})` : "";
  redoCount.textContent  = rc > 0 ? `(${rc})` : "";
}

/** Call before EVERY state-mutating action. */
function snapshotBeforeAction() {
  pushUndo(Model.cloneState());
  updateUndoRedoButtons();
}

btnUndo.addEventListener("click", () => {
  const restored = undo(Model.cloneState());
  if (!restored) { toast("Nothing to undo.", "warn"); return; }
  Model.loadState(restored);
  refresh();
  updateUndoRedoButtons();
  toast("Undo applied.");
});

btnRedo.addEventListener("click", () => {
  const restored = redo(Model.cloneState());
  if (!restored) { toast("Nothing to redo.", "warn"); return; }
  Model.loadState(restored);
  refresh();
  updateUndoRedoButtons();
  toast("Redo applied.");
});

// ═══════════════════════════════════════════════════════════════════════════
//  CORE REFRESH
// ═══════════════════════════════════════════════════════════════════════════

function refresh() {
  const state     = Model.getState();
  const available = Model.getAvailable();

  rebuildGraph(cy, state, available);
  clearHighlights(cy);

  _lastDetectionResult = null;
  clearVerdict(verdictBanner);
  renderDetectionLog(logPanel, [], state.resources.map((r) => r.id));

  renderMatrices(matrixPanel, state, available,
    handleAllocChange, handleReqChange,
    handleRemoveProcess, handleRemoveResource);

  // Disable recovery panel until detection is run
  setRecoveryEnabled(false);
  clearBeforeAfter(comparePanelWrap);
  updateUndoRedoButtons();
  updateCheckpointUI();
  updateScenarioList();
}

function refreshGraphOnly() {
  const state     = Model.getState();
  const available = Model.getAvailable();
  rebuildGraph(cy, state, available);
  clearHighlights(cy);
  clearVerdict(verdictBanner);
  renderDetectionLog(logPanel, [], state.resources.map((r) => r.id));
  setRecoveryEnabled(false);
}

/** Enable/disable the recovery panel and populate its controls. */
function setRecoveryEnabled(enabled) {
  if (enabled && _lastDetectionResult?.isDeadlock) {
    recoveryPanel.classList.remove("panel-disabled");
    populateRecoveryControls(_lastDetectionResult.deadlockedProcesses);
  } else {
    recoveryPanel.classList.add("panel-disabled");
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  ADD PROCESS / RESOURCE
// ═══════════════════════════════════════════════════════════════════════════

formAddProcess.addEventListener("submit", (e) => {
  e.preventDefault();
  const pid = inputPid.value.trim();
  const priority = parseInt(inputPriority.value, 10) || 1;
  snapshotBeforeAction();
  const result = Model.addProcess(pid, priority);
  if (!result.ok) { showError(errorProcess, result.error); return; }
  inputPid.value = "";
  inputPriority.value = "1";
  refresh();
});

formAddResource.addEventListener("submit", (e) => {
  e.preventDefault();
  const rid   = inputRid.value.trim();
  const total = parseInt(inputTotal.value, 10);
  snapshotBeforeAction();
  const result = Model.addResource(rid, total);
  if (!result.ok) { showError(errorResource, result.error); return; }
  inputRid.value   = "";
  inputTotal.value = "1";
  refresh();
});

// ═══════════════════════════════════════════════════════════════════════════
//  MATRIX CHANGES
// ═══════════════════════════════════════════════════════════════════════════

function handleAllocChange(pid, rid, value, inputEl) {
  snapshotBeforeAction();
  const result = Model.setAllocation(pid, rid, value);
  if (!result.ok) {
    showError(errorGeneral, result.error);
    if (inputEl) inputEl.value = Model.getState().allocation[pid]?.[rid] ?? 0;
    return;
  }
  refreshGraphOnly();
}

function handleReqChange(pid, rid, value, inputEl) {
  snapshotBeforeAction();
  const result = Model.setRequest(pid, rid, value);
  if (!result.ok) {
    showError(errorGeneral, result.error);
    if (inputEl) inputEl.value = Model.getState().request[pid]?.[rid] ?? 0;
    return;
  }
  refreshGraphOnly();
}

function handleRemoveProcess(pid) {
  snapshotBeforeAction();
  const result = Model.removeProcess(pid);
  if (!result.ok) { showError(errorGeneral, result.error); return; }
  refresh();
}

function handleRemoveResource(rid) {
  snapshotBeforeAction();
  const result = Model.removeResource(rid);
  if (!result.ok) { showError(errorGeneral, result.error); return; }
  refresh();
}

// ═══════════════════════════════════════════════════════════════════════════
//  DETECTION
// ═══════════════════════════════════════════════════════════════════════════

function runDetection() {
  const state     = Model.getState();
  const available = Model.getAvailable();
  const rids      = state.resources.map((r) => r.id);

  if (state.processes.length === 0) {
    showError(errorGeneral, "Add at least one process before running detection.");
    return null;
  }

  const result = detectDeadlock(state, available);
  _lastDetectionResult = result;

  rebuildGraph(cy, state, available);
  highlightDeadlock(cy, result, state);
  renderDetectionLog(logPanel, result.steps, rids);
  renderVerdict(verdictBanner, result);
  setRecoveryEnabled(result.isDeadlock);

  // Auto-checkpoint when safe
  if (!result.isDeadlock) {
    const ck = saveCheckpoint(Model.cloneState(), "Auto (safe state)");
    updateCheckpointUI();
    toast(`Safe state auto-saved as checkpoint "${ck.label}".`, "info");
  }

  return result;
}

btnDetect.addEventListener("click", () => runDetection());

// ═══════════════════════════════════════════════════════════════════════════
//  RESET
// ═══════════════════════════════════════════════════════════════════════════

btnReset.addEventListener("click", () => {
  if (!confirm("Reset everything? This will clear the state, undo history, checkpoints and recovery history.")) return;
  Model.resetState();
  clearHistory();
  clearCheckpoints();
  _recoveryHistory.length = 0;
  renderRecoveryHistory();
  presetSelect.value = "";
  _lastDetectionResult = null;
  clearBeforeAfter(comparePanelWrap);
  refresh();
  toast("Reset complete.", "info");
});

// ═══════════════════════════════════════════════════════════════════════════
//  FIT GRAPH
// ═══════════════════════════════════════════════════════════════════════════

btnFit.addEventListener("click", () => fitGraph(cy));

// ═══════════════════════════════════════════════════════════════════════════
//  PRESETS
// ═══════════════════════════════════════════════════════════════════════════

populatePresetDropdown(presetSelect, PRESETS);

presetSelect.addEventListener("change", () => {
  const idx = parseInt(presetSelect.value, 10);
  if (isNaN(idx) || !PRESETS[idx]) return;
  snapshotBeforeAction();
  Model.loadState(PRESETS[idx].state);

  // If preset ships a checkpoint, load it
  if (PRESETS[idx].checkpoint) {
    const ck = PRESETS[idx].checkpoint;
    saveCheckpoint(ck.snapshot, ck.label);
  }

  refresh();

  // Auto-detect
  const result = runDetection();
  toast(`Preset "${PRESETS[idx].label}" loaded.`, "info");
});

// ═══════════════════════════════════════════════════════════════════════════
//  RECOVERY PANEL — TABS
// ═══════════════════════════════════════════════════════════════════════════

[tabTerminate, tabPreempt, tabRollback].forEach((tab) => {
  tab.addEventListener("click", () => {
    [tabTerminate, tabPreempt, tabRollback].forEach((t) => t.classList.remove("active"));
    [paneTerminate, panePreempt, paneRollback].forEach((p) => p.classList.remove("active"));
    tab.classList.add("active");
    $(`pane-${tab.dataset.pane}`).classList.add("active");
  });
});

/** Populates recovery control dropdowns based on deadlocked processes. */
function populateRecoveryControls(deadlockedPids) {
  const state = Model.getState();

  // Termination: list deadlocked processes
  termPidSelect.innerHTML = "";
  for (const pid of deadlockedPids) {
    const opt = document.createElement("option");
    const meta = Model.getProcessMeta(pid);
    opt.value = pid;
    opt.textContent = `${pid} (priority ${meta.priority}, holds: ${
      state.resources.map((r) => `${state.allocation[pid]?.[r.id] ?? 0}`).join("/")
    })`;
    termPidSelect.appendChild(opt);
  }

  // Preemption: all processes as victim candidates
  preemptVictim.innerHTML = `<option value="">— select victim —</option>`;
  preemptRecipient.innerHTML = `<option value="">— select recipient —</option>`;
  for (const pid of state.processes) {
    const meta = Model.getProcessMeta(pid);
    const opt1 = document.createElement("option");
    opt1.value = pid;
    opt1.textContent = `${pid} (preempted ${meta.preemptCount}×)`;
    preemptVictim.appendChild(opt1);

    const opt2 = document.createElement("option");
    opt2.value = pid;
    opt2.textContent = pid;
    preemptRecipient.appendChild(opt2);
  }

  // Preemption: resource list
  preemptRid.innerHTML = `<option value="">— select resource —</option>`;
  for (const { id: rid } of state.resources) {
    const opt = document.createElement("option");
    opt.value = rid;
    opt.textContent = rid;
    preemptRid.appendChild(opt);
  }

  // Rollback: process list
  rollbackPidSelect.innerHTML = `<option value="">— select process —</option>`;
  for (const pid of state.processes) {
    const opt = document.createElement("option");
    opt.value = pid;
    opt.textContent = pid;
    rollbackPidSelect.appendChild(opt);
  }

  updatePreemptWarning();
  updateCheckpointUI();
}

// Update preemption starvation warning when victim changes
preemptVictim.addEventListener("change", updatePreemptWarning);

function updatePreemptWarning() {
  const pid = preemptVictim.value;
  if (!pid) { preemptWarn.style.display = "none"; return; }
  const meta = Model.getProcessMeta(pid);
  if (meta.preemptCount >= 2) {
    preemptWarn.textContent = `⚠ ${pid} has already been preempted ${meta.preemptCount} times — starvation risk!`;
    preemptWarn.style.display = "block";
  } else {
    preemptWarn.style.display = "none";
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  AFTER-RECOVERY PIPELINE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Common post-recovery handler.
 * 1. Snapshot undo, load newState.
 * 2. Rebuild graph with flash highlights.
 * 3. Re-run detection.
 * 4. Render before/after panel.
 * 5. Update recovery history.
 * 6. Show toast.
 *
 * @param {object} beforeState  — state snapshot taken BEFORE recovery
 * @param {object} recoveryResult — { newState, summary, details }
 * @param {string} technique    — label for history
 */
function applyRecovery(beforeState, recoveryResult, technique) {
  snapshotBeforeAction();

  const { newState, summary, details } = recoveryResult;
  Model.loadState(newState);

  const state     = Model.getState();
  const available = Model.getAvailable();
  const beforeAvail = computeAvailable(beforeState);

  // Rebuild graph
  rebuildGraph(cy, state, available);
  _lastDetectionResult = null;
  clearVerdict(verdictBanner);

  // Flash changed/removed nodes yellow for 1.5 s
  flashChanges(cy, beforeState, state);

  // Re-run detection
  const afterResult = detectDeadlock(state, available);
  _lastDetectionResult = afterResult;
  highlightDeadlock(cy, afterResult, state);
  renderDetectionLog(logPanel, afterResult.steps, state.resources.map((r) => r.id));
  renderVerdict(verdictBanner, afterResult);

  // Update matrices with change highlights
  renderMatrices(matrixPanel, state, available,
    handleAllocChange, handleReqChange,
    handleRemoveProcess, handleRemoveResource);
  highlightChangedCells(matrixPanel, beforeState, state);

  // Before/After panel
  const beforeDetect = detectDeadlock(beforeState, computeAvailable(beforeState));
  clearBeforeAfter(comparePanelWrap);
  _compareCy = renderBeforeAfter(
    comparePanelWrap,
    beforeState, state, beforeAvail, available,
    summary, beforeDetect, afterResult
  );
  comparePanel.style.display = "block";

  // Recovery history
  addRecoveryHistory(technique, summary, afterResult);

  // Enable/disable recovery panel
  setRecoveryEnabled(afterResult.isDeadlock);

  // Auto-checkpoint if now safe
  if (!afterResult.isDeadlock) {
    saveCheckpoint(Model.cloneState(), `Auto after ${technique}`);
    updateCheckpointUI();
  }

  updateUndoRedoButtons();
  updateCheckpointUI();

  toast(summary, afterResult.isDeadlock ? "warn" : "success");
}

/** Briefly flash nodes/edges that changed between two states. */
function flashChanges(cy, before, after) {
  // Nodes in before but not after = removed (grey)
  for (const pid of before.processes) {
    if (!after.processes.includes(pid)) {
      const node = cy.$(`#${CSS.escape(pid)}`);
      if (node.length) { node.addClass("changed"); setTimeout(() => node.removeClass("changed"), 1500); }
    }
  }
  // Edges that changed (alloc count differs)
  for (const pid of after.processes) {
    for (const { id: rid } of after.resources) {
      const ba = before.allocation[pid]?.[rid] ?? 0;
      const aa = after.allocation[pid]?.[rid] ?? 0;
      if (ba !== aa) {
        const eid = `alloc-${rid}-${pid}`;
        const edge = cy.$(`#${CSS.escape(eid)}`);
        if (edge.length) { edge.addClass("changed"); setTimeout(() => edge.removeClass("changed"), 1500); }
      }
    }
  }
}

/** Highlights matrix cells whose value changed after recovery. */
function highlightChangedCells(panel, before, after) {
  const inputs = panel.querySelectorAll(".matrix-input");
  inputs.forEach((inp) => {
    const pid = inp.dataset.pid;
    const rid = inp.dataset.rid;
    if (!pid || !rid) return;
    const bVal = before.allocation[pid]?.[rid] ?? before.request?.[pid]?.[rid] ?? 0;
    // Mark if current value in model differs from before
    const curAlloc = after.allocation[pid]?.[rid] ?? 0;
    const curReq   = after.request[pid]?.[rid] ?? 0;
    // Just visually flag the cell for 2 s
    if (curAlloc !== (before.allocation[pid]?.[rid] ?? 0) ||
        curReq   !== (before.request?.[pid]?.[rid] ?? 0)) {
      inp.classList.add("cell-changed");
      setTimeout(() => inp.classList.remove("cell-changed"), 2000);
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════
//  TERMINATION
// ═══════════════════════════════════════════════════════════════════════════

btnTermOne.addEventListener("click", () => {
  const pid = termPidSelect.value;
  if (!pid) { toast("Select a process to terminate.", "warn"); return; }
  const before = Model.cloneState();
  const result = terminateProcess(before, pid);
  applyRecovery(before, result, "Terminate One");
});

btnTermAll.addEventListener("click", () => {
  const pids = _lastDetectionResult?.deadlockedProcesses ?? [];
  if (pids.length === 0) { toast("No deadlocked processes to terminate.", "warn"); return; }
  const before = Model.cloneState();
  const result = terminateAll(before, pids);
  applyRecovery(before, result, "Terminate All");
});

btnTermPolicy.addEventListener("click", () => {
  const policy = termPolicySelect.value;
  const pids   = _lastDetectionResult?.deadlockedProcesses ?? [];
  if (pids.length === 0) { toast("No deadlocked processes.", "warn"); return; }
  const before = Model.cloneState();
  const result = terminateByPolicy(
    before, pids, policy,
    (s, a) => detectDeadlock(s, a)
  );
  // Flatten into a single applyRecovery call with finalState
  applyRecovery(before, { newState: result.finalState, summary: result.summary, details: result.rounds.map((r) => r.reason) }, `Terminate by Policy (${policy})`);
  // Also show rounds in toast
  result.rounds.forEach((r) => toast(`Terminated ${r.pid}: ${r.reason}`, "info"));
});

// ═══════════════════════════════════════════════════════════════════════════
//  PREEMPTION
// ═══════════════════════════════════════════════════════════════════════════

btnSuggestVictim.addEventListener("click", () => {
  const state = Model.getState();
  const suggested = suggestPreemptVictim(state);
  if (suggested) {
    preemptVictim.value = suggested;
    updatePreemptWarning();
    toast(`Suggested victim: ${suggested} (lowest preempt count).`, "info");
  }
});

btnPreempt.addEventListener("click", () => {
  const victim    = preemptVictim.value;
  const rid       = preemptRid.value;
  const count     = parseInt(preemptCount2.value, 10);
  const recipient = preemptRecipient.value;

  if (!victim || !rid || !recipient) {
    showError(errorGeneral, "Select victim, resource and recipient for preemption.");
    return;
  }

  const before = Model.cloneState();
  const result = preemptResource(before, victim, rid, count, recipient);

  if (!result.ok) {
    showError(errorGeneral, result.error);
    return;
  }

  // Persist preemptCount in live model (recovery returns new state, we load it via applyRecovery)
  applyRecovery(before, result, "Resource Preemption");
});

// ═══════════════════════════════════════════════════════════════════════════
//  ROLLBACK
// ═══════════════════════════════════════════════════════════════════════════

function updateCheckpointUI() {
  const cks = getCheckpoints();
  const hasAny = cks.length > 0;

  rollbackNone.style.display = hasAny ? "none" : "block";
  rollbackCkptSelect.disabled = !hasAny;
  btnRollbackSystem.disabled  = !hasAny;
  btnRollbackProcess.disabled = !hasAny;

  // Populate checkpoint dropdown
  rollbackCkptSelect.innerHTML = hasAny ? "" : `<option value="">No checkpoints saved</option>`;
  for (const ck of [...cks].reverse()) { // newest first
    const opt = document.createElement("option");
    opt.value = ck.id;
    opt.textContent = `${ck.label} (${ck.savedAt})`;
    rollbackCkptSelect.appendChild(opt);
  }
}

btnSaveCkpt.addEventListener("click", () => {
  const label = inputCkptLabel.value.trim() || "Manual checkpoint";
  const ck = saveCheckpoint(Model.cloneState(), label);
  inputCkptLabel.value = "";
  updateCheckpointUI();
  toast(`Checkpoint "${ck.label}" saved.`, "success");
});

btnRollbackSystem.addEventListener("click", () => {
  const ckId = parseInt(rollbackCkptSelect.value, 10);
  const ck = getCheckpoints().find((c) => c.id === ckId);
  if (!ck) { toast("Select a valid checkpoint.", "warn"); return; }
  const before = Model.cloneState();
  const result = rollbackSystem(ck.snapshot);
  if (result.warnings.length) result.warnings.forEach((w) => toast(w, "warn"));
  applyRecovery(before, result, "Rollback System");
});

btnRollbackProcess.addEventListener("click", () => {
  const ckId = parseInt(rollbackCkptSelect.value, 10);
  const ck = getCheckpoints().find((c) => c.id === ckId);
  if (!ck) { toast("Select a valid checkpoint.", "warn"); return; }
  const pid = rollbackPidSelect.value;
  if (!pid) { toast("Select a process to roll back.", "warn"); return; }
  const before = Model.cloneState();
  const result = rollbackProcess(before, pid, ck.snapshot);
  if (result.warnings.length) result.warnings.forEach((w) => toast(w, "warn"));
  applyRecovery(before, result, `Rollback Process ${pid}`);
});

// ═══════════════════════════════════════════════════════════════════════════
//  RECOVERY HISTORY
// ═══════════════════════════════════════════════════════════════════════════

const _recoveryHistory = [];

function addRecoveryHistory(technique, summary, detectionResult) {
  _recoveryHistory.unshift({
    technique,
    summary,
    verdict: detectionResult.isDeadlock
      ? `Deadlock persists: ${detectionResult.deadlockedProcesses.join(", ")}`
      : `Resolved — ${detectionResult.completionSequence.join(" → ")}`,
    time: new Date().toLocaleTimeString(),
  });
  renderRecoveryHistory();
}

function renderRecoveryHistory() {
  if (!recoveryHistoryList) return;
  recoveryHistoryList.innerHTML = "";
  if (_recoveryHistory.length === 0) {
    recoveryHistoryList.innerHTML = "<li class='empty-hint'>No recovery actions yet.</li>";
    return;
  }
  for (const h of _recoveryHistory) {
    const li = document.createElement("li");
    li.className = "history-item";
    li.innerHTML = `<span class="history-time">${h.time}</span>
      <span class="history-tech">${h.technique}</span>
      <span class="history-summary">${h.summary}</span>
      <span class="history-verdict ${h.verdict.startsWith("Resolved") ? "verdict-ok" : "verdict-fail"}">${h.verdict}</span>`;
    recoveryHistoryList.appendChild(li);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  SAVE / LOAD SCENARIOS
// ═══════════════════════════════════════════════════════════════════════════

btnSaveScenario.addEventListener("click", () => {
  const name = inputScenarioName.value.trim();
  if (!name) { toast("Enter a name for the scenario.", "warn"); return; }
  const result = saveScenario(name, Model.cloneState());
  if (!result.ok) { toast(result.error, "error"); return; }
  inputScenarioName.value = "";
  toast(`Scenario "${name}" saved.`, "success");
  updateScenarioList();
});

function updateScenarioList() {
  if (!scenarioList) return;
  scenarioList.innerHTML = "";
  const scenarios = listScenarios();
  if (scenarios.length === 0) {
    scenarioList.innerHTML = "<li class='empty-hint'>No saved scenarios.</li>";
    return;
  }
  for (const sc of scenarios) {
    const li = document.createElement("li");
    li.className = "scenario-item";

    const nameSpan = document.createElement("span");
    nameSpan.textContent = `${sc.name}`;
    nameSpan.className = "scenario-name";
    li.appendChild(nameSpan);

    const btnLoad = document.createElement("button");
    btnLoad.textContent = "Load";
    btnLoad.className = "btn-primary btn-sm";
    btnLoad.addEventListener("click", () => {
      const r = loadScenario(sc.name);
      if (!r.ok) { toast(r.error, "error"); return; }
      snapshotBeforeAction();
      Model.loadState(r.snapshot);
      refresh();
      toast(`Scenario "${sc.name}" loaded.`, "success");
    });
    li.appendChild(btnLoad);

    const btnDel = document.createElement("button");
    btnDel.textContent = "×";
    btnDel.className = "remove-btn";
    btnDel.title = `Delete scenario ${sc.name}`;
    btnDel.addEventListener("click", () => {
      const r = deleteScenario(sc.name);
      if (!r.ok) { toast(r.error, "error"); return; }
      toast(`Scenario "${sc.name}" deleted.`, "info");
      updateScenarioList();
    });
    li.appendChild(btnDel);
    scenarioList.appendChild(li);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  EXPORT / IMPORT
// ═══════════════════════════════════════════════════════════════════════════

btnExport.addEventListener("click", () => {
  exportJSON(Model.cloneState());
  toast("State exported as JSON.", "success");
});

inputImport.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const result = await importJSON(file);
  inputImport.value = ""; // reset input
  if (!result.ok) { showError(errorGeneral, result.error); return; }
  snapshotBeforeAction();
  Model.loadState(result.snapshot);
  refresh();
  toast("State imported from JSON.", "success");
});

// ═══════════════════════════════════════════════════════════════════════════
//  INITIAL RENDER
// ═══════════════════════════════════════════════════════════════════════════

refresh();
renderRecoveryHistory();
updateScenarioList();


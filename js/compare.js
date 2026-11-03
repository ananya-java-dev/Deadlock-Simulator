/**
 * compare.js — Renders the Before/After comparison panel.
 * DOM access is allowed here. Does NOT import model or detector.
 * Receives pre-computed state objects and available vectors.
 */

const MINI_STYLES = [
  { selector: "node.process", style: { shape: "ellipse", label: "data(label)", width: 44, height: 44, "background-color": "#4f8ef7", "border-color": "#2563eb", "border-width": 2, color: "#fff", "font-size": 10, "font-weight": "bold", "text-valign": "center", "text-halign": "center" } },
  { selector: "node.resource", style: { shape: "roundrectangle", label: "data(label)", width: 72, height: 38, "background-color": "#22c55e", "border-color": "#16a34a", "border-width": 2, color: "#fff", "font-size": 9, "font-weight": "bold", "text-valign": "center", "text-halign": "center", "text-wrap": "wrap" } },
  { selector: "edge.allocation", style: { width: 2, "line-color": "#64748b", "target-arrow-color": "#64748b", "target-arrow-shape": "triangle", "curve-style": "bezier", label: "data(label)", "font-size": 9 } },
  { selector: "edge.request", style: { width: 2, "line-color": "#f59e0b", "target-arrow-color": "#f59e0b", "target-arrow-shape": "triangle", "curve-style": "bezier", "line-style": "dashed", label: "data(label)", "font-size": 9 } },
  { selector: "node.deadlock", style: { "background-color": "#ef4444", "border-color": "#b91c1c", "border-width": 3 } },
  { selector: "edge.deadlock", style: { "line-color": "#ef4444", "target-arrow-color": "#ef4444", width: 3 } },
  // Changed/removed highlights for transitions
  { selector: "node.changed", style: { "background-color": "#f59e0b", "border-color": "#d97706", "border-width": 3 } },
  { selector: "node.removed", style: { "background-color": "#6b7280", "border-color": "#4b5563", "border-width": 2, opacity: 0.5 } },
  { selector: "edge.changed", style: { "line-color": "#f59e0b", "target-arrow-color": "#f59e0b", width: 3 } },
];

/** Builds Cytoscape element definitions from a state + available. */
function buildElements(state, available) {
  const elements = [];
  for (const pid of state.processes) {
    elements.push({ group: "nodes", data: { id: pid, label: pid }, classes: "process" });
  }
  for (const { id: rid, total } of state.resources) {
    const free = available[rid] ?? 0;
    elements.push({ group: "nodes", data: { id: rid, label: `${rid}\n(${free}/${total} free)` }, classes: "resource" });
  }
  for (const pid of state.processes) {
    for (const { id: rid } of state.resources) {
      const count = state.allocation[pid]?.[rid] ?? 0;
      if (count > 0) {
        elements.push({ group: "edges", data: { id: `alloc-${rid}-${pid}`, source: rid, target: pid, label: String(count) }, classes: "allocation" });
      }
    }
  }
  for (const pid of state.processes) {
    for (const { id: rid } of state.resources) {
      const count = state.request[pid]?.[rid] ?? 0;
      if (count > 0) {
        elements.push({ group: "edges", data: { id: `req-${pid}-${rid}`, source: pid, target: rid, label: String(count) }, classes: "request" });
      }
    }
  }
  return elements;
}

/** Initialise a mini read-only Cytoscape graph in a container element. */
function initMiniGraph(container) {
  return cytoscape({
    container,
    style: MINI_STYLES,
    userZoomingEnabled: true,
    userPanningEnabled: true,
    boxSelectionEnabled: false,
    autounselectify: true,
  });
}

/** Renders state into a mini Cytoscape instance. */
function renderMiniGraph(cy, state, available) {
  cy.elements().remove();
  cy.add(buildElements(state, available));
  cy.layout({ name: "cose", animate: false, fit: true, padding: 24, nodeRepulsion: () => 5000 }).run();
}

/**
 * Builds a simple side-by-side table comparing two matrix states.
 * Highlights cells that changed (yellow background).
 */
function makeCompareTable(title, processes, resources, beforeMatrix, afterMatrix) {
  const section = document.createElement("div");
  section.className = "compare-section";

  const h4 = document.createElement("h4");
  h4.textContent = title;
  section.appendChild(h4);

  const wrapper = document.createElement("div");
  wrapper.className = "compare-tables";

  ["Before", "After"].forEach((label, idx) => {
    const matrix = idx === 0 ? beforeMatrix : afterMatrix;
    const other  = idx === 0 ? afterMatrix  : beforeMatrix;

    const tableWrap = document.createElement("div");
    tableWrap.className = "compare-table-wrap";

    const lbl = document.createElement("div");
    lbl.className = `compare-label compare-label-${label.toLowerCase()}`;
    lbl.textContent = label;
    tableWrap.appendChild(lbl);

    const table = document.createElement("table");
    table.className = "matrix-table compare-matrix";

    // Header
    const thead = table.createTHead();
    const hRow = thead.insertRow();
    const corner = document.createElement("th");
    corner.textContent = "P \\ R";
    hRow.appendChild(corner);
    for (const { id: rid } of resources) {
      const th = document.createElement("th");
      th.textContent = rid;
      hRow.appendChild(th);
    }

    // Body
    const tbody = table.createTBody();
    for (const pid of processes) {
      const row = tbody.insertRow();
      const lc = row.insertCell();
      lc.className = "proc-label";
      lc.textContent = pid;
      for (const { id: rid } of resources) {
        const td = row.insertCell();
        const val = matrix[pid]?.[rid] ?? 0;
        const otherVal = other[pid]?.[rid] ?? 0;
        td.textContent = val;
        if (val !== otherVal) td.classList.add("cell-changed");
      }
    }
    table.appendChild(tbody);
    tableWrap.appendChild(table);
    wrapper.appendChild(tableWrap);
  });

  section.appendChild(wrapper);
  return section;
}

/**
 * Renders the full Before/After comparison panel.
 * Also initialises two mini Cytoscape graphs.
 *
 * @param {HTMLElement} container    — the compare panel element
 * @param {object} beforeState
 * @param {object} afterState
 * @param {object} beforeAvail
 * @param {object} afterAvail
 * @param {string} summaryText
 * @param {object} [beforeDetect]   — detection result for before state
 * @param {object} [afterDetect]    — detection result for after state
 * @returns {{ beforeCy, afterCy }}  — Cytoscape instances for later cleanup
 */
function renderBeforeAfter(
  container,
  beforeState,
  afterState,
  beforeAvail,
  afterAvail,
  summaryText,
  beforeDetect,
  afterDetect
) {
  container.innerHTML = "";

  // ── Summary ────────────────────────────────────────────────────────────
  const summaryEl = document.createElement("div");
  summaryEl.className = "compare-summary";
  summaryEl.textContent = summaryText;
  container.appendChild(summaryEl);

  // ── Verdict line ───────────────────────────────────────────────────────
  if (afterDetect) {
    const verdictEl = document.createElement("div");
    verdictEl.className = afterDetect.isDeadlock
      ? "compare-verdict compare-verdict-deadlock"
      : "compare-verdict compare-verdict-safe";
    verdictEl.textContent = afterDetect.isDeadlock
      ? `⚠ Deadlock persists: ${afterDetect.deadlockedProcesses.join(", ")} still blocked.`
      : `✓ Deadlock resolved. Completion: ${afterDetect.completionSequence.join(" → ")}`;
    container.appendChild(verdictEl);
  }

  // ── Mini graphs ────────────────────────────────────────────────────────
  const graphsRow = document.createElement("div");
  graphsRow.className = "compare-graphs-row";

  function makeGraphPanel(label, labelClass) {
    const wrap = document.createElement("div");
    wrap.className = "compare-graph-wrap";
    const lbl = document.createElement("div");
    lbl.className = `compare-label ${labelClass}`;
    lbl.textContent = label;
    const cyDiv = document.createElement("div");
    cyDiv.className = "compare-cy";
    wrap.appendChild(lbl);
    wrap.appendChild(cyDiv);
    return { wrap, cyDiv };
  }

  const { wrap: bWrap, cyDiv: bDiv } = makeGraphPanel("Before", "compare-label-before");
  const { wrap: aWrap, cyDiv: aDiv } = makeGraphPanel("After", "compare-label-after");
  graphsRow.appendChild(bWrap);
  graphsRow.appendChild(aWrap);
  container.appendChild(graphsRow);

  const beforeCy = initMiniGraph(bDiv);
  const afterCy  = initMiniGraph(aDiv);
  renderMiniGraph(beforeCy, beforeState, beforeAvail);
  renderMiniGraph(afterCy, afterState, afterAvail);

  // Apply deadlock highlights to before graph
  if (beforeDetect?.isDeadlock) {
    for (const pid of beforeDetect.deadlockedProcesses) {
      beforeCy.$(`#${CSS.escape(pid)}`).addClass("deadlock");
      for (const { id: rid } of beforeState.resources) {
        if ((beforeState.request[pid]?.[rid] ?? 0) > 0) {
          beforeCy.$(`#${CSS.escape(`req-${pid}-${rid}`)}`).addClass("deadlock");
        }
      }
    }
  }

  // Apply deadlock highlights to after graph
  if (afterDetect?.isDeadlock) {
    for (const pid of afterDetect.deadlockedProcesses) {
      afterCy.$(`#${CSS.escape(pid)}`).addClass("deadlock");
      for (const { id: rid } of afterState.resources) {
        if ((afterState.request[pid]?.[rid] ?? 0) > 0) {
          afterCy.$(`#${CSS.escape(`req-${pid}-${rid}`)}`).addClass("deadlock");
        }
      }
    }
  }

  // ── Allocation compare table ───────────────────────────────────────────
  // Use union of processes for comparison
  const allPids = [...new Set([...beforeState.processes, ...afterState.processes])];
  const allRids = beforeState.resources.length ? beforeState.resources : afterState.resources;

  container.appendChild(makeCompareTable(
    "Allocation (Before vs After)", allPids, allRids,
    beforeState.allocation, afterState.allocation
  ));

  // ── Request compare table ──────────────────────────────────────────────
  container.appendChild(makeCompareTable(
    "Request (Before vs After)", allPids, allRids,
    beforeState.request, afterState.request
  ));

  // ── Available compare ──────────────────────────────────────────────────
  const avSection = document.createElement("div");
  avSection.className = "compare-section";
  const avH4 = document.createElement("h4");
  avH4.textContent = "Available (Before vs After)";
  avSection.appendChild(avH4);

  const avRow = document.createElement("div");
  avRow.className = "compare-tables";
  ["Before", "After"].forEach((lbl, idx) => {
    const avail = idx === 0 ? beforeAvail : afterAvail;
    const other = idx === 0 ? afterAvail : beforeAvail;
    const wrap2 = document.createElement("div");
    wrap2.className = "compare-table-wrap";
    const lblEl = document.createElement("div");
    lblEl.className = `compare-label compare-label-${lbl.toLowerCase()}`;
    lblEl.textContent = lbl;
    wrap2.appendChild(lblEl);

    const tbl = document.createElement("table");
    tbl.className = "matrix-table compare-matrix";
    const thead2 = tbl.createTHead();
    const hr2 = thead2.insertRow();
    for (const { id: rid } of allRids) {
      const th2 = document.createElement("th"); th2.textContent = rid; hr2.appendChild(th2);
    }
    const tbody2 = tbl.createTBody();
    const vRow = tbody2.insertRow();
    for (const { id: rid } of allRids) {
      const td2 = vRow.insertCell();
      const val = avail[rid] ?? 0;
      const otherVal = other[rid] ?? 0;
      td2.textContent = val;
      td2.className = "avail-cell";
      if (val !== otherVal) td2.classList.add("cell-changed");
    }
    tbl.appendChild(tbody2);
    wrap2.appendChild(tbl);
    avRow.appendChild(wrap2);
  });
  avSection.appendChild(avRow);
  container.appendChild(avSection);

  return { beforeCy, afterCy };
}

/** Clears the comparison panel. */
function clearBeforeAfter(container) {
  container.innerHTML = "";
}

export { renderBeforeAfter, clearBeforeAfter, initMiniGraph, renderMiniGraph };

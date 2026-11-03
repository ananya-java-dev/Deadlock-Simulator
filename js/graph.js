/**
 * graph.js — Cytoscape.js Resource Allocation Graph rendering.
 * No DOM form access. Receives state objects and a Cytoscape container element.
 */

// ─── Cytoscape style definitions ──────────────────────────────────────────

const STYLES = [
  // Process nodes — circles
  {
    selector: "node.process",
    style: {
      shape: "ellipse",
      label: "data(label)",
      width: 60,
      height: 60,
      "background-color": "#4f8ef7",
      "border-color": "#2563eb",
      "border-width": 2,
      color: "#fff",
      "font-size": 14,
      "font-weight": "bold",
      "text-valign": "center",
      "text-halign": "center",
    },
  },
  // Resource nodes — rectangles
  {
    selector: "node.resource",
    style: {
      shape: "roundrectangle",
      label: "data(label)",
      width: 90,
      height: 50,
      "background-color": "#22c55e",
      "border-color": "#16a34a",
      "border-width": 2,
      color: "#fff",
      "font-size": 11,
      "font-weight": "bold",
      "text-valign": "center",
      "text-halign": "center",
      "text-wrap": "wrap",
    },
  },
  // Allocation edges: Resource -> Process (solid)
  {
    selector: "edge.allocation",
    style: {
      width: 2,
      "line-color": "#64748b",
      "target-arrow-color": "#64748b",
      "target-arrow-shape": "triangle",
      "curve-style": "bezier",
      label: "data(label)",
      "font-size": 11,
      "text-background-color": "#fff",
      "text-background-opacity": 0.8,
      "text-background-padding": "2px",
    },
  },
  // Request edges: Process -> Resource (dashed)
  {
    selector: "edge.request",
    style: {
      width: 2,
      "line-color": "#f59e0b",
      "target-arrow-color": "#f59e0b",
      "target-arrow-shape": "triangle",
      "curve-style": "bezier",
      "line-style": "dashed",
      "line-dash-pattern": [6, 3],
      label: "data(label)",
      "font-size": 11,
      "text-background-color": "#fff",
      "text-background-opacity": 0.8,
      "text-background-padding": "2px",
    },
  },
  // Deadlock highlight — processes
  {
    selector: "node.deadlock",
    style: {
      "background-color": "#ef4444",
      "border-color": "#b91c1c",
      "border-width": 3,
    },
  },
  // Deadlock highlight — request edges
  {
    selector: "edge.deadlock",
    style: {
      "line-color": "#ef4444",
      "target-arrow-color": "#ef4444",
      width: 3,
    },
  },
  // Post-recovery: changed nodes/edges flash yellow
  {
    selector: "node.changed, edge.changed",
    style: {
      "background-color": "#f59e0b",
      "border-color": "#d97706",
      "border-width": 3,
      "line-color": "#f59e0b",
      "target-arrow-color": "#f59e0b",
    },
  },
];

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Initialises a Cytoscape instance inside the given container element.
 * @param {HTMLElement} container
 * @returns {cytoscape.Core}
 */
function initGraph(container) {
  // cytoscape is loaded globally from CDN
  const cy = cytoscape({
    container,
    style: STYLES,
    layout: { name: "cose" },
    userZoomingEnabled: true,
    userPanningEnabled: true,
    boxSelectionEnabled: false,
    autounselectify: true,
  });
  return cy;
}

/**
 * Completely rebuilds the graph from the current model state.
 * Always call this after any state change to keep graph in sync.
 *
 * @param {cytoscape.Core} cy
 * @param {object} state     — from model.getState()
 * @param {object} available — from model.getAvailable()
 */
function rebuildGraph(cy, state, available) {
  cy.elements().remove(); // clear everything

  const elements = [];

  // Process nodes
  for (const pid of state.processes) {
    elements.push({
      group: "nodes",
      data: { id: pid, label: pid },
      classes: "process",
    });
  }

  // Resource nodes, labelled "R1 (2/3 free)"
  for (const { id: rid, total } of state.resources) {
    const free = available[rid] ?? 0;
    elements.push({
      group: "nodes",
      data: { id: rid, label: `${rid}\n(${free}/${total} free)` },
      classes: "resource",
    });
  }

  // Allocation edges: Resource → Process
  for (const pid of state.processes) {
    for (const { id: rid } of state.resources) {
      const count = state.allocation[pid]?.[rid] ?? 0;
      if (count > 0) {
        elements.push({
          group: "edges",
          data: {
            id: `alloc-${rid}-${pid}`,
            source: rid,
            target: pid,
            label: String(count),
          },
          classes: "allocation",
        });
      }
    }
  }

  // Request edges: Process → Resource
  for (const pid of state.processes) {
    for (const { id: rid } of state.resources) {
      const count = state.request[pid]?.[rid] ?? 0;
      if (count > 0) {
        elements.push({
          group: "edges",
          data: {
            id: `req-${pid}-${rid}`,
            source: pid,
            target: rid,
            label: String(count),
          },
          classes: "request",
        });
      }
    }
  }

  cy.add(elements);
  runLayout(cy);
}

/**
 * Highlights deadlocked processes (red) and their blocked request edges.
 * @param {cytoscape.Core} cy
 * @param {{ deadlockedProcesses: string[] }} result — from detectDeadlock()
 * @param {object} state — to find which request edges belong to deadlocked procs
 */
function highlightDeadlock(cy, result, state) {
  clearHighlights(cy);
  if (!result.isDeadlock) return;

  for (const pid of result.deadlockedProcesses) {
    cy.$(`#${CSS.escape(pid)}`).addClass("deadlock");

    // Highlight request edges from this deadlocked process
    for (const { id: rid } of state.resources) {
      const count = state.request[pid]?.[rid] ?? 0;
      if (count > 0) {
        cy.$(`#${CSS.escape(`req-${pid}-${rid}`)}`).addClass("deadlock");
      }
    }
  }
}

/** Removes all deadlock highlight classes. */
function clearHighlights(cy) {
  cy.elements(".deadlock").removeClass("deadlock");
}

/** Fits the graph to the viewport. */
function fitGraph(cy) {
  cy.fit(undefined, 40);
}

/** Re-runs the layout algorithm. */
function runLayout(cy) {
  cy.layout({
    name: "cose",
    animate: true,
    animationDuration: 400,
    fit: true,
    padding: 40,
    nodeRepulsion: () => 8000,
    idealEdgeLength: () => 100,
    gravity: 0.25,
  }).run();
}

export { initGraph, rebuildGraph, highlightDeadlock, clearHighlights, fitGraph };

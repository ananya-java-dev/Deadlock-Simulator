/**
 * recovery.js — Pure recovery logic: termination, preemption, rollback.
 * No DOM access. Every function receives state, returns { newState, summary, details }.
 * The caller (main.js) applies newState and triggers a redraw + re-detection.
 */

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Deep-clone any serialisable object. */
function clone(obj) { return JSON.parse(JSON.stringify(obj)); }

/**
 * Computes available from a state clone.
 * available[rid] = total[rid] - sum of allocation[p][rid]
 */
function computeAvailable(state) {
  const available = {};
  for (const { id, total } of state.resources) {
    const used = state.processes.reduce(
      (s, pid) => s + (state.allocation[pid]?.[id] ?? 0), 0
    );
    available[id] = total - used;
  }
  return available;
}

/** Formats a resource vector as [v1, v2, ...] using resource id order. */
function fmtVec(obj, rids) {
  return "[" + rids.map((r) => obj?.[r] ?? 0).join(", ") + "]";
}

// ─── Process Termination ───────────────────────────────────────────────────

/**
 * Terminates ONE process: removes it and releases all its allocations.
 * @param {object} state   — from Model.cloneState() — will be cloned again
 * @param {string} pid     — process to terminate
 * @returns {{ newState, summary, details }}
 */
function terminateProcess(state, pid) {
  const s = clone(state);
  const rids = s.resources.map((r) => r.id);

  if (!s.processes.includes(pid)) {
    return {
      newState: s,
      summary: `Process "${pid}" not found.`,
      details: [],
    };
  }

  const released = {};
  for (const rid of rids) {
    released[rid] = s.allocation[pid]?.[rid] ?? 0;
  }

  // Remove process
  s.processes = s.processes.filter((p) => p !== pid);
  delete s.allocation[pid];
  delete s.request[pid];
  delete s.processMeta?.[pid];

  const relStr = fmtVec(released, rids);
  const newAvail = computeAvailable(s);
  const availStr = fmtVec(newAvail, rids);

  return {
    newState: s,
    summary: `${pid} terminated. Released ${relStr}. Available is now ${availStr}.`,
    details: [
      `Process ${pid} was removed from the system.`,
      `Resources released: ${relStr}.`,
      `New available vector: ${availStr}.`,
    ],
  };
}

/**
 * Terminates ALL specified deadlocked processes at once.
 * @param {object} state
 * @param {string[]} pids — processes to terminate
 */
function terminateAll(state, pids) {
  let s = clone(state);
  const rids = s.resources.map((r) => r.id);
  const details = [];
  const totalReleased = {};
  for (const rid of rids) totalReleased[rid] = 0;

  for (const pid of pids) {
    if (!s.processes.includes(pid)) continue;
    for (const rid of rids) {
      totalReleased[rid] += s.allocation[pid]?.[rid] ?? 0;
    }
    s.processes = s.processes.filter((p) => p !== pid);
    delete s.allocation[pid];
    delete s.request[pid];
    delete s.processMeta?.[pid];
    details.push(`${pid} terminated.`);
  }

  const newAvail = computeAvailable(s);
  const availStr = fmtVec(newAvail, rids);
  details.push(`Total released: ${fmtVec(totalReleased, rids)}. Available: ${availStr}.`);

  return {
    newState: s,
    summary: `Terminated all deadlocked processes: ${pids.join(", ")}. Available: ${availStr}.`,
    details,
  };
}

/**
 * Terminate one at a time using a policy until deadlock is resolved.
 * Policy: "lowest-priority" | "fewest-held" | "most-held"
 *
 * @param {object} state
 * @param {string[]} deadlockedPids
 * @param {string} policy
 * @param {Function} detectFn  — (state, avail) => { isDeadlock, deadlockedProcesses }
 * @returns {{ rounds, finalState, summary }}
 */
function terminateByPolicy(state, deadlockedPids, policy, detectFn) {
  let s = clone(state);
  const rids = s.resources.map((r) => r.id);
  const rounds = [];
  let remaining = [...deadlockedPids];

  while (remaining.length > 0) {
    const avail = computeAvailable(s);
    const detect = detectFn(s, avail);
    if (!detect.isDeadlock) break; // resolved

    // Pick victim by policy
    const victim = pickVictim(s, remaining, policy, rids);
    const reason = policyReason(s, victim, policy, rids);
    const result = terminateProcess(s, victim);
    s = result.newState;
    remaining = remaining.filter((p) => p !== victim && s.processes.includes(p));
    // Update remaining to only include processes still in state that are deadlocked
    const newAvail2 = computeAvailable(s);
    const newDetect = detectFn(s, newAvail2);
    remaining = newDetect.isDeadlock ? newDetect.deadlockedProcesses : [];

    rounds.push({ pid: victim, reason, summary: result.summary, newState: clone(s) });
  }

  const finalAvail = computeAvailable(s);
  const finalDetect = detectFn(s, finalAvail);
  const summary = finalDetect.isDeadlock
    ? `Policy "${policy}": terminated ${rounds.map((r) => r.pid).join(", ")} but deadlock persists.`
    : `Policy "${policy}": terminated ${rounds.map((r) => r.pid).join(", ")}. Deadlock resolved.`;

  return { rounds, finalState: s, summary };
}

/** Picks a victim process from remaining according to policy. */
function pickVictim(state, remaining, policy, rids) {
  if (policy === "lowest-priority") {
    // Lower number = lower priority = pick first
    return remaining.reduce((worst, pid) => {
      const wp = state.processMeta?.[worst]?.priority ?? 1;
      const pp = state.processMeta?.[pid]?.priority ?? 1;
      return pp < wp ? pid : worst;
    });
  }
  if (policy === "fewest-held") {
    return remaining.reduce((best, pid) => {
      const bh = rids.reduce((s, r) => s + (state.allocation[best]?.[r] ?? 0), 0);
      const ph = rids.reduce((s, r) => s + (state.allocation[pid]?.[r] ?? 0), 0);
      return ph < bh ? pid : best;
    });
  }
  // most-held (default)
  return remaining.reduce((best, pid) => {
    const bh = rids.reduce((s, r) => s + (state.allocation[best]?.[r] ?? 0), 0);
    const ph = rids.reduce((s, r) => s + (state.allocation[pid]?.[r] ?? 0), 0);
    return ph > bh ? pid : best;
  });
}

function policyReason(state, pid, policy, rids) {
  if (policy === "lowest-priority") {
    const pr = state.processMeta?.[pid]?.priority ?? 1;
    return `${pid} has lowest priority (${pr}) among deadlocked processes.`;
  }
  if (policy === "fewest-held") {
    const h = rids.reduce((s, r) => s + (state.allocation[pid]?.[r] ?? 0), 0);
    return `${pid} holds fewest resources (${h} total).`;
  }
  const h = rids.reduce((s, r) => s + (state.allocation[pid]?.[r] ?? 0), 0);
  return `${pid} holds most resources (${h} total), freeing the most.`;
}

// ─── Resource Preemption ───────────────────────────────────────────────────

/**
 * Preempts `count` instances of `rid` from `victimPid` and gives them to `recipientPid`.
 *
 * Rules:
 *  - victim and recipient must be different
 *  - count <= victim's current allocation of rid
 *  - count <= recipient's outstanding request for rid
 *  - Victim's allocation[rid] decreases by count
 *  - Recipient's allocation[rid] increases by count, request[rid] decreases by count
 *  - Victim's request[rid] increases by count (it must re-acquire)
 *
 * @returns {{ ok, error?, newState, summary, details }}
 */
function preemptResource(state, victimPid, rid, count, recipientPid) {
  count = Number(count);

  // ── Validation ──────────────────────────────────────────────────────────
  if (victimPid === recipientPid)
    return { ok: false, error: "Victim and recipient must be different processes." };
  if (!state.processes.includes(victimPid))
    return { ok: false, error: `Victim process "${victimPid}" not found.` };
  if (!state.processes.includes(recipientPid))
    return { ok: false, error: `Recipient process "${recipientPid}" not found.` };
  if (!state.resources.some((r) => r.id === rid))
    return { ok: false, error: `Resource "${rid}" not found.` };
  if (!Number.isInteger(count) || count < 1)
    return { ok: false, error: "Preempt count must be a positive integer." };

  const victimHolds = state.allocation[victimPid]?.[rid] ?? 0;
  if (count > victimHolds)
    return {
      ok: false,
      error: `Cannot preempt ${count} of "${rid}" from ${victimPid}: it only holds ${victimHolds}.`,
    };

  const recipientRequest = state.request[recipientPid]?.[rid] ?? 0;
  if (recipientRequest === 0)
    return {
      ok: false,
      error: `${recipientPid} has no outstanding request for "${rid}".`,
    };
  if (count > recipientRequest)
    return {
      ok: false,
      error: `Cannot give ${count} of "${rid}" to ${recipientPid}: it only requests ${recipientRequest}.`,
    };

  // ── Apply ────────────────────────────────────────────────────────────────
  const s = clone(state);
  const rids = s.resources.map((r) => r.id);

  s.allocation[victimPid][rid] -= count;
  s.allocation[recipientPid][rid] += count;
  s.request[recipientPid][rid] -= count;
  // Victim must re-acquire what was taken
  s.request[victimPid][rid] = (s.request[victimPid]?.[rid] ?? 0) + count;
  // Increment preemptCount in meta
  if (s.processMeta?.[victimPid]) {
    s.processMeta[victimPid].preemptCount = (s.processMeta[victimPid].preemptCount ?? 0) + 1;
  }

  const newAvail = computeAvailable(s);
  const availStr = fmtVec(newAvail, rids);

  return {
    ok: true,
    newState: s,
    summary: `Preempted ${count}x "${rid}" from ${victimPid} → ${recipientPid}. Available: ${availStr}.`,
    details: [
      `${victimPid} allocation[${rid}]: ${victimHolds} → ${s.allocation[victimPid][rid]}.`,
      `${victimPid} request[${rid}] increased by ${count} (must re-acquire).`,
      `${recipientPid} allocation[${rid}] += ${count}.`,
      `${recipientPid} request[${rid}] -= ${count}.`,
      `New available: ${availStr}.`,
    ],
  };
}

/**
 * Suggests the best preemption victim: process with the lowest preemptCount,
 * breaking ties by most resources held.
 * @param {object} state
 * @param {string[]} candidates — usually deadlocked processes
 * @returns {string | null}
 */
function suggestPreemptVictim(state) {
  const rids = state.resources.map((r) => r.id);
  const candidates = state.processes;
  if (candidates.length === 0) return null;

  return candidates.reduce((best, pid) => {
    const bc = state.processMeta?.[best]?.preemptCount ?? 0;
    const pc = state.processMeta?.[pid]?.preemptCount ?? 0;
    if (pc < bc) return pid;
    if (pc === bc) {
      const bh = rids.reduce((s, r) => s + (state.allocation[best]?.[r] ?? 0), 0);
      const ph = rids.reduce((s, r) => s + (state.allocation[pid]?.[r] ?? 0), 0);
      return ph > bh ? pid : best;
    }
    return best;
  });
}

// ─── Rollback ─────────────────────────────────────────────────────────────

/**
 * Rolls back the WHOLE system to a checkpoint.
 * Handles missing processes/resources in the checkpoint gracefully.
 *
 * @param {object} checkpoint  — saved state snapshot
 * @returns {{ newState, summary, details, warnings }}
 */
function rollbackSystem(checkpoint) {
  const s = clone(checkpoint);
  const warnings = [];

  // Warn about potentially stale data
  if (!s.processes || !s.resources) {
    warnings.push("Checkpoint is missing process or resource data.");
  }

  return {
    newState: s,
    summary: `System rolled back to checkpoint "${checkpoint._label ?? "saved state"}" (${checkpoint._savedAt ?? "unknown time"}).`,
    details: [`All processes and resources restored to checkpoint state.`],
    warnings,
  };
}

/**
 * Rolls back ONE process to a checkpoint state.
 * Sets its allocation to min(current, checkpoint) per resource.
 * Keeps its current request unchanged.
 * Releases the difference back to other processes (increases available).
 *
 * @param {object} state      — current live state
 * @param {string} pid        — process to roll back
 * @param {object} checkpoint — saved state snapshot
 * @returns {{ newState, summary, details, warnings }}
 */
function rollbackProcess(state, pid, checkpoint) {
  const s = clone(state);
  const rids = s.resources.map((r) => r.id);
  const details = [];
  const warnings = [];

  if (!s.processes.includes(pid)) {
    return {
      newState: s,
      summary: `Cannot rollback: process "${pid}" not found in current state.`,
      details: [],
      warnings: [`Process "${pid}" not found.`],
    };
  }

  if (!checkpoint.processes?.includes(pid)) {
    warnings.push(`Process "${pid}" did not exist in checkpoint; allocation reset to 0.`);
    // Reset allocation to 0 — safest fallback
    for (const rid of rids) {
      const prev = s.allocation[pid]?.[rid] ?? 0;
      if (prev > 0) details.push(`${pid} alloc[${rid}]: ${prev} → 0`);
      if (s.allocation[pid]) s.allocation[pid][rid] = 0;
    }
  } else {
    for (const rid of rids) {
      const curr = s.allocation[pid]?.[rid] ?? 0;
      const ckpt = checkpoint.allocation?.[pid]?.[rid] ?? 0;
      const newAlloc = Math.min(curr, ckpt);
      if (curr !== newAlloc) {
        details.push(`${pid} alloc[${rid}]: ${curr} → ${newAlloc} (released ${curr - newAlloc}).`);
      }
      if (s.allocation[pid]) s.allocation[pid][rid] = newAlloc;
    }
  }

  const newAvail = computeAvailable(s);
  const availStr = fmtVec(newAvail, rids);
  details.push(`New available: ${availStr}.`);
  details.push(`${pid} request unchanged; it must re-acquire released resources.`);

  return {
    newState: s,
    summary: `${pid} rolled back to checkpoint state. Available: ${availStr}.`,
    details,
    warnings,
  };
}

export {
  terminateProcess,
  terminateAll,
  terminateByPolicy,
  preemptResource,
  suggestPreemptVictim,
  rollbackSystem,
  rollbackProcess,
  computeAvailable,
};

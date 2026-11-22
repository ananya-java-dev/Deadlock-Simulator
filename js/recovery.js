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

/**
 * Returns true if two state snapshots are functionally identical
 * (same processes, same allocation values, same request values).
 */
function statesEqual(a, b) {
  if (JSON.stringify(a.processes.slice().sort()) !== JSON.stringify(b.processes.slice().sort())) return false;
  for (const pid of a.processes) {
    for (const { id: rid } of a.resources) {
      if ((a.allocation[pid]?.[rid] ?? 0) !== (b.allocation[pid]?.[rid] ?? 0)) return false;
      if ((a.request[pid]?.[rid] ?? 0) !== (b.request[pid]?.[rid] ?? 0)) return false;
    }
  }
  return true;
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
 * @returns {{ rounds, finalState, summary, details }}
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

    // Update remaining to only include processes still in state that are deadlocked
    const newDetect = detectFn(s, computeAvailable(s));
    remaining = newDetect.isDeadlock ? newDetect.deadlockedProcesses : [];

    rounds.push({ pid: victim, reason, summary: result.summary, newState: clone(s) });
  }

  const finalAvail = computeAvailable(s);
  const finalDetect = detectFn(s, finalAvail);
  const resolved = !finalDetect.isDeadlock;
  const summary = resolved
    ? `Policy "${policy}": terminated ${rounds.map((r) => r.pid).join(", ")}. Deadlock resolved.`
    : `Policy "${policy}": terminated ${rounds.map((r) => r.pid).join(", ")} but deadlock persists.`;

  // Build per-round details for display
  const details = rounds.map(
    (r, i) => `Round ${i + 1}: ${r.pid} terminated — ${r.reason}`
  );
  if (resolved) details.push(`Deadlock resolved.`);
  else details.push(`Deadlock persists after all rounds.`);

  return { rounds, finalState: s, summary, details };
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
 *  - Victim's new total request[rid] must not exceed resource total
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
  const resource = state.resources.find((r) => r.id === rid);
  if (!resource)
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

  // Check victim's new request won't exceed total
  const victimCurrentReq = state.request[victimPid]?.[rid] ?? 0;
  const victimNewReq = victimCurrentReq + count;
  if (victimNewReq > resource.total)
    return {
      ok: false,
      error: `Preemption would give ${victimPid} a request of ${victimNewReq} for "${rid}", which exceeds the total (${resource.total}).`,
    };

  // ── Apply ────────────────────────────────────────────────────────────────
  const s = clone(state);
  const rids = s.resources.map((r) => r.id);

  s.allocation[victimPid][rid] -= count;
  s.allocation[recipientPid][rid] += count;
  s.request[recipientPid][rid] -= count;
  // Victim must re-acquire what was taken
  s.request[victimPid][rid] = victimCurrentReq + count;
  // Increment preemptCount in meta
  if (s.processMeta?.[victimPid]) {
    s.processMeta[victimPid].preemptCount = (s.processMeta[victimPid].preemptCount ?? 0) + 1;
  }

  const newAvail = computeAvailable(s);
  const availStr = fmtVec(newAvail, rids);

  return {
    ok: true,
    newState: s,
    summary: `Preempted ${count}× "${rid}" from ${victimPid} → ${recipientPid}. Available: ${availStr}.`,
    details: [
      `${victimPid} allocation[${rid}]: ${victimHolds} → ${s.allocation[victimPid][rid]}.`,
      `${victimPid} request[${rid}]: ${victimCurrentReq} → ${s.request[victimPid][rid]} (must re-acquire).`,
      `${recipientPid} allocation[${rid}]: +${count} (now ${s.allocation[recipientPid][rid]}).`,
      `${recipientPid} request[${rid}]: −${count} (now ${s.request[recipientPid][rid]}).`,
      `New available: ${availStr}.`,
    ],
  };
}

/**
 * Suggests the best preemption victim for the given resource and recipient.
 * Considers only processes holding >= 1 of rid, excluding recipient.
 * Preference: lowest preemptCount → lowest priority → most instances of rid.
 *
 * @param {object} state
 * @param {string} rid          — resource being preempted (required)
 * @param {string} [excludePid] — recipient pid to exclude
 * @returns {string | null}
 */
function suggestPreemptVictim(state, rid, excludePid) {
  if (!rid) return null;
  const candidates = state.processes.filter(
    (pid) => pid !== excludePid && (state.allocation[pid]?.[rid] ?? 0) >= 1
  );
  if (candidates.length === 0) return null;

  return candidates.reduce((best, pid) => {
    const bc = state.processMeta?.[best]?.preemptCount ?? 0;
    const pc = state.processMeta?.[pid]?.preemptCount ?? 0;
    if (pc < bc) return pid;
    if (pc === bc) {
      const bp = state.processMeta?.[best]?.priority ?? 1;
      const pp = state.processMeta?.[pid]?.priority ?? 1;
      if (pp < bp) return pid;        // lower priority = better victim
      if (pp === bp) {
        // Most instances of this resource
        const bh = state.allocation[best]?.[rid] ?? 0;
        const ph = state.allocation[pid]?.[rid] ?? 0;
        return ph > bh ? pid : best;
      }
    }
    return best;
  });
}

// ─── Rollback ─────────────────────────────────────────────────────────────

/**
 * Rolls back the WHOLE system to a checkpoint.
 * Handles missing processes/resources in the checkpoint gracefully.
 * Returns { ok:false, error } if the result is identical to current state.
 *
 * @param {object} currentState  — current live state (for no-op check)
 * @param {object} checkpoint    — saved state snapshot
 * @returns {{ ok, error?, newState, summary, details, warnings }}
 */
function rollbackSystem(currentState, checkpoint) {
  const s = JSON.parse(JSON.stringify(checkpoint));
  const warnings = [];

  if (!s.processes || !s.resources) {
    warnings.push("Checkpoint is missing process or resource data.");
  }

  // No-op check
  if (statesEqual(currentState, s)) {
    return {
      ok: false,
      error: `Rolling back to this checkpoint changes nothing: the system already matches it. Pick a different checkpoint.`,
    };
  }

  return {
    ok: true,
    newState: s,
    summary: `System rolled back to checkpoint "${checkpoint._label ?? "saved state"}" (${checkpoint._savedAt ?? "unknown time"}).`,
    details: [`All processes and resources restored to checkpoint state.`],
    warnings,
  };
}

/**
 * Rolls back ONE process to a checkpoint state.
 *
 * Mode "checkpoint" (default):
 *   allocation = min(current, checkpoint) per resource
 *   request    = checkpoint's request for that process (0 if absent)
 *
 * Mode "restart":
 *   allocation = all zeros (releases everything)
 *   request    = checkpoint's request for that process (0 if absent)
 *
 * Returns { ok:false, error } if the result would be identical to current state.
 *
 * @param {object} state      — current live state
 * @param {string} pid        — process to roll back
 * @param {object} checkpoint — saved state snapshot
 * @param {string} [mode]     — "checkpoint" | "restart"
 * @returns {{ ok, error?, newState, summary, details, warnings }}
 */
function rollbackProcess(state, pid, checkpoint, mode = "checkpoint") {
  const s = JSON.parse(JSON.stringify(state));
  const rids = s.resources.map((r) => r.id);
  const details = [];
  const warnings = [];

  if (!s.processes.includes(pid)) {
    return {
      ok: false,
      error: `Cannot rollback: process "${pid}" not found in current state.`,
    };
  }

  const pidInCkpt = checkpoint.processes?.includes(pid);
  if (!pidInCkpt) {
    warnings.push(`Process "${pid}" did not exist in checkpoint; checkpoint allocation/request treated as 0.`);
  }

  const prevAllocVec = rids.map((r) => s.allocation[pid]?.[r] ?? 0);
  const prevReqVec   = rids.map((r) => s.request[pid]?.[r] ?? 0);

  // Target allocation per mode
  for (const rid of rids) {
    const curr      = s.allocation[pid]?.[rid] ?? 0;
    const ckptAlloc = pidInCkpt ? (checkpoint.allocation?.[pid]?.[rid] ?? 0) : 0;
    const ckptReq   = pidInCkpt ? (checkpoint.request?.[pid]?.[rid] ?? 0) : 0;

    let newAlloc;
    if (mode === "restart") {
      newAlloc = 0;
    } else {
      newAlloc = Math.min(curr, ckptAlloc);
    }

    if (s.allocation[pid]) s.allocation[pid][rid] = newAlloc;
    if (s.request[pid])    s.request[pid][rid] = ckptReq;
  }

  const newAllocVec = rids.map((r) => s.allocation[pid]?.[r] ?? 0);
  const newReqVec   = rids.map((r) => s.request[pid]?.[r] ?? 0);

  // No-op check: compare before and after
  const allocChanged = prevAllocVec.some((v, i) => v !== newAllocVec[i]);
  const reqChanged   = prevReqVec.some((v, i) => v !== newReqVec[i]);

  if (!allocChanged && !reqChanged) {
    return {
      ok: false,
      error: `Rolling back ${pid} changes nothing: it already matches the checkpoint. Pick another process or checkpoint.`,
    };
  }

  // Build detailed change description
  const prevAllocStr = "[" + prevAllocVec.join(", ") + "]";
  const newAllocStr  = "[" + newAllocVec.join(", ") + "]";
  const prevReqStr   = "[" + prevReqVec.join(", ") + "]";
  const newReqStr    = "[" + newReqVec.join(", ") + "]";

  const released = {};
  for (let i = 0; i < rids.length; i++) {
    released[rids[i]] = prevAllocVec[i] - newAllocVec[i];
  }
  const releasedStr  = "[" + rids.map((r) => released[r]).join(", ") + "]";

  const newAvail    = computeAvailable(s);
  const availStr    = fmtVec(newAvail, rids);

  if (allocChanged) details.push(`${pid} allocation ${prevAllocStr} → ${newAllocStr}, released ${releasedStr}.`);
  if (reqChanged)   details.push(`${pid} request ${prevReqStr} → ${newReqStr}.`);
  details.push(`Available now ${availStr}.`);
  if (mode === "restart") details.push(`${pid} in restart mode: all allocations zeroed; request restored from checkpoint.`);

  const summary = `${pid} allocation ${prevAllocStr} → ${newAllocStr}, request ${prevReqStr} → ${newReqStr}, released ${releasedStr}, Available now ${availStr}.`;

  return {
    ok: true,
    newState: s,
    summary,
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

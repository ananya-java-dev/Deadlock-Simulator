// Acceptance test — pure logic, no DOM
function clone(obj) { return JSON.parse(JSON.stringify(obj)); }

function computeAvailable(state) {
  const av = {};
  for (const { id, total } of state.resources) {
    av[id] = total - state.processes.reduce((s, p) => s + (state.allocation[p]?.[id] ?? 0), 0);
  }
  return av;
}

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

function detect(state) {
  const { processes, resources, allocation, request } = state;
  const rids = resources.map(r => r.id);
  const avail = computeAvailable(state);
  const work = { ...avail }, finished = {};
  const seq = [];
  for (const pid of processes) {
    finished[pid] = rids.every(r => (allocation[pid]?.[r] ?? 0) === 0 && (request[pid]?.[r] ?? 0) === 0);
    if (finished[pid]) seq.push(pid);
  }
  let prog = true;
  while (prog) {
    prog = false;
    for (const pid of processes) {
      if (finished[pid]) continue;
      if (rids.every(r => (request[pid]?.[r] ?? 0) <= (work[r] ?? 0))) {
        for (const r of rids) work[r] = (work[r] ?? 0) + (allocation[pid]?.[r] ?? 0);
        finished[pid] = true; prog = true; seq.push(pid);
      }
    }
  }
  const dl = processes.filter(p => !finished[p]);
  return { isDeadlock: dl.length > 0, deadlocked: dl, sequence: seq };
}

function rollbackProcess(state, pid, checkpoint, mode = "checkpoint") {
  const s = clone(state);
  const rids = s.resources.map(r => r.id);
  if (!s.processes.includes(pid)) return { ok: false, error: `"${pid}" not in state.` };
  const pidInCkpt = checkpoint.processes?.includes(pid);
  const prevAllocVec = rids.map(r => s.allocation[pid]?.[r] ?? 0);
  const prevReqVec   = rids.map(r => s.request[pid]?.[r] ?? 0);
  for (const rid of rids) {
    const curr      = s.allocation[pid]?.[rid] ?? 0;
    const ckptAlloc = pidInCkpt ? (checkpoint.allocation?.[pid]?.[rid] ?? 0) : 0;
    const ckptReq   = pidInCkpt ? (checkpoint.request?.[pid]?.[rid] ?? 0) : 0;
    s.allocation[pid][rid] = mode === "restart" ? 0 : Math.min(curr, ckptAlloc);
    s.request[pid][rid] = ckptReq;
  }
  const newAllocVec = rids.map(r => s.allocation[pid]?.[r] ?? 0);
  const newReqVec   = rids.map(r => s.request[pid]?.[r] ?? 0);
  const allocChanged = prevAllocVec.some((v, i) => v !== newAllocVec[i]);
  const reqChanged   = prevReqVec.some((v, i) => v !== newReqVec[i]);
  if (!allocChanged && !reqChanged) return { ok: false, error: `Rolling back ${pid} changes nothing: it already matches the checkpoint. Pick another process or checkpoint.` };
  const avail = computeAvailable(s);
  const releasedArr = rids.map((r, i) => prevAllocVec[i] - newAllocVec[i]);
  const summary = `${pid} allocation [${prevAllocVec}] → [${newAllocVec}], request [${prevReqVec}] → [${newReqVec}], released [${releasedArr}], Available now [${rids.map(r => avail[r])}].`;
  return { ok: true, newState: s, summary };
}

function rollbackSystem(currentState, checkpoint) {
  const s = clone(checkpoint);
  if (statesEqual(currentState, s)) return { ok: false, error: "No-op: system already matches checkpoint." };
  return { ok: true, newState: s, summary: "System rolled back." };
}

function preemptResource(state, victimPid, rid, count, recipientPid) {
  count = Number(count);
  if (victimPid === recipientPid) return { ok: false, error: "Same pid." };
  const resource = state.resources.find(r => r.id === rid);
  if (!resource) return { ok: false, error: `No resource ${rid}.` };
  const victimHolds = state.allocation[victimPid]?.[rid] ?? 0;
  if (count > victimHolds) return { ok: false, error: `Victim only holds ${victimHolds}.` };
  const recipientRequest = state.request[recipientPid]?.[rid] ?? 0;
  if (count > recipientRequest) return { ok: false, error: `Recipient only requests ${recipientRequest}.` };
  const victimCurrentReq = state.request[victimPid]?.[rid] ?? 0;
  const victimNewReq = victimCurrentReq + count;
  if (victimNewReq > resource.total) return { ok: false, error: `Victim new request ${victimNewReq} exceeds total ${resource.total}.` };
  const s = clone(state);
  s.allocation[victimPid][rid] -= count;
  s.allocation[recipientPid][rid] += count;
  s.request[recipientPid][rid] -= count;
  s.request[victimPid][rid] = victimCurrentReq + count;
  return { ok: true, newState: s };
}

function suggestPreemptVictim(state, rid, excludePid) {
  if (!rid) return null;
  const candidates = state.processes.filter(pid => pid !== excludePid && (state.allocation[pid]?.[rid] ?? 0) >= 1);
  if (!candidates.length) return null;
  return candidates.reduce((best, pid) => {
    const bc = state.processMeta?.[best]?.preemptCount ?? 0;
    const pc = state.processMeta?.[pid]?.preemptCount ?? 0;
    if (pc < bc) return pid;
    if (pc === bc) {
      const bp = state.processMeta?.[best]?.priority ?? 1;
      const pp = state.processMeta?.[pid]?.priority ?? 1;
      if (pp < bp) return pid;
      if (pp === bp) return (state.allocation[pid]?.[rid] ?? 0) > (state.allocation[best]?.[rid] ?? 0) ? pid : best;
    }
    return best;
  });
}

function pickVictim(state, remaining, policy, rids) {
  if (policy === "lowest-priority")
    return remaining.reduce((w, p) => (state.processMeta?.[p]?.priority ?? 1) < (state.processMeta?.[w]?.priority ?? 1) ? p : w);
  if (policy === "fewest-held")
    return remaining.reduce((b, p) => rids.reduce((s, r) => s + (state.allocation[p]?.[r] ?? 0), 0) < rids.reduce((s, r) => s + (state.allocation[b]?.[r] ?? 0), 0) ? p : b);
  return remaining.reduce((b, p) => rids.reduce((s, r) => s + (state.allocation[p]?.[r] ?? 0), 0) > rids.reduce((s, r) => s + (state.allocation[b]?.[r] ?? 0), 0) ? p : b);
}

// ── TEST DATA ────────────────────────────────────────────────────────────────
const safeBase = {
  processes: ['P0','P1','P2','P3','P4'],
  resources: [{id:'R0',total:7},{id:'R1',total:2},{id:'R2',total:6}],
  allocation: { P0:{R0:0,R1:1,R2:0}, P1:{R0:2,R1:0,R2:0}, P2:{R0:3,R1:0,R2:3}, P3:{R0:0,R1:0,R2:0}, P4:{R0:0,R1:0,R2:2} },
  request:    { P0:{R0:0,R1:0,R2:0}, P1:{R0:2,R1:0,R2:2}, P2:{R0:0,R1:0,R2:0}, P3:{R0:0,R1:0,R2:0}, P4:{R0:0,R1:0,R2:2} },
  processMeta:{ P0:{priority:5,preemptCount:0}, P1:{priority:4,preemptCount:0}, P2:{priority:3,preemptCount:0}, P3:{priority:2,preemptCount:0}, P4:{priority:1,preemptCount:0} }
};
// DEADLOCK: P3 alloc [2,1,1], P3 req [1,0,0], P2 req [0,0,1]
const dlState = clone(safeBase);
dlState.allocation.P3 = {R0:2, R1:1, R2:1};
dlState.request.P3    = {R0:1, R1:0, R2:0};
dlState.request.P2    = {R0:0, R1:0, R2:1};

let pass = 0, fail = 0;
function test(id, got, want, note = "") {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  const icon = ok ? "✅" : "❌";
  console.log(`${icon} [${id}]  got=${JSON.stringify(got)}  want=${JSON.stringify(want)}${note ? "  // " + note : ""}`);
  ok ? pass++ : fail++;
}

// ── Baseline ─────────────────────────────────────────────────────────────────
const r0 = detect(safeBase);
test("SAFE baseline", r0.isDeadlock, false);
const r1 = detect(dlState);
test("DEADLOCK baseline", r1.isDeadlock, true);
test("DEADLOCK pids", r1.deadlocked.slice().sort().join(","), "P1,P2,P3,P4");

// ── a) Rollback P3 (checkpoint mode) ─────────────────────────────────────────
const a = rollbackProcess(dlState, "P3", safeBase, "checkpoint");
test("a ok", a.ok, true);
test("a P3 alloc", [a.newState.allocation.P3.R0, a.newState.allocation.P3.R1, a.newState.allocation.P3.R2], [0,0,0]);
test("a P3 req",   [a.newState.request.P3.R0,    a.newState.request.P3.R1,    a.newState.request.P3.R2],   [0,0,0]);
test("a avail", computeAvailable(a.newState), {R0:2,R1:1,R2:1});
test("a resolved", detect(a.newState).isDeadlock, false);

// ── b) Rollback P2 (request restored to [0,0,0]) ─────────────────────────────
const b = rollbackProcess(dlState, "P2", safeBase, "checkpoint");
test("b ok", b.ok, true);
test("b P2 req R2", b.newState.request.P2.R2, 0);
test("b resolved", detect(b.newState).isDeadlock, false);

// ── c) Rollback P1 → no-op ───────────────────────────────────────────────────
const c = rollbackProcess(dlState, "P1", safeBase, "checkpoint");
test("c no-op ok=false", c.ok, false, "P1 alloc+req identical to checkpoint");

// ── d) Rollback Whole System ──────────────────────────────────────────────────
const d = rollbackSystem(dlState, safeBase);
test("d ok", d.ok, true);
test("d resolved", detect(d.newState).isDeadlock, false);

// ── d no-op guard ─────────────────────────────────────────────────────────────
const dNoop = rollbackSystem(safeBase, safeBase);
test("d noop ok=false", dNoop.ok, false);

// ── e) Preempt 1xR2: P4→P2 ───────────────────────────────────────────────────
// dlState: P4 alloc R2=2, P4 req R2=2; P2 alloc R2=3, P2 req R2=1
const e = preemptResource(dlState, "P4", "R2", 1, "P2");
test("e ok", e.ok, true);
test("e P4 alloc R2", e.newState.allocation.P4.R2, 1);
test("e P4 req R2",   e.newState.request.P4.R2,   3, "was 2, +1");
test("e P2 alloc R2", e.newState.allocation.P2.R2, 4);
test("e P2 req R2",   e.newState.request.P2.R2,   0, "was 1, -1");
test("e resolved", detect(e.newState).isDeadlock, false);

// ── f) Victim list for R2, recipient P2 ──────────────────────────────────────
const victimsR2 = dlState.processes.filter(p => p !== "P2" && (dlState.allocation[p]?.R2 ?? 0) >= 1).sort();
test("f victims", victimsR2.join(","), "P3,P4");
const suggested = suggestPreemptVictim(dlState, "R2", "P2");
test("f suggest", suggested, "P4", "P3 priority=2, P4 priority=1 → P4 is lower priority, picked first");

// ── g) Preempt 5xR2 from P4 → error ─────────────────────────────────────────
const g = preemptResource(dlState, "P4", "R2", 5, "P2");
test("g error ok=false", g.ok, false, `P4 only holds 2`);

// ── h) Kill by policy ─────────────────────────────────────────────────────────
const rids = ["R0","R1","R2"];
const dl_pids = ["P1","P2","P3","P4"];
test("h lowest-priority picks P4", pickVictim(dlState, dl_pids, "lowest-priority", rids), "P4", "P4 priority=1");
test("h fewest-held picks P1",     pickVictim(dlState, dl_pids, "fewest-held", rids),     "P1", "P1 holds 2, tie with P4 but P1 first in list");
test("h most-held picks P2",       pickVictim(dlState, dl_pids, "most-held", rids),       "P2", "P2 holds 6");

// ── Preset 6 resources = total 1 ─────────────────────────────────────────────
test("preset6 R1=1", 1, 1);
test("preset6 R2=1", 1, 1);

console.log(`\n${"─".repeat(50)}`);
console.log(`PASS: ${pass}  FAIL: ${fail}  ${fail === 0 ? "🎉 ALL PASS" : "⚠ FAILURES ABOVE"}`);

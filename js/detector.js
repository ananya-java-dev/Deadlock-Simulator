/**
 * detector.js — Multi-instance deadlock detection (Banker's-style).
 * Pure logic, no DOM access.
 */

/**
 * Detects deadlock using the resource-allocation graph / Banker mark algorithm.
 *
 * Algorithm:
 *  1. Work = Available (computed from state).
 *  2. Mark processes with no allocations as finished immediately.
 *  3. Repeatedly find an unfinished process P where Request[P] <= Work.
 *     When found: Work += Allocation[P], mark P finished.
 *  4. Any process still unfinished is deadlocked.
 *
 * @param {object} state    — from model.getState()
 * @param {object} available — from model.getAvailable()
 * @returns {{
 *   isDeadlock: boolean,
 *   deadlockedProcesses: string[],
 *   completionSequence: string[],
 *   steps: Array<{stepNum,process,workBefore,workAfter,explanation}>
 * }}
 */
function detectDeadlock(state, available) {
  const { processes, resources, allocation, request } = state;
  const rids = resources.map((r) => r.id);

  // Work vector (shallow copy so we do not mutate the original)
  const work = { ...available };

  const finished = {};   // pid -> boolean
  const steps = [];
  const completionSequence = [];
  let stepNum = 0;

  // ── Step 0: Mark processes that hold nothing as trivially finished ──────
  for (const pid of processes) {
    const holdsNothing = rids.every((rid) => (allocation[pid]?.[rid] ?? 0) === 0);
    if (holdsNothing) {
      finished[pid] = true;
      stepNum++;
      const workSnapshot = { ...work };
      steps.push({
        stepNum,
        process: pid,
        workBefore: workSnapshot,
        workAfter: workSnapshot,
        explanation: `${pid} holds no resources, so it is trivially finished and releases nothing.`,
      });
      completionSequence.push(pid);
    } else {
      finished[pid] = false;
    }
  }

  // ── Main loop: find processes whose request fits in Work ────────────────
  let progress = true;
  while (progress) {
    progress = false;
    for (const pid of processes) {
      if (finished[pid]) continue;

      // Check if Request[pid] <= Work for all resources
      const fits = rids.every((rid) => (request[pid]?.[rid] ?? 0) <= (work[rid] ?? 0));
      if (!fits) continue;

      // This process can finish
      const workBefore = { ...work };

      // Release its allocations into Work
      for (const rid of rids) {
        work[rid] = (work[rid] ?? 0) + (allocation[pid]?.[rid] ?? 0);
      }

      finished[pid] = true;
      progress = true;
      stepNum++;
      completionSequence.push(pid);

      const reqStr = formatVector(request[pid], rids);
      const allocStr = formatVector(allocation[pid], rids);
      const wbStr = formatVector(workBefore, rids);
      const waStr = formatVector(work, rids);

      steps.push({
        stepNum,
        process: pid,
        workBefore,
        workAfter: { ...work },
        explanation:
          `${pid}'s request ${reqStr} ≤ Work ${wbStr}, so ${pid} can finish. ` +
          `It releases ${allocStr}, making Work ${waStr}.`,
      });
    }
  }

  // ── Check for stuck processes ───────────────────────────────────────────
  const deadlockedProcesses = processes.filter((pid) => !finished[pid]);
  const isDeadlock = deadlockedProcesses.length > 0;

  if (isDeadlock) {
    stepNum++;
    steps.push({
      stepNum,
      process: null,
      workBefore: { ...work },
      workAfter: { ...work },
      explanation:
        `No more processes can proceed. ` +
        `Deadlocked processes: ${deadlockedProcesses.join(", ")}.`,
    });
  }

  return { isDeadlock, deadlockedProcesses, completionSequence, steps };
}

/** Formats a resource vector as "[v1, v2, ...]" using resource id order. */
function formatVector(vec, rids) {
  const vals = rids.map((rid) => vec?.[rid] ?? 0);
  return `[${vals.join(", ")}]`;
}

export { detectDeadlock };

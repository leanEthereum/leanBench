// Topology explorer — enumerate balanced-tree aggregation topologies for a
// target signature count, score each by leaf wall + recursion wall + machine
// count + root proof size against a per-machine cost model fit live from the
// index data, and rank them.
//
// Cost model (per machine, derived from the active combo's measurements):
//   flat(M)        ≈ a + b·M    — leaf cost, linear in raw_xmss per leaf
//   recursion(N)   ≈ a' + b'·N  — recursion-only cost, linear in fan-in
//   proof_size(N)  ≈ a'' + b''·N — root proof size, linear in fan-in
//
// Reuses helpers (`el`, `colorFor`, `shortSha`, `fmtRelative`) from app.js
// which loads first.

if (document.body.dataset.page === "topology") renderTopologyPage();

let topoIndexData = null;
let topoActiveCombo = null;
let topoActiveLeanvmBranch = null; // null = any
let topoMachines = []; // filtered to active combo

// Sort state. `dir` is 1 for ascending, -1 for descending. Clicking a sorted
// column toggles direction; clicking a different column resets to ascending.
const topoSort = { key: "totalWall", dir: 1 };

// Simulator state — independent of the explorer table. tiers is the chain
// of recursion fan-ins from root → bottom-mid (left → right in display);
// leaves sit to the right of the rightmost recursion tier.
const sim = {
  machineFingerprint: null,
  propagationMs: 200,
  intervalsMs: { propose: 800, attest: 800, aggregate: 800, safeTarget: 800, accept: 800 },
  tiers: [4, 4],
  leafSize: 625,
};

async function renderTopologyPage() {
  try {
    const res = await fetch("results/index.json");
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    topoIndexData = await res.json();
  } catch (e) {
    console.error("[topology] failed to load results/index.json:", e);
    document.querySelector("#topology-results").innerHTML =
      "<p>No results yet — run a sweep first.</p>";
    return;
  }

  const combos = topoIndexData.combos || [];
  const params = new URLSearchParams(location.search);
  // URL > shared config default > null. app.js loads config.json once
  // and caches; we just await the same helper from this page.
  const cfg = await loadLeanBenchConfig();
  const available = new Set(combos.map((c) => c.leanmultisig_branch).filter(Boolean));
  const requested = params.get("leanmultisig_branch") || cfg.default_leanvm_branch || null;
  topoActiveLeanvmBranch = (requested && available.has(requested)) ? requested : null;
  const filtered = filterTopoCombosByBranch(combos, topoActiveLeanvmBranch);
  const ls = params.get("leansig");
  const lm = params.get("leanmultisig");
  topoActiveCombo = (ls && lm
    ? filtered.find((c) => c.leansig_sha.startsWith(ls) && c.leanmultisig_sha.startsWith(lm))
    : null) || filtered[0] || combos[0];

  if (!topoActiveCombo) {
    document.querySelector("#topology-results").innerHTML =
      "<p>No commits in the index.</p>";
    return;
  }

  setupBranchFilter(combos);
  setupComboFilter(filtered.length ? filtered : combos);
  setupInputHandlers();
  applyActiveCombo();
  setupSimulator();
  setupResetLink("#slot-controls-reset", {
    "#sim-propose":     "800",
    "#sim-attest":      "800",
    "#sim-aggregate":   "800",
    "#sim-safe-target": "800",
    "#sim-accept":      "800",
    "#sim-propagation": "200",
  });
  setupResetLink("#topo-total-sigs-reset", { "#topo-total-sigs": "10000" });
}

// Wire a reset link to restore the listed inputs to their defaults. Always
// dispatches an `input` event (even when the value already matched) so the
// downstream handlers re-run — this also resets per-render state that lives
// inside renderResults / renderSimulator (e.g. the candidates pagination
// `currentVisible` counter).
function setupResetLink(linkSel, defaults) {
  const link = document.querySelector(linkSel);
  if (!link) return;
  link.addEventListener("click", (e) => {
    e.preventDefault();
    for (const [sel, val] of Object.entries(defaults)) {
      const node = document.querySelector(sel);
      if (!node) continue;
      node.value = val;
      node.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });
}

// Filter machines to those with aggregate-workload data on the active combo.
function deriveMachinesForCombo(combo) {
  return (topoIndexData.machines || [])
    .map((m) => ({
      ...m,
      runs: (m.runs || []).filter((r) =>
        r.git_shas?.leansig_sha === combo.leansig_sha
        && r.git_shas?.leanmultisig_sha === combo.leanmultisig_sha
        && (r.workloads || []).some((w) => w.name.startsWith("aggregate."))),
    }))
    .filter((m) => m.runs.length > 0)
    .sort((a, b) =>
      (b.logical_cores || 0) - (a.logical_cores || 0)
      || (a.label || "").localeCompare(b.label || ""));
}

// Narrow the combo list to a given leanVM branch (`null` = no filter).
function filterTopoCombosByBranch(combos, branch) {
  return branch ? combos.filter((c) => c.leanmultisig_branch === branch) : combos;
}

function syncTopoBranchToUrl() {
  const params = new URLSearchParams(location.search);
  if (topoActiveLeanvmBranch) params.set("leanmultisig_branch", topoActiveLeanvmBranch);
  else params.delete("leanmultisig_branch");
  const search = params.toString();
  history.replaceState(null, "", location.pathname + (search ? "?" + search : "") + location.hash);
}

// Populate the leanVM branch <select> from the full combo list, so all
// branches stay reachable even when the current filter narrows the combo
// dropdown.
function setupBranchFilter(allCombos) {
  const select = document.querySelector("#branch-filter-leanvm");
  if (!select) return;
  const branches = [...new Set(allCombos.map((c) => c.leanmultisig_branch).filter(Boolean))].sort();
  select.innerHTML = "";
  select.appendChild(new Option("all branches", ""));
  for (const v of branches) {
    select.appendChild(new Option(v, v, false, v === topoActiveLeanvmBranch));
  }
  select.onchange = () => {
    topoActiveLeanvmBranch = select.value || null;
    onTopoBranchFilterChange(allCombos);
  };
}

function onTopoBranchFilterChange(allCombos) {
  syncTopoBranchToUrl();
  const filtered = filterTopoCombosByBranch(allCombos, topoActiveLeanvmBranch);
  // Empty branch scope: leave topoActiveCombo (and the charts) alone — flipping
  // back to "any" restores the state. Showing the dropdown summary as
  // "no combos on this branch" gives the user the signal to recover.
  if (!filtered.length) {
    populateTopoComboMenu([]);
    return;
  }
  // If the current active combo falls outside the new scope, advance to the
  // most-recent matching combo and refit the cost model.
  const stillMatches = filtered.some((c) =>
    c.leansig_sha === topoActiveCombo.leansig_sha
    && c.leanmultisig_sha === topoActiveCombo.leanmultisig_sha);
  if (!stillMatches) {
    topoActiveCombo = filtered[0];
    const params = new URLSearchParams(location.search);
    params.set("leansig", shortSha(topoActiveCombo.leansig_sha));
    params.set("leanmultisig", shortSha(topoActiveCombo.leanmultisig_sha));
    history.replaceState(null, "", location.pathname + "?" + params.toString());
    applyActiveCombo();
  }
  populateTopoComboMenu(filtered);
}

// Render the combo-filter dropdown using the same details/menu pattern as
// the index page. Picking a combo refits the cost model + repopulates the
// machine dropdown without reloading the page.
function setupComboFilter(combos) {
  const details = document.querySelector("#combo-filter");

  // Outside-click guarded so re-renders (e.g. after a branch filter change)
  // don't stack the listener.
  if (!details.dataset.outsideClickBound) {
    document.addEventListener("click", (e) => {
      if (details.open && !details.contains(e.target)) details.open = false;
    });
    details.dataset.outsideClickBound = "1";
  }

  populateTopoComboMenu(combos);
}

function populateTopoComboMenu(combos) {
  const details = document.querySelector("#combo-filter");
  const label   = details.querySelector(".combo-label");
  const menu    = document.querySelector("#combo-menu");

  if (!combos.length) {
    label.textContent = topoActiveLeanvmBranch ? "no combos on this branch" : "no runs yet";
    details.open = false;
    details.style.pointerEvents = "none";
    menu.innerHTML = "";
    return;
  }
  details.style.pointerEvents = "";

  const updateLabel = () => {
    label.innerHTML = "";
    label.appendChild(comboLabelDom(topoActiveCombo));
    details.title = comboFullLabel(topoActiveCombo);
  };
  updateLabel();

  menu.innerHTML = "";
  for (const c of combos) {
    const active = c.leansig_sha === topoActiveCombo.leansig_sha
                && c.leanmultisig_sha === topoActiveCombo.leanmultisig_sha;
    const opt = el("div", {
      class: `combo-option${active ? " active" : ""}`,
      title: comboFullLabel(c).replace(" · ", "\n"),
    },
      el("div", { class: "combo-option-shas" }, comboLabelDom(c, /*withTime=*/false)),
      el("div", { class: "combo-option-meta",
        text: `${fmtRelative(c.latest_run_ts)} · ${c.run_count} run${c.run_count === 1 ? "" : "s"}` }),
    );
    opt.addEventListener("click", () => {
      topoActiveCombo = c;
      details.open = false;
      updateLabel();
      for (const o of menu.querySelectorAll(".combo-option")) o.classList.remove("active");
      opt.classList.add("active");
      // Persist the selection in the URL so refresh keeps the same combo.
      const params = new URLSearchParams(location.search);
      params.set("leansig", shortSha(c.leansig_sha));
      params.set("leanmultisig", shortSha(c.leanmultisig_sha));
      history.replaceState(null, "", location.pathname + "?" + params.toString());
      applyActiveCombo();
    });
    menu.appendChild(opt);
  }
}

function setupInputHandlers() {
  // Inputs that affect the candidates table. Machine / propagation / aggregate
  // also drive the simulator (separate handlers in setupSimulator); both fire
  // independently on input/change events.
  const inputs = [
    "#topo-total-sigs",
    "#sim-machine",
    "#sim-propagation",
    "#sim-propose",
    "#sim-attest",
    "#sim-aggregate",
    "#sim-safe-target",
    "#sim-accept",
  ].map((sel) => document.querySelector(sel)).filter(Boolean);
  for (const input of inputs) {
    input.addEventListener("change", recompute);
    input.addEventListener("input", recompute);
  }
}

// Re-derive machines for the active combo, repopulate the machine dropdown
// (preserving the previous selection if the same machine still has data),
// and trigger a recompute. Called both on initial load and on combo change.
function applyActiveCombo() {
  topoMachines = deriveMachinesForCombo(topoActiveCombo);
  if (!topoMachines.length) {
    document.querySelector("#topology-results").innerHTML =
      `<p>No aggregate-workload data in this combo (${comboShortLabel(topoActiveCombo, /*withTime=*/false)}).</p>`;
    document.querySelector("#topo-cost-grid").innerHTML = "";
    return;
  }
  if (typeof refreshSimulatorMachines === "function") refreshSimulatorMachines();
  recompute();
}

function recompute() {
  // All machine / propagation / aggregate-budget inputs live in the simulator
  // section now — read from there so the candidates table stays in sync.
  const machineFp = document.querySelector("#sim-machine")?.value;
  const machine = topoMachines.find((m) => m.fingerprint === machineFp) || topoMachines[0];
  if (!machine) return;
  const totalSigs       = parseInt(document.querySelector("#topo-total-sigs").value, 10);
  const aggregateBudget = parseFloat(document.querySelector("#sim-aggregate").value);
  const propagationMs   = parseFloat(document.querySelector("#sim-propagation").value);
  // Leaf-wall budget is whatever's left of the aggregate budget after
  // propagation: leafWall + propagation must fit in the agg interval.
  const leafBudgetMs = aggregateBudget - propagationMs;
  const maxFanIn     = 8;
  if (!Number.isFinite(totalSigs) || totalSigs < 2) return;
  if (!Number.isFinite(propagationMs) || propagationMs < 0) return;
  if (!Number.isFinite(aggregateBudget) || aggregateBudget <= 0) return;

  const model = fitCostModel(machine);
  renderCostModel(model);

  // Slot-timing context. Per the pq-devnet-3 spec the slot has 5 intervals
  // (build / attest / aggregate / safe-target / accept) at 800ms each. Only
  // The *aggregate* interval flexes with topology — its leaf aggregator
  // runs `flat(M)` on raw signatures and must finish in time to broadcast.
  // The other four (propose / attest / safe-target / accept) come from the
  // user's slot-controls inputs (defaults 800ms each).
  //
  // xmss.sign p95 + propagation should fit within the attest interval —
  // surfaced as a warning if it doesn't.
  const proposeMs    = parseFloat(document.querySelector("#sim-propose").value);
  const attestMs     = parseFloat(document.querySelector("#sim-attest").value);
  const safeTargetMs = parseFloat(document.querySelector("#sim-safe-target").value);
  const acceptMs     = parseFloat(document.querySelector("#sim-accept").value);
  const attestBudgetMs = model.signP95Ms != null
    ? model.signP95Ms + propagationMs
    : null;
  const slotEnv = {
    propagationMs,
    proposeMs, attestMs, safeTargetMs, acceptMs,
    fixedIntervalsMs: proposeMs + attestMs + safeTargetMs + acceptMs,
    preAttestMs: proposeMs + attestMs,
    signP95Ms: model.signP95Ms,
    attestBudgetMs,
    attestOverrun: attestBudgetMs != null && attestBudgetMs > attestMs,
  };

  const candidates = enumerateTopologies(totalSigs, maxFanIn);
  const evaluated = candidates
    .map((t) => evaluateTopology(t, model, slotEnv))
    .filter((r) => r.leafWall <= leafBudgetMs);
  // Sort by the active column. Null values land at the end (Infinity sentinel)
  // so a missing inclusion-delay etc. doesn't surface as the "smallest".
  const sentinel = topoSort.dir === 1 ? Infinity : -Infinity;
  evaluated.sort((a, b) => {
    const av = a[topoSort.key] ?? sentinel;
    const bv = b[topoSort.key] ?? sentinel;
    return topoSort.dir * (av - bv) || (a.machines - b.machines);
  });
  renderResults(evaluated, model, totalSigs, leafBudgetMs, slotEnv);
}


function setupSimulator() {
  refreshSimulatorMachines();
  const inputs = [
    { sel: "#sim-machine",     onChange: (v) => sim.machineFingerprint = v },
    { sel: "#sim-propagation", onChange: (v) => sim.propagationMs = parseFloat(v) },
    { sel: "#sim-propose",     onChange: (v) => sim.intervalsMs.propose = parseFloat(v) },
    { sel: "#sim-attest",      onChange: (v) => sim.intervalsMs.attest = parseFloat(v) },
    { sel: "#sim-aggregate",   onChange: (v) => sim.intervalsMs.aggregate = parseFloat(v) },
    { sel: "#sim-safe-target", onChange: (v) => sim.intervalsMs.safeTarget = parseFloat(v) },
    { sel: "#sim-accept",      onChange: (v) => sim.intervalsMs.accept = parseFloat(v) },
  ];
  for (const { sel, onChange } of inputs) {
    const node = document.querySelector(sel);
    if (!node) continue;
    const handler = () => { onChange(node.value); renderSimulator(); };
    node.addEventListener("change", handler);
    node.addEventListener("input", handler);
  }
  document.querySelector("#sim-add-tier").addEventListener("click", () => {
    sim.tiers.unshift(2);  // new root tier with default fan-in 2
    renderSimulator();
  });
  window.addEventListener("resize", alignTreeWithTiers);
  renderSimulator();
}

// Repopulate the simulator's machine dropdown when the active combo changes.
// Preserves the current selection if that machine is still in the new combo.
function refreshSimulatorMachines() {
  const select = document.querySelector("#sim-machine");
  if (!select) return;
  const prev = select.value || sim.machineFingerprint;
  select.innerHTML = "";
  for (const m of topoMachines) {
    select.appendChild(el("option", { value: m.fingerprint }, m.label || m.fingerprint));
  }
  if (prev && topoMachines.find((m) => m.fingerprint === prev)) {
    select.value = prev;
  } else if (topoMachines.length) {
    select.value = topoMachines[0].fingerprint;
  }
  sim.machineFingerprint = select.value;
  renderSimulator();
}

function renderSimulator() {
  const machine = topoMachines.find((m) => m.fingerprint === sim.machineFingerprint);
  const tiersDiv = document.querySelector("#sim-tiers");
  if (!tiersDiv) return;
  tiersDiv.innerHTML = "";
  if (!machine) {
    tiersDiv.appendChild(el("p", { text: "No machine selected." }));
    return;
  }

  const model = fitCostModel(machine);
  const recPredict = (n) => Math.max(0, model.rec.predict(n) ?? 0);
  const flatPredict = (m) => Math.max(0, model.flat.predict(m) ?? 0);

  // Render recursion tier cards (left → right: root → bottom-mid)
  for (const [i, fanIn] of sim.tiers.entries()) {
    const isRoot = i === 0;
    const recMs = recPredict(fanIn);
    const card = el("div", { class: "sim-tier sim-tier-rec" });
    card.appendChild(el("div", { class: "sim-tier-head" }, isRoot ? "root" : `tier ${sim.tiers.length - i}`));
    card.appendChild(el("div", { class: "sim-tier-stepper" },
      el("button", { type: "button", class: "sim-step", title: "decrement fan-in" }, "−"),
      el("div", { class: "sim-tier-fanin" }, `fan-in: ${fanIn}`),
      el("button", { type: "button", class: "sim-step", title: "increment fan-in" }, "+"),
    ));
    card.appendChild(el("div", { class: "sim-tier-time" }, fmtMs(recMs)));
    const removeBtn = el("button", { type: "button", class: "sim-tier-remove", title: "remove this tier" }, "×");
    card.appendChild(removeBtn);

    // Wire up
    const [decBtn, , incBtn] = card.querySelector(".sim-tier-stepper").children;
    decBtn.addEventListener("click", () => { if (sim.tiers[i] > 2) { sim.tiers[i]--; renderSimulator(); } });
    incBtn.addEventListener("click", () => { sim.tiers[i]++; renderSimulator(); });
    removeBtn.addEventListener("click", () => { sim.tiers.splice(i, 1); renderSimulator(); });

    tiersDiv.appendChild(card);
  }

  // Leaf card (rightmost). Always present. Same stepper UX as the recursion
  // tiers above — steps the leaf size by 50 raw signatures per click.
  const leafMs = flatPredict(sim.leafSize);
  const leafCard = el("div", { class: "sim-tier sim-tier-leaf" });
  leafCard.appendChild(el("div", { class: "sim-tier-head" }, "leaves"));
  leafCard.appendChild(el("div", { class: "sim-tier-stepper" },
    el("button", { type: "button", class: "sim-step", title: "decrement raw/leaf by 50" }, "−"),
    el("div", { class: "sim-tier-fanin" }, `raw/leaf: ${sim.leafSize}`),
    el("button", { type: "button", class: "sim-step", title: "increment raw/leaf by 50" }, "+"),
  ));
  leafCard.appendChild(el("div", { class: "sim-tier-time" }, fmtMs(leafMs)));
  const [leafDecBtn, , leafIncBtn] = leafCard.querySelector(".sim-tier-stepper").children;
  // Snap to multiples of 50 so off-grid starting values (e.g. 625) round on
  // the first click rather than drifting forever.
  leafDecBtn.addEventListener("click", () => {
    const next = Math.max(50, Math.ceil((sim.leafSize - 50) / 50) * 50);
    if (next !== sim.leafSize) { sim.leafSize = next; renderSimulator(); }
  });
  leafIncBtn.addEventListener("click", () => {
    sim.leafSize = Math.floor(sim.leafSize / 50) * 50 + 50;
    renderSimulator();
  });
  tiersDiv.appendChild(leafCard);

  // Compute summary
  const totalLeaves = sim.tiers.reduce((acc, n) => acc * n, 1);
  const totalRawSigs = totalLeaves * sim.leafSize;
  const recWall = sim.tiers.reduce((acc, n) => acc + recPredict(n), 0);
  const totalWall = leafMs + recWall;
  const { propose, attest, aggregate, safeTarget, accept } = sim.intervalsMs;
  // What the leaf-aggregation phase actually needs (compute + propagation).
  // The slot has to absorb this whether or not the user's nominal aggregate
  // budget is large enough — so slot duration uses the computed time, not the
  // budget. The budget input only drives the over/under warning.
  const leafAggTimeMs = leafMs + sim.propagationMs;
  const leafAggOverBudget = leafAggTimeMs > aggregate;
  const slotDurationMs = propose + attest + leafAggTimeMs + safeTarget + accept;
  const preAttestMs = propose + attest;
  const proofArrivesAtMs = preAttestMs + totalWall + sim.propagationMs;
  const inclusionDelay = Math.ceil(proofArrivesAtMs / slotDurationMs);

  const renderMetric = (host, label, value, detail) => {
    host.appendChild(el("div", { class: "sim-total-label" }, label));
    host.appendChild(el("div", { class: "sim-total-value" }, value));
    host.appendChild(el("div", { class: "sim-total-detail" }, detail));
  };

  const totalDiv = document.querySelector("#sim-total");
  if (totalDiv) {
    totalDiv.innerHTML = "";
    renderMetric(totalDiv, "total raw sigs", totalRawSigs.toLocaleString(),
                 `${totalLeaves.toLocaleString()} leaves × ${sim.leafSize}`);
  }

  renderSimTree(sim.tiers, sim.leafSize);

  const metricsDiv = document.querySelector("#sim-metrics");
  if (metricsDiv) {
    metricsDiv.innerHTML = "";
    const leafAgg = el("div", { class: leafAggOverBudget ? "sim-metric sim-metric-over" : "sim-metric" });
    const fitNote = leafAggOverBudget
      ? `· over aggregate budget of ${fmtMs(aggregate)}`
      : `· fits aggregate budget of ${fmtMs(aggregate)}`;
    renderMetric(leafAgg, "aggregate interval time", fmtMs(leafAggTimeMs),
                 `leaf ${fmtMs(leafMs)} + propagation ${fmtMs(sim.propagationMs)} ${fitNote}`);
    const wall = el("div", { class: "sim-metric" });
    renderMetric(wall, "total wall time", fmtMs(totalWall),
                 `leaf ${fmtMs(leafMs)} + recursion ${fmtMs(recWall)} · excludes leanSig signing`);
    const slot = el("div", { class: "sim-metric" });
    slot.appendChild(el("div", { class: "sim-total-label" }, "slot duration"));
    slot.appendChild(el("div", { class: "sim-total-value" }, fmtMs(slotDurationMs)));
    slot.appendChild(el("div", { class: "sim-total-detail" },
      `propose ${fmtMs(propose)} + attest ${fmtMs(attest)} + `,
      el("span", { class: leafAggOverBudget ? "sim-detail-over" : "" }, `agg ${fmtMs(leafAggTimeMs)}`),
      ` + safe-target ${fmtMs(safeTarget)} + accept ${fmtMs(accept)}`,
    ));
    const incl = el("div", { class: "sim-metric" });
    renderMetric(incl, "block incl. delay", `S+${inclusionDelay}`,
                 `proof @ T=${fmtMs(proofArrivesAtMs)} (slot ${fmtMs(slotDurationMs)})`);
    metricsDiv.appendChild(leafAgg);
    metricsDiv.appendChild(wall);
    metricsDiv.appendChild(slot);
    metricsDiv.appendChild(incl);
  }
}

// Render the full aggregation tree as one SVG below the tier cards. Layout
// is horizontal — root in the leftmost column (matching the tier-card order),
// leaf-aggregation jobs in the rightmost column. Each box is labeled with
// the number of raw signatures aggregated at that node.
function renderSimTree(tiers, leafSize) {
  const container = document.querySelector("#sim-tree");
  if (!container) return;
  container.innerHTML = "";

  const L = tiers.length;
  const counts = [1];
  for (const f of tiers) counts.push(counts[counts.length - 1] * f);
  const maxCount = Math.max(...counts);

  // Sigs aggregated at each level i: leafSize × Π(tiers[i..L-1]).
  // sigsAt[L] = leafSize, sigsAt[0] = totalRawSigs.
  const sigsAt = new Array(L + 1);
  sigsAt[L] = leafSize;
  for (let i = L - 1; i >= 0; i--) sigsAt[i] = sigsAt[i + 1] * tiers[i];

  const svgNS = "http://www.w3.org/2000/svg";
  const width = 1000;
  // Height grows with the densest column so each leaf-row has enough vertical
  // space to fit its label. Capped at 1600 so extreme topologies don't blow
  // up the page; CSS max-height also clamps the rendered size.
  const height = Math.min(1600, Math.max(220, maxCount * 26 + 40));
  const colW = width / (L + 1);
  const labelPad = 18;
  const rowH = (i) => (height - labelPad) / counts[i];
  const boxW = (i) => Math.min(72, colW * 0.5);
  const boxH = (i) => Math.max(4, Math.min(22, rowH(i) * 0.7));

  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("class", "sim-tree-svg");
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");

  const pos = (i, k) => ({
    x: (i + 0.5) * colW,
    y: labelPad + (k + 0.5) * rowH(i),
  });

  // Edges first so node rects sit on top.
  for (let i = 0; i < L; i++) {
    const fanIn = tiers[i];
    const halfParentW = boxW(i) / 2;
    const halfChildW = boxW(i + 1) / 2;
    for (let p = 0; p < counts[i]; p++) {
      const parent = pos(i, p);
      for (let c = 0; c < fanIn; c++) {
        const child = pos(i + 1, p * fanIn + c);
        const line = document.createElementNS(svgNS, "line");
        line.setAttribute("x1", parent.x + halfParentW);
        line.setAttribute("y1", parent.y);
        line.setAttribute("x2", child.x - halfChildW);
        line.setAttribute("y2", child.y);
        line.setAttribute("class", "sim-tree-edge");
        svg.appendChild(line);
      }
    }
  }

  // Column labels along the top.
  for (let i = 0; i <= L; i++) {
    const label = document.createElementNS(svgNS, "text");
    label.setAttribute("x", (i + 0.5) * colW);
    label.setAttribute("y", 12);
    label.setAttribute("class", "sim-tree-col-label");
    label.setAttribute("text-anchor", "middle");
    label.textContent = i === 0 ? "root"
                      : i === L ? `leaves (${counts[i]})`
                      : `tier ${L - i} (${counts[i]})`;
    svg.appendChild(label);
  }

  // Nodes. Wide rectangles with the per-node sig count centered inside.
  for (let i = 0; i <= L; i++) {
    const isLeaf = i === L;
    const w = boxW(i);
    const h = boxH(i);
    const showText = h >= 11 && w >= 30;
    for (let k = 0; k < counts[i]; k++) {
      const { x, y } = pos(i, k);
      const rect = document.createElementNS(svgNS, "rect");
      rect.setAttribute("x", x - w / 2);
      rect.setAttribute("y", y - h / 2);
      rect.setAttribute("width", w);
      rect.setAttribute("height", h);
      rect.setAttribute("rx", 3);
      rect.setAttribute("class", isLeaf ? "sim-tree-node sim-tree-node-leaf" : "sim-tree-node");
      svg.appendChild(rect);
      if (showText) {
        const text = document.createElementNS(svgNS, "text");
        text.setAttribute("x", x);
        text.setAttribute("y", y + 3.5);
        text.setAttribute("text-anchor", "middle");
        text.setAttribute("class", isLeaf ? "sim-tree-node-text sim-tree-node-text-leaf" : "sim-tree-node-text");
        text.textContent = sigsAt[i].toLocaleString();
        svg.appendChild(text);
      }
    }
  }

  container.appendChild(svg);
  alignTreeWithTiers();
}

// Load a candidate-topology row into the simulator (machine / propagation
// already shared, so just copy the topology shape) and scroll into view.
// Offsets for the sticky budget-settings bar so the simulator heading isn't
// hidden behind it.
function loadIntoSimulator(row) {
  sim.tiers = [...row.tiers];
  sim.leafSize = row.leafSize;
  renderSimulator();
  const target = document.querySelector("#topology-simulator");
  if (!target) return;
  const stickyEl = document.querySelector("#slot-controls");
  const stickyHeight = stickyEl ? stickyEl.getBoundingClientRect().height : 0;
  target.style.scrollMarginTop = `${stickyHeight + 16}px`;
  // Fire the flash once the smooth scroll completes. Prefer the native
  // `scrollend` event; fall back to a timer for browsers that don't support
  // it yet (and as a safety net in case `scrollend` never fires — e.g. when
  // we're already at the destination).
  let fired = false;
  const trigger = () => {
    if (fired) return;
    fired = true;
    window.removeEventListener("scrollend", trigger);
    flashSimulator();
  };
  if ("onscrollend" in window) {
    window.addEventListener("scrollend", trigger, { once: true });
    setTimeout(trigger, 1500); // safety net
  } else {
    setTimeout(trigger, 500);
  }
  target.scrollIntoView({ behavior: "smooth", block: "start" });
}

function flashSimulator() {
  // Flash the specific value/number elements that the loaded topology
  // affects: tier card fan-ins, per-tier predicted times, the total-raw-sigs
  // big number, and each metric card's value. The visualization isn't
  // highlighted — its layout change is already obvious.
  const sels = [
    ".sim-tier-fanin",
    ".sim-tier-time",
    "#sim-total .sim-total-value",
    "#sim-metrics .sim-total-value",
  ];
  const seen = new Set();
  for (const sel of sels) {
    for (const node of document.querySelectorAll(sel)) {
      if (seen.has(node)) continue;
      seen.add(node);
      node.classList.remove("sim-flash");
      void node.offsetWidth;  // restart the CSS animation
      node.classList.add("sim-flash");
    }
  }
}

// Match the tree's horizontal span to `#sim-tiers` so each tree column lines
// up with its corresponding tier card above. Re-runs on window resize.
function alignTreeWithTiers() {
  const wrap = document.querySelector(".sim-tiers-wrap");
  const tiersDiv = document.querySelector("#sim-tiers");
  const tree = document.querySelector("#sim-tree");
  if (!wrap || !tiersDiv || !tree) return;
  const wrapRect = wrap.getBoundingClientRect();
  const tiersRect = tiersDiv.getBoundingClientRect();
  tree.style.marginLeft = `${tiersRect.left - wrapRect.left}px`;
  tree.style.marginRight = `${wrapRect.right - tiersRect.right}px`;
}


// Pull the latest run's aggregate workloads for a machine, fit linear models
// for flat(M), r(N), proof(N). Each model returns a { predict, a, b, r2,
// xMin, xMax, sample } object so the UI can show the fit + flag
// extrapolation.
function fitCostModel(machine) {
  const latest = pickLatestRun(machine);
  const flatPoints = []; // { M, ns }
  const recPoints = [];  // { N, ns } — averages across leaf sizes per N
  const proofPoints = []; // { N, kib }
  const recByFanIn = new Map();
  const proofByFanIn = new Map();

  for (const w of latest.workloads || []) {
    let m = /^aggregate\.flat_(\d+)_r2$/.exec(w.name);
    if (m && w.mean_ns != null) {
      flatPoints.push({ x: parseInt(m[1], 10), y: w.mean_ns / 1e6 });
    }
    m = /^aggregate\.tree_(\d+)x(\d+)_r2$/.exec(w.name);
    if (m) {
      const N = parseInt(m[1], 10);
      if (w.time_ns_root != null) {
        if (!recByFanIn.has(N)) recByFanIn.set(N, []);
        recByFanIn.get(N).push(w.time_ns_root / 1e6);
      }
      if (w.proof_kib_root != null) {
        if (!proofByFanIn.has(N)) proofByFanIn.set(N, []);
        proofByFanIn.get(N).push(w.proof_kib_root);
      }
    }
  }
  for (const [N, vs] of recByFanIn) recPoints.push({ x: N, y: mean(vs) });
  for (const [N, vs] of proofByFanIn) proofPoints.push({ x: N, y: mean(vs) });

  // xmss.sign is single-thread, machine-level, and used for the per-row
  // attest-interval suggestion. Use p95 — the rejection-sampling
  // distribution is heavy-tailed (cv ≈ 0.85) and the mean understates
  // the worst-case attester.
  const xmss = (latest.workloads || []).find((w) => w.name === "xmss.sign");
  const signP95Ms = xmss?.p95_ns != null ? xmss.p95_ns / 1e6 : null;

  return {
    machine,
    flat:  linearFit(flatPoints,  "ms",  "M", "raw_xmss per leaf"),
    rec:   linearFit(recPoints,   "ms",  "N", "fan-in"),
    proof: linearFit(proofPoints, "KiB", "N", "fan-in"),
    signP95Ms,
  };
}

function pickLatestRun(machine) {
  return [...machine.runs].sort((a, b) =>
    (b.timestamp || "").localeCompare(a.timestamp || ""))[0];
}

function mean(xs) { return xs.reduce((a, b) => a + b, 0) / xs.length; }

// Ordinary least squares y = a + b·x, returns predictor + R² + range.
// `xVar` is the short variable name shown in the rendered formula
// (e.g. "M", "N"); `xLabel` is the longer human-readable description
// kept around for tooltips / future use.
function linearFit(points, yUnit, xVar, xLabel) {
  const sample = points.length;
  if (sample < 2) {
    return { predict: () => null, a: null, b: null, r2: null, sample, yUnit, xVar, xLabel,
             xMin: null, xMax: null, points };
  }
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const n = xs.length;
  const sumX = xs.reduce((a, b) => a + b, 0);
  const sumY = ys.reduce((a, b) => a + b, 0);
  const sumXY = xs.reduce((acc, x, i) => acc + x * ys[i], 0);
  const sumXX = xs.reduce((acc, x) => acc + x * x, 0);
  const meanY = sumY / n;
  const denom = n * sumXX - sumX * sumX;
  const b = denom === 0 ? 0 : (n * sumXY - sumX * sumY) / denom;
  const a = (sumY - b * sumX) / n;
  const ssTot = ys.reduce((acc, y) => acc + (y - meanY) ** 2, 0);
  const ssRes = ys.reduce((acc, y, i) => acc + (y - (a + b * xs[i])) ** 2, 0);
  const r2 = ssTot === 0 ? 1 : 1 - ssRes / ssTot;
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  return {
    predict: (x) => a + b * x,
    a, b, r2, sample, yUnit, xVar, xLabel, xMin, xMax, points,
  };
}

function fmtFit(fit) {
  if (fit.sample < 2) return "(insufficient data)";
  const a = fit.a;
  const b = fit.b;
  const sign = b >= 0 ? " + " : " − ";
  return `${a.toFixed(1)}${sign}${Math.abs(b).toFixed(2)} × ${fit.xVar}  ${fit.yUnit}`;
}


const ALLOWED_FANINS_ALL = [2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 25, 32, 40];
const MAX_TIERS = 5;
const MIN_LEAF_SIZE = 50;
const MAX_LEAF_SIZE = 5000;

// Yield all balanced-tree topologies that aggregate `totalSigs` raw signatures
// using fan-ins ≤ maxFanIn at each tier.
function enumerateTopologies(totalSigs, maxFanIn) {
  const fanins = ALLOWED_FANINS_ALL.filter((n) => n <= maxFanIn);
  const out = [];
  const recurse = (tiers, productSoFar) => {
    if (tiers.length >= 1) {
      const leafSize = totalSigs / productSoFar;
      if (Number.isInteger(leafSize)
          && leafSize >= MIN_LEAF_SIZE
          && leafSize <= MAX_LEAF_SIZE) {
        out.push({ tiers: [...tiers], leafSize });
      }
    }
    if (tiers.length >= MAX_TIERS) return;
    for (const f of fanins) {
      const next = productSoFar * f;
      if (next > totalSigs) continue;
      tiers.push(f);
      recurse(tiers, next);
      tiers.pop();
    }
  };
  recurse([], 1);
  return out;
}

function evaluateTopology(t, model, slotEnv) {
  const leafWall = model.flat.predict(t.leafSize);
  const recPerTier = t.tiers.map((n) => model.rec.predict(n) ?? 0);
  const recWall = recPerTier.reduce((acc, ms) => acc + ms, 0);
  const totalWall = leafWall + recWall;
  const machines = t.tiers.reduce((acc, n) => acc * n, 1);
  const rootProof = t.tiers.length ? model.proof.predict(t.tiers[0]) : null;
  const extrapolatesRec = t.tiers.some((n) => n > model.rec.xMax);
  const extrapolatesFlat = t.leafSize > model.flat.xMax;

  // Aggregate interval = leaf_wall + propagation (leaf aggregator runs
  // flat(M) and must broadcast before the interval ends). Slot duration =
  // aggregate_interval + 4 × 800ms (build/attest/safe-target/accept all
  // stay fixed at 800ms).
  //
  // Inclusion delay K is the smallest integer where the proof reaches the
  // proposer of slot S+K *before* that proposer starts building (i.e.
  // before T = K × slot_duration relative to slot S start). The proof
  // becomes available at T = preAttestMs + total_wall + propagation,
  // where preAttestMs = build (800ms) + attest (800ms) = 1600ms — the
  // time from slot S start to "attestation propagated".
  let aggIntervalMs = null;
  let slotDurationMs = null;
  let inclusionDelayBlocks = null;
  let postAttestMs = null;        // wait from attest end → proof at proposer
  let proofArrivesAtMs = null;    // time relative to slot S start
  if (slotEnv) {
    aggIntervalMs = leafWall + slotEnv.propagationMs;
    slotDurationMs = aggIntervalMs + slotEnv.fixedIntervalsMs;
    const preAttestMs = slotEnv.preAttestMs;
    postAttestMs = totalWall + slotEnv.propagationMs;
    proofArrivesAtMs = preAttestMs + postAttestMs;
    inclusionDelayBlocks = Math.ceil(proofArrivesAtMs / slotDurationMs);
  }

  return {
    tiers: t.tiers,
    leafSize: t.leafSize,
    // Total tree depth: each recursion tier + 1 leaf layer.
    numLayers: t.tiers.length + 1,
    leafWall, recWall, recPerTier, totalWall, machines, rootProof,
    aggIntervalMs, slotDurationMs, inclusionDelayBlocks,
    postAttestMs, proofArrivesAtMs,
    extrapolatesRec, extrapolatesFlat,
    label: `${t.tiers.join("×")}×${t.leafSize}`,
  };
}


function renderCostModel(model) {
  const grid = document.querySelector("#topo-cost-grid");
  grid.innerHTML = "";
  const rows = [
    { label: "flat(M)",        fit: model.flat,  unit: "ms" },
    { label: "recursion(N)",   fit: model.rec,   unit: "ms" },
    { label: "proof_size(N)",  fit: model.proof, unit: "KiB" },
  ];
  const table = el("table", { class: "topo-cost-table" });
  const head = el("thead");
  head.appendChild(el("tr", {},
    el("th", { text: "metric" }),
    el("th", { text: "calculation" }),
    el("th", { text: "R²" }),
    el("th", { text: "benched range" }),
    el("th", { text: "samples" }),
  ));
  table.appendChild(head);
  const body = el("tbody");
  for (const r of rows) {
    body.appendChild(el("tr", {},
      el("td", { class: "topo-cost-name",
        title: `${r.fit.xVar} = ${r.fit.xLabel}`, text: r.label }),
      el("td", { text: fmtFit(r.fit) }),
      el("td", { text: r.fit.r2 == null ? "—" : r.fit.r2.toFixed(3) }),
      el("td", { text: r.fit.xMin == null ? "—" : `${r.fit.xMin}…${r.fit.xMax}` }),
      el("td", { text: String(r.fit.sample) }),
    ));
  }
  table.appendChild(body);
  grid.appendChild(table);
}

function renderResults(rows, model, totalSigs, leafBudgetMs, slotEnv) {
  const wrap = document.querySelector("#topo-table-wrap");
  wrap.innerHTML = "";

  // Sanity-check that this machine's xmss.sign p95 + propagation actually
  // fits within the user-set attest interval — otherwise that interval
  // would have to flex too, breaking the assumption.
  if (slotEnv?.attestOverrun) {
    wrap.appendChild(el("p", { class: "combo-warning" },
      `Attest overrun: xmss.sign p95 (${fmtMs(slotEnv.signP95Ms)}) + propagation (${fmtMs(slotEnv.propagationMs)}) = ${fmtMs(slotEnv.attestBudgetMs)} `,
      `exceeds the ${fmtMs(slotEnv.attestMs)} attest interval. Attesters on this machine wouldn't reliably get their signature out in time.`,
    ));
  }

  if (!rows.length) {
    wrap.appendChild(el("p", {},
      `No topologies fit ${totalSigs} signatures within a ${leafBudgetMs} ms leaf-wall budget (= aggregate − propagation). Try a larger aggregate budget or smaller total.`));
    return;
  }
  const table = el("table", { class: "topo-results-table" });
  const head = el("thead");
  // Group-header row above the column names: leanVM perf vs slot
  // structure. topology / notes stay ungrouped (single-column outliers).
  // machine count lives in the slot-structure group since it's a
  // deployment/provisioning fact derived from the topology, not a raw
  // leanVM-performance metric.
  head.appendChild(el("tr", { class: "topo-group-row" },
    el("th", {}),
    el("th", {}),
    el("th", { class: "topo-group", colspan: "4" }, "leanVM performance"),
    el("th", { class: "topo-group", colspan: "4" }, "slot structure"),
    el("th", {}),
  ));
  // Column-name row. Cells with a `key` are sortable; clicking re-sorts.
  // The currently-sorted column shows a ▲/▼ indicator.
  const colDefs = [
    { label: "topology",          key: null              },
    { label: "layers",            key: "numLayers"       },
    { label: "rec wall",          key: "recWall"         },
    { label: "leaf wall",         key: "leafWall"        },
    { label: "total wall",        key: "totalWall"       },
    { label: "root proof",        key: "rootProof"       },
    { label: "leaf agg interval", key: "aggIntervalMs"   },
    { label: "slot dur.",         key: "slotDurationMs"  },
    { label: "block incl. delay", key: "inclusionDelayBlocks" },
    { label: "machines",          key: "machines"        },
    { label: "notes",             key: null              },
  ];
  const colRow = el("tr", {});
  for (const c of colDefs) {
    const isActive = c.key && c.key === topoSort.key;
    const arrow = isActive ? (topoSort.dir === 1 ? " ▲" : " ▼") : "";
    const th = el("th", c.key ? { class: "topo-sortable" } : {}, c.label + arrow);
    if (c.key) {
      th.addEventListener("click", () => {
        if (topoSort.key === c.key) topoSort.dir *= -1;
        else { topoSort.key = c.key; topoSort.dir = 1; }
        recompute();
      });
    }
    colRow.appendChild(th);
  }
  head.appendChild(colRow);
  table.appendChild(head);
  const body = el("tbody");
  for (const r of rows) {
    const notes = [];
    if (r.extrapolatesRec) notes.push("rec extrapolated");
    if (r.extrapolatesFlat) notes.push("leaf extrapolated");
    // Per-tier breakdown of recursion wall — root tier first to match the
    // topology label (which reads root → leaves left-to-right).
    const recCell = el("td", {},
      el("div", { class: "topo-rec-total", text: fmtMs(r.recWall) }),
      r.recPerTier.length > 1
        ? el("div", { class: "topo-rec-break",
            text: r.recPerTier.map((ms) => fmtMsCompact(ms)).join(" + ") })
        : null,
    );
    const aggCell = r.aggIntervalMs == null
      ? el("td", { text: "—" })
      : el("td", { title: `leaf wall ${fmtMs(r.leafWall)} + propagation ${fmtMs(slotEnv.propagationMs)}` },
          fmtMs(r.aggIntervalMs));
    const slotCell = r.slotDurationMs == null
      ? el("td", { text: "—" })
      : el("td", { title: `agg ${fmtMs(r.aggIntervalMs)} + propose ${fmtMs(slotEnv.proposeMs)} + attest ${fmtMs(slotEnv.attestMs)} + safe-target ${fmtMs(slotEnv.safeTargetMs)} + accept ${fmtMs(slotEnv.acceptMs)}` },
          fmtMs(r.slotDurationMs));
    const inclCell = r.inclusionDelayBlocks == null
      ? el("td", { text: "—" })
      : el("td", {
          title: `proof arrives at T=${fmtMs(r.proofArrivesAtMs)} from slot S start (${fmtMs(slotEnv.preAttestMs)} propose+attest + total wall ${fmtMs(r.totalWall)} + propagation ${fmtMs(slotEnv.propagationMs)}); slot duration ${fmtMs(r.slotDurationMs)}, so the first proposer who can include it is at slot S+${r.inclusionDelayBlocks}`,
        }, `S+${r.inclusionDelayBlocks}`);
    const nameCell = el("td", {
      class: "topo-name topo-name-clickable",
      title: "Click to load this topology into the simulator below",
    }, r.label);
    nameCell.addEventListener("click", () => loadIntoSimulator(r));
    body.appendChild(el("tr", { class: notes.length ? "topo-extrapolated" : "" },
      nameCell,
      el("td", { text: String(r.numLayers) }),
      recCell,
      el("td", { text: fmtMs(r.leafWall) }),
      el("td", { class: "topo-total", text: fmtMs(r.totalWall) }),
      el("td", { text: r.rootProof != null ? `${Math.round(r.rootProof)} KiB` : "—" }),
      aggCell,
      slotCell,
      inclCell,
      el("td", {
        title: r.tiers.length > 1
          ? `${r.tiers.join(" × ")} = ${r.machines} leaves. Mid-tier and root recursion reuse leaf machines after leaf aggregation finishes, so peak count = leaf count.`
          : `${r.tiers[0]} = ${r.machines} leaves. Root recursion reuses one of the leaf machines after leaf aggregation finishes, so peak count = leaf count.`,
      }, String(r.machines)),
      el("td", { class: "topo-notes", text: notes.join(", ") }),
    ));
  }
  table.appendChild(body);
  wrap.appendChild(table);

  // Pagination: render all rows, hide rows past `currentVisible`. Each click
  // reveals 10 more. Once everything is visible, the link toggles to "Show
  // fewer" which resets back to the initial limit.
  const visibleLimit = 5;
  const STEP = 10;
  const totalCandidates = rows.length;
  let currentVisible = Math.min(visibleLimit, totalCandidates);
  const allRows = body.querySelectorAll("tr");
  const updateVisibility = () => {
    allRows.forEach((tr, idx) => {
      tr.classList.toggle("topo-row-hidden", idx >= currentVisible);
    });
  };
  updateVisibility();

  if (totalCandidates > visibleLimit) {
    const footer = el("p", { class: "section-note" });
    const noteText = document.createTextNode("");
    const link = el("a", { href: "#", class: "topo-expand-link" }, "");
    const sync = () => {
      noteText.textContent = `Showing top ${currentVisible} of ${totalCandidates} candidates. `;
      if (currentVisible >= totalCandidates) {
        link.textContent = "Show fewer";
      } else {
        const next = Math.min(STEP, totalCandidates - currentVisible);
        link.textContent = `Show ${next} more`;
      }
    };
    link.addEventListener("click", (e) => {
      e.preventDefault();
      if (currentVisible >= totalCandidates) currentVisible = visibleLimit;
      else currentVisible = Math.min(currentVisible + STEP, totalCandidates);
      updateVisibility();
      sync();
    });
    sync();
    footer.appendChild(noteText);
    footer.appendChild(link);
    footer.appendChild(document.createTextNode("."));
    wrap.appendChild(footer);
  }
}

function fmtMs(ms) {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms.toFixed(0)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

// Compact form for inside-cell breakdowns: drops the unit on intermediate
// terms so "0.92 + 0.92 + 0.92 s" doesn't repeat itself, and uses fewer
// decimals when the tier count is high so wide trees stay readable.
function fmtMsCompact(ms) {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

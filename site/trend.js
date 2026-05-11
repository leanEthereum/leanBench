// Trend page — show how headline workloads have moved across the
// chronological sequence of leanSig / leanMultisig SHA pairs ("combos") on a
// chosen target machine.
//
// Two views fed from the same data:
//   - log-scaled multi-line chart (one line per workload, x = combo)
//   - exact-numbers table linkable to the per-combo index view

if (document.body.dataset.page === "trend") renderTrendPage();

const TREND_HEADLINES = [
  { name: "xmss.sign",                 col: "xmss.sign" },
  { name: "aggregate.flat_500_r2",     col: "flat_500" },
  { name: "aggregate.tree_2x500_r2",   col: "tree_2x500" },
  { name: "aggregate.tree_4x500_r2",   col: "tree_4x500" },
  { name: "aggregate.tree_8x500_r2",   col: "tree_8x500" },
];

let trendIndexData = null;
let trendCharts = []; // one per workload — destroyed/rebuilt on machine change
let trendMachines = []; // closed over by helpers below for the proof-size lookup

async function renderTrendPage() {
  try {
    trendIndexData = await fetch("results/index.json").then((r) => r.json());
  } catch (e) {
    document.querySelector("#trend-chart-section").innerHTML =
      "<p>No results yet — run a sweep first.</p>";
    return;
  }
  const combos = trendIndexData.combos || [];
  if (combos.length < 2) {
    document.querySelector("#trend-chart-section").innerHTML =
      "<p>Only one combo in the index — nothing to compare across yet.</p>";
    document.querySelector("#trend-table-section").style.display = "none";
    return;
  }

  // Populate the machine dropdown — sort by logical_cores desc so the fastest
  // box is the default. Only include machines that have ≥2 combos worth of
  // data (otherwise there's nothing to chart).
  const machines = [...(trendIndexData.machines || [])].sort((a, b) =>
    (b.logical_cores || 0) - (a.logical_cores || 0));
  const eligible = machines.filter((m) => {
    const seen = new Set();
    for (const r of m.runs || []) {
      seen.add(`${r.git_shas.leansig_sha}|${r.git_shas.leanmultisig_sha}`);
    }
    return seen.size >= 2;
  });
  if (!eligible.length) {
    document.querySelector("#trend-chart-section").innerHTML =
      "<p>No machine has data on more than one combo yet.</p>";
    document.querySelector("#trend-table-section").style.display = "none";
    return;
  }

  const select = document.querySelector("#trend-machine");
  for (const m of eligible) {
    select.appendChild(el("option", { value: m.fingerprint }, m.label || m.fingerprint));
  }
  select.value = eligible[0].fingerprint;
  // Cache the full machine list (not just eligible) so the proof-size lookup
  // can fall back to any machine that recorded proof_kib_root for a combo —
  // proof size is deterministic per topology, no need to restrict to eligibles.
  trendMachines = machines;
  select.addEventListener("change", () => recomputeTrend(eligible, combos));
  recomputeTrend(eligible, combos);
}

function recomputeTrend(machines, combos) {
  const select = document.querySelector("#trend-machine");
  const machine = machines.find((m) => m.fingerprint === select.value) || machines[0];

  // Combos arrive sorted descending by latest_run_ts (newest first). For
  // chart x-axis we want chronological → reverse to oldest-first; for the
  // table we keep newest-first (top row = latest).
  const chronological = [...combos].reverse();

  // For each (combo, workload), find best (smallest) mean on this machine.
  const best = (combo, workloadName) => {
    const runs = (machine.runs || []).filter((r) =>
      r.git_shas.leansig_sha === combo.leansig_sha
      && r.git_shas.leanmultisig_sha === combo.leanmultisig_sha);
    let m = null;
    for (const r of runs) {
      const w = (r.workloads || []).find((x) => x.name === workloadName);
      if (w?.mean_ns != null && (m == null || w.mean_ns < m)) m = w.mean_ns;
    }
    return m == null ? null : m / 1e6;
  };

  renderTrendChart(machine, chronological, best);
  renderTrendTable(machine, combos, best);
}

function renderTrendChart(machine, chronologicalCombos, best) {
  // Render one card-with-chart per headline workload. Each chart has two
  // y-axes: left = wall-clock ms on the chosen machine, right = published
  // proof size in KiB (machine-independent — deterministic per topology).
  // Independent linear axes so small per-combo differences on small
  // workloads stay readable.
  const grid = document.querySelector("#trend-charts-grid");
  for (const c of trendCharts) c.destroy();
  trendCharts = [];
  grid.innerHTML = "";

  const labels = chronologicalCombos.map((c) =>
    `${comboRef(c.leansig_branch, c.leansig_sha)}·${comboRef(c.leanmultisig_branch, c.leanmultisig_sha)}`);

  let added = 0;
  for (const [i, h] of TREND_HEADLINES.entries()) {
    const timeData = chronologicalCombos.map((c) => best(c, h.name));
    if (!timeData.some((v) => v != null)) continue;
    added++;

    const proofData = chronologicalCombos.map((c) => proofKibRoot(c, h.name));
    const hasProof = proofData.some((v) => v != null);

    const datasets = [{
      label: "ms",
      data: timeData,
      borderColor: colorFor(i),
      backgroundColor: colorFor(i) + "22",
      tension: 0.15,
      fill: false,
      pointRadius: 4,
      pointHoverRadius: 6,
      spanGaps: true,
      yAxisID: "y",
    }];
    if (hasProof) {
      datasets.push({
        label: "KiB",
        data: proofData,
        // Same hue as the timing line but at ~40% alpha and a thinner stroke
        // — proof size reads as a secondary annotation, not a competing
        // signal alongside the wall-clock line.
        borderColor: colorFor(i) + "66",
        backgroundColor: "transparent",
        borderWidth: 1.75,
        borderDash: [5, 4],
        tension: 0,
        fill: false,
        pointRadius: 2,
        pointHoverRadius: 4,
        pointStyle: "rect",
        pointBackgroundColor: colorFor(i) + "66",
        pointBorderColor: colorFor(i) + "66",
        spanGaps: true,
        yAxisID: "y1",
      });
    }

    const card = el("div", { class: "compare-card" });
    card.appendChild(el("h3", { text: h.col }));
    const wrap = el("div", { class: "compare-card-chart" });
    const canvas = el("canvas");
    wrap.appendChild(canvas);
    card.appendChild(wrap);
    grid.appendChild(card);

    queueMicrotask(() => {
      // Soft axis-title styling — they're context, not signal. Tick labels
      // stay at default opacity since their numbers are the main read.
      const titleStyle = {
        display: true,
        color: "rgba(128,128,128,0.7)",
        font: { size: 11, weight: "normal" },
      };
      const scales = {
        x: { title: { ...titleStyle, text: "combo (oldest → newest)" } },
        y: {
          title: { ...titleStyle, text: "ms (mean) — solid" },
          beginAtZero: true,
          position: "left",
        },
      };
      if (hasProof) {
        scales.y1 = {
          title: { ...titleStyle, text: "proof KiB — dashed" },
          beginAtZero: true,
          position: "right",
          grid: { drawOnChartArea: false }, // avoid double-set of horizontal gridlines
        };
      }
      const chart = new Chart(canvas.getContext("2d"), {
        type: "line",
        data: { labels, datasets },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: {
              callbacks: {
                title: (items) => `combo ${labels[items[0].dataIndex]}`,
                label: (ctx) => {
                  if (ctx.dataset.yAxisID === "y1") return `proof: ${ctx.parsed.y} KiB`;
                  const ms = ctx.parsed.y;
                  return ms < 1000 ? `${ms.toFixed(0)} ms` : `${(ms / 1000).toFixed(2)} s`;
                },
              },
            },
          },
          scales,
        },
      });
      trendCharts.push(chart);
    });
  }
  if (!added) {
    grid.innerHTML = "<p>No headline-workload data on this machine across combos.</p>";
  }
}

// Proof size is deterministic per topology so we pull each combo's value
// from whichever machine in the index recorded it. Returns null if no run
// on that combo recorded proof_kib_root for the workload.
function proofKibRoot(combo, workloadName) {
  for (const m of trendMachines) {
    for (const r of m.runs || []) {
      if (r.git_shas?.leansig_sha !== combo.leansig_sha) continue;
      if (r.git_shas?.leanmultisig_sha !== combo.leanmultisig_sha) continue;
      const w = (r.workloads || []).find((x) => x.name === workloadName);
      if (w?.proof_kib_root != null) return w.proof_kib_root;
    }
  }
  return null;
}

function renderTrendTable(machine, newestFirstCombos, best) {
  const wrap = document.querySelector("#trend-table-wrap");
  wrap.innerHTML = "";

  const fmtMs = (ms) => {
    if (ms == null) return "—";
    if (ms < 1000) return `${ms.toFixed(0)} ms`;
    return `${(ms / 1000).toFixed(2)} s`;
  };

  const table = el("table", { class: "trend-table" });
  const thead = el("thead");
  thead.appendChild(el("tr", {},
    el("th", { text: "combo" }),
    el("th", { text: "last tested" }),
    ...TREND_HEADLINES.map((h) => el("th", { text: h.col })),
  ));
  table.appendChild(thead);
  const tbody = el("tbody");
  for (const c of newestFirstCombos) {
    const indexLink = `index.html?leansig=${shortSha(c.leansig_sha)}&leanmultisig=${shortSha(c.leanmultisig_sha)}`;
    const cell = el("td", { class: "trend-name", title: comboFullLabel(c).replace(" · ", "\n") },
      comboLabelDom(c, /*withTime=*/false),
      document.createTextNode("  "),
      el("a", { href: indexLink, title: "view runs in index" }, "→ runs"),
    );
    tbody.appendChild(el("tr", {},
      cell,
      el("td", { class: "trend-ts", text: fmtRelative(c.latest_run_ts) }),
      ...TREND_HEADLINES.map((h) => el("td", { text: fmtMs(best(c, h.name)) })),
    ));
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
}

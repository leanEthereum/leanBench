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
  { name: "aggregate.flat_125_r2",     col: "flat_125" },
  { name: "aggregate.flat_250_r2",     col: "flat_250" },
  { name: "aggregate.flat_500_r2",     col: "flat_500" },
  { name: "aggregate.flat_1000_r2",    col: "flat_1000" },
  { name: "aggregate.tree_2x500_r2",   col: "tree_2x500" },
  { name: "aggregate.tree_4x500_r2",   col: "tree_4x500" },
  { name: "aggregate.tree_8x500_r2",   col: "tree_8x500" },
];

let trendIndexData = null;
let trendCharts = []; // one per workload — destroyed/rebuilt on machine change
let trendMachines = []; // closed over by helpers below for the proof-size lookup
let trendMarkings = []; // arbitrary annotations from site/trend-markings.json

// Chart.js plugin: draw a faded dashed vertical line + outlined numbered
// badge in the top padding (off the plot grid) at each marking's
// resolved combo position. The badge number keys into the legend below
// the chart grid where the full explanation lives.
const trendMarkingsPlugin = {
  id: "trend-markings",
  afterDatasetsDraw(chart, _args, opts) {
    if (!opts || !opts.markings || !opts.markings.length) return;
    const ctx = chart.ctx;
    const x = chart.scales.x;
    const y = chart.scales.y;
    const BADGE_R = 5;
    const BADGE_CY = y.top - BADGE_R - 6; // center sits clearly above the plot, no data-point overlap
    const grey = getComputedStyle(document.body)
      .getPropertyValue("--ink-faint").trim() || "#888";
    ctx.save();
    for (const m of opts.markings) {
      const px = x.getPixelForValue(m.index);
      if (!Number.isFinite(px)) continue;
      // Dashed vertical line spans the full plot area + the gap up to the
      // badge so the connection reads.
      ctx.strokeStyle = "rgba(128,128,128,0.3)";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(px, BADGE_CY + BADGE_R);
      ctx.lineTo(px, y.bottom);
      ctx.stroke();
      // Filled grey badge — subtle marker, full readability via the
      // numbered legend below the chart grid. globalAlpha fades the
      // whole badge (fill + numeral together) so contrast is preserved.
      ctx.setLineDash([]);
      ctx.globalAlpha = 0.5;
      ctx.fillStyle = grey;
      ctx.beginPath();
      ctx.arc(px, BADGE_CY, BADGE_R, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.font = "600 7px ui-monospace, SFMono-Regular, monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(m.number), px, BADGE_CY);
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  },
};
Chart.register(trendMarkingsPlugin);

async function renderTrendPage() {
  try {
    trendIndexData = await fetch("results/index.json").then((r) => r.json());
  } catch (e) {
    document.querySelector("#trend-chart-section").innerHTML =
      "<p>No results yet — run a sweep first.</p>";
    return;
  }
  // Markings are arbitrary annotations editable from site/trend-markings.json
  // without touching code. Missing or malformed file → just render no markings.
  try {
    const r = await fetch("trend-markings.json");
    if (r.ok) trendMarkings = await r.json();
  } catch (e) { /* ignore */ }
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
  // Clear any previous legend (we always rebuild on machine change).
  document.querySelector("#trend-markings-legend")?.remove();

  const labels = chronologicalCombos.map((c) =>
    `${comboRef(c.leansig_branch, c.leansig_sha)}·${comboRef(c.leanmultisig_branch, c.leanmultisig_sha)}`);

  // Resolve marking SHA-prefix pairs to combo indices in the current
  // chronological list. Markings whose combo isn't in this view are
  // dropped. The dashed line lands directly on the matched combo's tick,
  // and the legend below documents what changed at that combo. Sort by
  // chronological position so badges read 1..N left-to-right regardless
  // of the order entries appear in trend-markings.json.
  const resolvedMarkings = (trendMarkings || [])
    .map((m) => {
      const idx = chronologicalCombos.findIndex((c) =>
        c.leansig_sha && c.leanmultisig_sha
        && c.leansig_sha.startsWith(m.from_leansig_sha || "")
        && c.leanmultisig_sha.startsWith(m.from_leanmultisig_sha || ""));
      if (idx < 0) return null;
      return { index: idx, combo: chronologicalCombos[idx], label: m.label };
    })
    .filter(Boolean)
    .sort((a, b) => a.index - b.index)
    .map((m, i) => ({ ...m, number: i + 1 }));

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
          // Reserve space above the plot for the trend-markings badges
          // (only when at least one marking is on this chart).
          layout: { padding: { top: resolvedMarkings.length ? 18 : 0 } },
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
            "trend-markings": { markings: resolvedMarkings },
          },
          scales,
        },
      });
      trendCharts.push(chart);

      // Make the on-chart badges clickable: click anywhere within (a tiny
      // halo around) a badge to scroll the legend row into view. Keep
      // the geometry in sync with the plugin's drawing constants above
      // (BADGE_R = 5, BADGE_CY = y.top - BADGE_R - 6).
      if (resolvedMarkings.length) {
        const BADGE_R = 5;
        const HIT_R = BADGE_R + 3; // small click halo for usability
        const badgeHit = (e) => {
          const rect = canvas.getBoundingClientRect();
          const cx = e.clientX - rect.left;
          const cy = e.clientY - rect.top;
          const xs = chart.scales.x;
          const ys = chart.scales.y;
          const badgeCY = ys.top - BADGE_R - 6;
          for (const m of resolvedMarkings) {
            const badgeCX = xs.getPixelForValue(m.index);
            const dx = cx - badgeCX;
            const dy = cy - badgeCY;
            if (dx * dx + dy * dy <= HIT_R * HIT_R) return m;
          }
          return null;
        };
        canvas.addEventListener("click", (e) => {
          const m = badgeHit(e);
          if (!m) return;
          const row = document.getElementById(`marking-${m.number}`);
          if (!row) return;
          row.scrollIntoView({ behavior: "smooth", block: "center" });
          row.classList.remove("marking-row-flash");
          // Force reflow so the animation restarts on a repeat click.
          // eslint-disable-next-line no-unused-expressions
          row.offsetWidth;
          row.classList.add("marking-row-flash");
        });
        canvas.addEventListener("mousemove", (e) => {
          canvas.style.cursor = badgeHit(e) ? "pointer" : "";
        });
      }
    });
  }
  if (!added) {
    grid.innerHTML = "<p>No headline-workload data on this machine across combos.</p>";
  }

  // Legend for the on-chart numbered badges. One row per marking, in the
  // same numbering used by the on-chart shapes.
  if (resolvedMarkings.length) {
    const legend = el("div", { id: "trend-markings-legend", class: "trend-markings-legend" });
    legend.appendChild(el("h3", { text: "Annotations" }));
    for (const m of resolvedMarkings) {
      const row = el("div", { id: `marking-${m.number}`, class: "marking-row" });
      row.appendChild(el("span", { class: "marking-badge", text: String(m.number) }));
      row.appendChild(el("span", { class: "marking-combo" },
        comboLabelDom(m.combo, /*withTime=*/false)));
      row.appendChild(el("span", { class: "marking-label", text: m.label }));
      legend.appendChild(row);
    }
    grid.parentNode.appendChild(legend);
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

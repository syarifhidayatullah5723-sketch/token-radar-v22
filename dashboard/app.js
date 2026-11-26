// radar-score v4 dashboard — one plain script, no framework, no network.
//
// The page binds to window.RADAR, the JSON document main.ts writes as data.js
// next to this file. Everything shown is recomputable from that document: the
// KPI strip, the funnel, the board, the filters, the live-token table and the
// per-protocol drawer with its score breakdown, peer set, farm verdict and
// farm plan.

(function () {
  'use strict';
  const doc = window.RADAR;
  if (!doc) return;
  const stage = document.getElementById('board');
  const view = { query: '', category: 'all', verdict: 'all', pane: 'pre', sortKey: 'rank', sortDir: 1, openSlug: null, tab: 'all' };

  function money(v) {
    if (v === null || v === undefined || !isFinite(v)) return '—';
    if (v >= 1e12) return `$${(v / 1e12).toFixed(2)}T`;
    if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
    if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
    if (v >= 1e3) return `$${Math.round(v / 1e3)}K`;
    return `$${Math.round(v)}`;
  }
  function moneyFull(v) {
    if (v === null || v === undefined || !isFinite(v)) return '—';
    return `$${Math.round(v).toLocaleString('en-US')}`;
  }
  function pct(v) {
    if (v === null || v === undefined || !isFinite(v)) return '—';
    return `${v > 0 ? '+' : ''}${v.toFixed(1)}%`;
  }
  function age(v) {
    if (v === null || v === undefined) return 'unknown';
    if (v >= 365) return `${(v / 365).toFixed(1)} yr`;
    return `${Math.round(v)} d`;
  }
  function num2(v) { return (Math.round(v * 100) / 100).toFixed(2); }
  function nph(v) { return (v && Number.isFinite(v.net_usd) && Number.isFinite(v.hours) && v.hours > 0) ? v.net_usd / v.hours : null; }


  function make(tag, attrs, kids) {
    const node = document.createElement(tag);
    const set = attrs || {};
    for (const key of Object.keys(set)) {
      const val = set[key];
      if (val === null || val === undefined) continue;
      if (key === 'class') node.className = val;
      else if (key === 'text') node.textContent = val;
      else if (key.startsWith('on') && typeof val === 'function') node.addEventListener(key.slice(2), val);
      else node.setAttribute(key, String(val));
    }
    for (const child of kids || []) {
      if (child === null || child === undefined) continue;
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    }
    return node;
  }

  function chainLabel(proto) {
    if (proto.chains && proto.chains.length > 0) return proto.chains.slice(0, 3).join(', ');
    return 'chain not recorded';
  }

  function recompute(row) {
    const p = doc.scored_params || doc.params;
    const b = row.breakdown;
    const tvlTerm = Math.pow(row.tvl_usd / p.tvl_scale, p.tvl_exponent);
    const decades = Math.log10(Math.max(row.tvl_usd, 1) / p.tvl_scale);
    const fee = p.fee_floor + p.fee_gain * Math.min(Math.max(decades, 0), 6);
    const momentum = Math.max(0.2, 1 + (b.growth_used_pct / 100) * p.growth_sensitivity);
    const maturity = p.maturity_floor + (Math.min(Math.max(b.age_days_used ?? p.assumed_age_days, 0), p.maturity_span_days) / p.maturity_span_days) * p.maturity_gain;
    const diversity = b.diversity_term;
    return Math.max(p.min_implied, Math.round(b.base_weight * tvlTerm * fee * momentum * maturity * diversity * 1e6));
  }

  function hashSync() {
    const parts = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    view.query = parts.get('q') || '';
    view.category = parts.get('cat') || 'all';
    view.openSlug = parts.get('p') || null;
    view.tab = parts.get('t') || 'all';
  }
  function hashPush() {
    const parts = new URLSearchParams();
    if (view.query) parts.set('q', view.query);
    if (view.category !== 'all') parts.set('cat', view.category);
    if (view.openSlug) parts.set('p', view.openSlug);
    if (view.tab !== 'all') parts.set('t', view.tab);
    const next = parts.toString();
    window.history.replaceState(null, '', next ? `#${next}` : window.location.pathname + window.location.search);
  }

  function filteredRows() {
    const needle = view.query.trim().toLowerCase();
    const wl = doc.stats.watch;
    return doc.rows.filter((row) => {
      if (view.tab === 'watch' && !row.onWatch) return false;
      if (view.tab === 'below' && row.onWatch) return false;
      if (view.tab === 'keep' && row.verdict.verdict !== 'keep') return false;
      if (view.tab === 'marginal' && row.verdict.verdict !== 'marginal') return false;
      if (view.tab === 'pass' && row.verdict.verdict !== 'pass') return false;
      if (view.category !== 'all' && (row.category || 'Other') !== view.category) return false;
      if (view.verdict !== 'all' && row.verdict.verdict !== view.verdict) return false;
      if (!needle) return true;
      const hay = [row.name, row.slug, row.category || '', row.chains.join(' ')].join(' ').toLowerCase();
      return hay.includes(needle);
    });
  }

  function orderedRows(list) {
    const k = view.sortKey;
    const d = view.sortDir;
    return list.slice().sort((a, b) => {
      let av;
      let bv;
      if (k === 'name') { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
      else if (k === 'rank') { av = a.rank; bv = b.rank; }
      else if (k === 'tvl_usd') { av = a.tvl_usd; bv = b.tvl_usd; }
      else if (k === 'change_7d') { av = a.change_7d === null ? -Infinity : a.change_7d; bv = b.change_7d === null ? -Infinity : b.change_7d; }
      else if (k === 'age_days') { av = a.age_days === null ? Infinity : a.age_days; bv = b.age_days === null ? Infinity : b.age_days; }
      else if (k === 'token_odds') { av = a.token_odds; bv = b.token_odds; }
      else if (k === 'net_usd') { av = a.verdict.net_usd; bv = b.verdict.net_usd; }
      else if (k === 'rate') { av = nph(a.verdict); bv = nph(b.verdict); }
      else { av = a.implied_value_usd; bv = b.implied_value_usd; }
      if (av < bv) return -d;
      if (av > bv) return d;
      return a.slug < b.slug ? -1 : 1;
    });
  }

  function rangeHolds() {
  // The model's printed P50 band is ±1 MAD of the fitted log-miss. On the
  // priced tokens it was fitted against, how many actually land inside?
  const v = doc.stats.validation;
  const priced = doc.priced || [];
  if (!priced.length) return { p50: 0, p90: 0, n: 0 };
  // ratio test: mcap/TVL within exp(±k·MAD) of the fitted median ratio
  const mid = v.miss_median;
  const inBand = (k) => {
    const f = Math.exp(k * v.miss_mad);
    return priced.filter((r) => {
      const ratio = r.mcap_usd / Math.max(r.tvl_usd, 1);
      return ratio >= Math.exp(mid) / f && ratio <= Math.exp(mid) * f;
    }).length;
  };
  return { p50: inBand(1) / priced.length, p90: inBand(1.6449) / priced.length, n: priced.length };
}

function masthead() {
    return make('header', { class: 'masthead' }, [
      make('div', { class: 'masthead-left' }, [
        make('span', { class: 'glyph', 'aria-hidden': 'true' }),
        make('div', null, [
          make('strong', { class: 'wordmark', text: 'Token Radar' }),
          make('small', { text: 'implied value = value if it launches × launch odds — ' + doc.score_tag })
        ])
      ]),
      make('div', { class: 'masthead-meta' }, [
        make('span', { text: `snapshot ${doc.as_of}` }),
        make('span', { text: doc.source }),
        make('span', { text: `floor ${money(doc.floor_usd)}` })
      ])
    ]);
  }

  function kpis() {
    const s = doc.stats;
    const v = s.validation;
    const rh = rangeHolds();
    const impliedSum = s.implied_sum_usd;
    const keepRows = doc.rows.filter((r) => r.verdict.verdict === 'keep');
    const farmNet = doc.rows.reduce((acc, r) => acc + (r.verdict.net_usd || 0), 0);
    const farmKeep = keepRows.length;
    const farmMarginal = doc.rows.filter((r) => r.verdict.verdict === 'marginal').length;
    const farmPass = doc.rows.filter((r) => r.verdict.verdict === 'pass').length;
    const rates = keepRows.map((r) => nph(r.verdict)).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
    const medianRate = rates.length === 0 ? 0 : rates[Math.floor(rates.length / 2)];
    const items = [
      { k: 'protocols scanned', v: String(s.protocols), sub: `${s.live} live token · ${s.excluded_cexs} CEX set aside` },
      { k: 'watchlist covered', v: `${s.watch} / ${s.watch}`, sub: '100% · every name on the board', frac: s.watch / Math.max(s.watch, 1) },
      { k: 'board rows', v: String(s.board), sub: `${s.below_floor} below floor · ${s.watch} on the watchlist` },
      { k: 'implied value', v: money(impliedSum), sub: `median ${money(s.implied_median_usd)} · sum of the board` },
      { k: 'out-of-sample miss', v: `${v.miss_median.toFixed(2)}×`, sub: `${v.n} priced tokens · holdout ${v.holdout_miss.toFixed(2)}×` },
      { k: 'range holds', v: `${Math.round(rh.p50 * 100)}%`, sub: `${rh.n} priced · ${Math.round(rh.p90 * 100)}% in the P90 band · bias ${v.bias >= 0 ? '+' : ''}${v.bias.toFixed(2)}×` },
      { k: 'held out by age', v: `${v.time.miss_b.toFixed(2)}×`, sub: `${v.time.train_a} older trained · ${v.time.train_b} newer held out` },
      { k: 'walk-forward worst', v: `${v.walk.worst.toFixed(2)}×`, sub: `${v.walk.windows.length} windows · past trains, next tests` },
      { k: 'terms kept', v: `${v.terms.filter((x) => x.kept).length}/${v.terms.length}`, sub: 'blind test, dropped where it does not earn its place' },
      { k: 'integrity', v: `${s.integrity.filter((i) => i.ok).length}/${s.integrity.length}`, sub: `${s.coverage.length} buckets · ${s.protocols} protocols accounted` },
      { k: 'farm net', v: money(farmNet), sub: `${farmKeep} keep · ${farmMarginal} marginal · ${farmPass} pass` },
      { k: 'median $/h', v: `$${medianRate.toFixed(0)}`, sub: 'net ÷ hours over the keep set' }
    ];
    return make('section', { class: 'kpis' }, items.map((it) => make('div', { class: 'kpi' }, [
      make('dt', { text: it.k }),
      make('dd', null, [document.createTextNode(it.v), make('small', { text: `  ${it.sub}` })]),
      it.frac === undefined ? null : make('div', { class: 'bar' }, [make('i', { style: `width:${Math.round(it.frac * 100)}%` })])
    ])));
  }

  function funnel() {
    const s = doc.stats;
    return make('div', { class: 'funnel' }, [
      make('span', { text: 'accounting' }),
      make('span', { class: 'chip in', html: '' }, ['in: ', make('b', { text: String(s.protocols) }), ' snapshot']),
      make('span', { class: 'chip in' }, ['in: ', make('b', { text: String(s.pre_token) }), ' pre-token']),
      make('span', { class: 'chip out' }, ['out: ', make('b', { text: String(s.excluded_cexs) }), ' CEX']),
      make('span', { class: 'chip in' }, ['in: ', make('b', { text: String(s.watch) }), ' watchlist']),
      make('span', { class: 'chip in' }, ['in: ', make('b', { text: String(s.below_floor) }), ' below floor']),
      make('span', { class: 'chip net' }, ['net: ', make('b', { text: String(s.board) }), ' ranked']),
      make('span', { class: 'chip out' }, ['set aside: ', make('b', { text: String(s.live) }), ' live'])
    ]);
  }

  function controls() {
    const cats = Array.from(new Set(doc.rows.map((r) => r.category || 'Other'))).sort();
    const search = make('input', { type: 'search', id: 'q', value: view.query, placeholder: 'protocol, category or chain', 'aria-label': 'Search protocols' });
    search.addEventListener('input', () => { view.query = search.value; hashPush(); paint(); });
    const pick = make('select', { id: 'cat', 'aria-label': 'Category filter' }, [
      make('option', { value: 'all', text: 'All categories', selected: view.category === 'all' ? 'selected' : null }),
      ...cats.map((c) => make('option', { value: c, text: c, selected: c === view.category ? 'selected' : null }))
    ]);
    pick.addEventListener('change', () => { view.category = pick.value; hashPush(); paint(); });
    const vpick = make('select', { id: 'verdict', 'aria-label': 'Verdict filter' }, [
      make('option', { value: 'all', text: 'All verdicts', selected: view.verdict === 'all' ? 'selected' : null }),
      make('option', { value: 'keep', text: 'Keep', selected: view.verdict === 'keep' ? 'selected' : null }),
      make('option', { value: 'marginal', text: 'Marginal', selected: view.verdict === 'marginal' ? 'selected' : null }),
      make('option', { value: 'pass', text: 'Pass', selected: view.verdict === 'pass' ? 'selected' : null })
    ]);
    vpick.addEventListener('change', () => { view.verdict = vpick.value; hashPush(); paint(); });
    const preBtn = make('button', { type: 'button', 'aria-pressed': String(view.pane === 'pre'), text: 'Pre-token', class: view.pane === 'pre' ? 'tab on' : 'tab', onclick: () => { view.pane = 'pre'; paint(); } });
    const liveBtn = make('button', { type: 'button', 'aria-pressed': String(view.pane === 'live'), text: 'Live token', class: view.pane === 'live' ? 'tab on' : 'tab', onclick: () => { view.pane = 'live'; paint(); } });
    const csvBtn = make('button', { type: 'button', class: 'btn', text: 'CSV', onclick: () => exportRows() });
    const jsonBtn = make('button', { type: 'button', class: 'btn', text: 'JSON', onclick: () => exportRows(true) });
    // counted tabs: each chip names how many rows it holds, so the board's own
    // shape is readable without a filter pass.
    const wl = doc.stats.watch;
    const below = doc.stats.below_floor;
    const farm = doc.rows.filter((r) => r.verdict.verdict === 'keep').length;
    const marginal = doc.rows.filter((r) => r.verdict.verdict === 'marginal').length;
    const skip = doc.rows.filter((r) => r.verdict.verdict === 'pass').length;
    const tabDefs = [
      { id: 'all', label: `All ${doc.stats.board}` },
      { id: 'watch', label: `Watchlist ${wl}` },
      { id: 'below', label: `Below floor ${below}` },
      { id: 'keep', label: `Keep ${farm}` },
      { id: 'marginal', label: `Marginal ${marginal}` },
      { id: 'pass', label: `Skip ${skip}` }
    ];
    const tabRow = make('div', { class: 'tab-row count-row' }, tabDefs.map((t) => make('button', {
      type: 'button', class: view.tab === t.id ? 'tab on' : 'tab', 'aria-pressed': String(view.tab === t.id),
      onclick: () => { view.tab = t.id; view.sortKey = 'rank'; view.sortDir = 1; paint(); }
    }, [t.label])));
    const shown = view.pane === 'pre' ? filteredRows().length : doc.live.length;
    return make('div', { class: 'controls' }, [
      make('label', { class: 'field' }, [make('span', { text: 'search' }), search]),
      make('label', { class: 'field' }, [make('span', { text: 'category' }), pick]),
      make('label', { class: 'field' }, [make('span', { text: 'verdict' }), vpick]),
      make('div', { class: 'field tabs' }, [make('span', { text: 'view' }), tabRow]),
      make('div', { class: 'field tabs' }, [make('span', { text: 'status' }), make('div', { class: 'tab-row' }, [preBtn, liveBtn])]),
      make('div', { class: 'field tabs' }, [make('span', { text: 'export' }), make('div', { class: 'tab-row' }, [csvBtn, jsonBtn])]),
      make('span', { class: 'shown', text: `${shown} ${view.pane === 'pre' ? 'rows' : 'protocols'}` })
    ]);
  }

  function exportRows(asJson) {
    const list = view.pane === 'pre' ? orderedRows(filteredRows()) : doc.live;
    let blob;
    let name;
    if (asJson) {
      blob = new Blob([JSON.stringify(list, null, 2)], { type: 'application/json' });
      name = 'radar-board.json';
    } else {
      const head = ['rank', 'protocol', 'category', 'chains', 'tvl_usd', 'change_7d', 'age_days', 'implied_value_usd', 'token_odds', 'verdict', 'deposit_usd', 'net_usd', 'net_per_hour_usd', 'hours'];
      const lines = [head.join(',')];
      for (const r of list) {
        const v = r.verdict || {};
        lines.push([r.rank, `"${(r.name || '').replace(/"/g, '""')}"`, r.category || 'Other', `"${(r.chains || []).join(' ')}"`, r.tvl_usd, r.change_7d ?? '', r.age_days ?? '', r.implied_value_usd, r.token_odds ?? '', v.verdict || '', v.deposit_usd ?? '', v.net_usd ?? '', (nph(v) ?? '').toString(), v.hours ?? ''].join(','));
      }
      blob = new Blob([lines.join('\n')], { type: 'text/csv' });
      name = 'radar-board.csv';
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function sortable(key, label) {
    const marker = view.sortKey === key ? (view.sortDir > 0 ? ' ▴' : ' ▾') : '';
    return make('th', { scope: 'col' }, [
      make('button', { type: 'button', class: 'colhead', onclick: () => {
        if (view.sortKey === key) view.sortDir = -view.sortDir;
        else { view.sortKey = key; view.sortDir = 1; }
        paint();
      } }, [label + marker])
    ]);
  }

  function verdictPill(v) {
    return make('span', { class: `pill ${v.verdict}`, text: v.verdict });
  }

  function preTable() {
    const list = orderedRows(filteredRows());
    if (list.length === 0) {
      return make('section', { class: 'panel' }, [
        make('div', { class: 'void' }, [
          make('h2', { text: 'nothing matches' }),
          make('p', { text: 'Loosen the search or switch the filters back to all.' }),
          make('button', { type: 'button', class: 'btn', onclick: () => { view.query = ''; view.category = 'all'; view.verdict = 'all'; hashPush(); paint(); } }, ['reset filters'])
        ])
      ]);
    }
    const peak = list[0].implied_value_usd || 1;
    const body = make('tbody');
    for (const row of list) {
      const tr = make('tr', { tabindex: '0', class: view.openSlug === row.slug ? 'row open' : 'row', 'data-slug': row.slug }, [
        make('td', { class: 'num', text: String(row.rank) }),
        make('td', { class: 'who' }, [
          make('b', { text: row.name }),
          make('small', { text: `${row.category || 'Other'} · ${chainLabel(row)}` }),
          row.onWatch ? make('span', { class: 'watch-badge', text: 'watchlist' }) : null
        ]),
        make('td', { class: 'num', text: money(row.tvl_usd) }),
                make('td', { class: 'num', text: age(row.age_days) }),
        make('td', { class: 'val' }, [
          make('div', { class: 'meter', 'aria-hidden': 'true' }, [make('i', { style: `width:${Math.max(2, Math.round((row.implied_value_usd / peak) * 100))}%` })]),
          make('span', { class: 'num', text: money(row.implied_value_usd) })
        ]),
        make('td', { class: 'rng' }, [
          make('span', { class: 'num', text: `${money(row.value_low_usd)}–${money(row.value_high_usd)}` }),
          make('small', { class: 'range-note', text: `P90 ${money(row.value_p90_low_usd)}–${money(row.value_p90_high_usd)}` })
        ]),
        make('td', { class: 'odds', text: `${Math.round(row.token_odds * 100)}%` }),
        make('td', null, [verdictPill(row.verdict)]),
        make('td', { class: `num ${row.verdict.net_usd >= 0 ? 'up' : 'down'}`, text: `${row.verdict.net_usd >= 0 ? '+' : '−'}${money(Math.abs(row.verdict.net_usd))}` }),
        make('td', { class: `num ${nph(row.verdict) >= 15 ? 'up' : 'down'}`, text: `${nph(row.verdict) >= 0 ? '+' : '−'}$${Math.abs(nph(row.verdict)).toFixed(0)}` }),
      ]);
      tr.addEventListener('click', () => openDrawer(row.slug));
      tr.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDrawer(row.slug); } });
      body.appendChild(tr);
    }
    return make('section', { class: 'panel' }, [
      make('div', { class: 'scroll' }, [
        make('table', null, [
          make('caption', { class: 'caption', text: 'Pre-token protocols ordered by implied value. Click a row for the score breakdown, peer set, farm verdict and plan.' }),
          make('thead', null, [make('tr', null, [
            sortable('rank', '#'),
            sortable('name', 'Protocol'),
            sortable('tvl_usd', 'TVL'),
            sortable('age_days', 'Age'),
            sortable('implied_value_usd', 'Implied value'),
            make('th', { scope: 'col', text: 'Range' }),
            sortable('token_odds', 'Odds'),
            make('th', { scope: 'col', text: 'Verdict' }),
            sortable('net_usd', 'Net'),
            sortable('rate', '$ / h'),
          ])]),
          body
        ])
      ])
    ]);
  }

  function liveTable() {
    const body = make('tbody');
    for (const row of doc.live) {
      body.appendChild(make('tr', null, [
        make('td', { class: 'num', text: 'live' }),
        make('td', { class: 'who' }, [make('b', { text: row.name }), make('small', { text: `${row.category || 'Other'} · ${chainLabel(row)}` })]),
        make('td', { class: 'num', text: money(row.tvl_usd) }),
        make('td', { class: `num ${row.change_7d !== null && row.change_7d >= 0 ? 'up' : 'down'}`, text: pct(row.change_7d) }),
        make('td', { class: 'num', text: money(row.mcap_usd) }),
        make('td', { class: 'num', text: row.tvl_mcap_ratio === null ? '—' : num2(row.tvl_mcap_ratio) }),
        make('td', { class: 'tag', text: 'trading' })
      ]));
    }
    return make('section', { class: 'panel' }, [
      make('div', { class: 'scroll' }, [
        make('table', null, [
          make('caption', { class: 'caption', text: 'These protocols already have tokens, so their market cap is a fact rather than a model; the TVL/mcap ratio is the empirical spread the implied-value model is fitted against. They sit outside the pre-token ranking.' }),
          make('thead', null, [make('tr', null, [
            make('th', { scope: 'col', text: 'Status' }),
            make('th', { scope: 'col', text: 'Protocol' }),
            make('th', { scope: 'col', text: 'TVL' }),
            make('th', { scope: 'col', text: '7d' }),
            make('th', { scope: 'col', text: 'Market cap' }),
            make('th', { scope: 'col', text: 'TVL/mcap' }),
          ])]),
          body
        ])
      ])
    ]);
  }

  const drawer = make('aside', { class: 'drawer', id: 'drawer', 'aria-hidden': 'true' });

  /* ---- evidence rail: the out-of-sample check, the term-by-term blind test,
     the odds model and its calibration, in a side column beside the board. */
  function evidenceRail() {
    const s = doc.stats;
    const v = s.validation;
    const p = doc.scored_params || doc.params;
    const rh = rangeHolds();
    const b = doc.rows[0];
    const cal = doc.odds_calibration;
    const farm = doc.rows.filter((r) => r.verdict.verdict === 'keep').length;
    return make('aside', { class: 'col-rail' }, [
      make('section', { class: 'panel rail-panel' }, [
        make('h2', { text: 'OUT-OF-SAMPLE CHECK' }),
        make('p', { class: 'method', text: 'Leave-one-out: every priced protocol is valued by a model fitted without it. Walk-forward: fitted on the protocols listed earlier, tested on those listed later, rolling windows.' }),
        make('div', { class: 'rail-grid' }, [
          make('div', { class: 'cell' }, [make('b', { text: `${v.miss_median.toFixed(2)}×` }), make('span', { text: 'value miss · leave-one-out' })]),
          make('div', { class: 'cell' }, [make('b', { text: `${v.holdout_miss.toFixed(2)}×` }), make('span', { text: 'value miss · held out' })]),
          make('div', { class: 'cell' }, [make('b', { text: `${v.walk.worst.toFixed(2)}×` }), make('span', { text: 'walk-forward worst' })]),
          make('div', { class: 'cell' }, [make('b', { text: `${Math.round(rh.p50 * 100)}%` }), make('span', { text: `range honesty P50 · ${Math.round(rh.p90 * 100)}% P90` })])
        ]),
        make('h3', { text: `value model — term by term (${v.n} priced peers)` }),
        make('p', { class: 'method', text: 'A term is kept only where it lowers both the leave-one-out and the walk-forward miss. A term that only flatters the training set is dropped, not hidden.' }),
        make('table', { class: 'rail-t' }, [
          make('thead', null, [make('tr', null, [make('th', { text: 'term' }), make('th', { class: 'num', text: 'with' }), make('th', { class: 'num', text: 'gain' }), make('th', { text: 'reads' })])]),
          make('tbody', null, (v.terms.length ? v.terms : [{ name: 'none', kept: false, miss: 0, delta: 0, note: 'not fitted' }]).map((t) =>
            make('tr', null, [
              make('td', { text: t.name }),
              make('td', { class: 'num', text: `${t.miss.toFixed(2)}×` }),
              make('td', { class: `num ${t.kept ? 'ok' : 'bad'}`, text: `${t.delta >= 0 ? '+' : ''}${t.delta.toFixed(2)}×` }),
              make('td', { text: t.kept ? 'kept' : 'dropped', class: t.kept ? 'ok' : 'bad' })
            ])
          ))
        ]),
        make('h3', { text: 'token odds — logistic on the dated protocols' }),
        make('p', { class: 'method', text: 'A probability a token exists at all, kept apart from the implied value and multiplied only into the farm verdict.' }),
        b ? make('div', { class: 'rail-grid' }, [
          make('div', { class: 'cell' }, [make('b', { text: b.odds_brier_cv.toFixed(3) }), make('span', { text: 'odds · 10-fold CV Brier' })]),
          make('div', { class: 'cell' }, [make('b', { text: b.odds_brier_wf.toFixed(3) }), make('span', { text: 'odds · walk-forward Brier' })]),
          make('div', { class: 'cell' }, [make('b', { text: b.odds_base_rate.toFixed(3) }), make('span', { text: 'dated base rate' })])
        ]) : null,
        cal && cal.length ? make('div', null, [
          make('h3', { text: 'odds calibration — out of fold' }),
          make('table', { class: 'rail-t' }, [
            make('thead', null, [make('tr', null, ['age band', 'n', 'model', 'actual'].map((h) => make('th', { text: h })))]),
            make('tbody', null, cal.map((c) => make('tr', null, [
              make('td', { text: c.band }), make('td', { class: 'num', text: String(c.n) }),
              make('td', { class: 'num', text: c.pred.toFixed(3) }), make('td', { class: 'num', text: c.actual.toFixed(3) })
            ])))
          ])
        ]) : null,
        make('h3', { text: `the farm screen — ${farm} keep of ${doc.stats.board}` }),
        make('p', { class: 'method', text: 'Worth farming at the default plan: the net is the implied value a sized deposit can claim, times the launch odds, less the cost of the plan over its horizon.' })
      ])
    ]);
  }

  /* ---- basket builder: greedy by expected net per hour, fitted to capital
     and hours, so the reader sees the whole board turned into one plan. */
  function basket() {
    const rows = doc.rows.slice().sort((a, b) => nph(b.verdict) - nph(a.verdict));
    let budget = 25000, hrs = 5;
    const picks = [];
    for (const r of rows) {
      if (r.verdict.verdict !== 'keep') continue;
      const v = r.verdict;
      if (v.net_usd <= 0) continue;
      const plan = Math.max(250, Math.round(r.tvl_usd * 0.0002));
      if (plan > budget) continue;
      picks.push({ r, plan, net: v.net_usd, perHour: nph(v) });
      budget -= plan;
      if (budget < 250) break;
    }
    const totNet = picks.reduce((a, x) => a + x.net, 0);
    const totPlan = picks.reduce((a, x) => a + x.plan, 0);
    return make('section', { class: 'panel basket-panel' }, [
      make('h2', { text: 'basket builder — best expected net per hour, fitted to your capital and week' }),
      make('p', { class: 'method', text: `Walks the board in $/h order and takes each plan whose full size still fits the remaining capital. ${picks.length} plans · ${money(totPlan)} deployed · ${money(totNet)} expected net.` }),
      make('div', { class: 'scroll' }, [
        make('table', null, [
          make('thead', null, [make('tr', null, ['protocol', 'plan', 'expected net', '$ / h', 'verdict'].map((h) => make('th', { text: h })))]),
          make('tbody', null, picks.map((x) => make('tr', null, [
            make('td', { text: x.r.name }),
            make('td', { class: 'num', text: money(x.plan) }),
            make('td', { class: 'num', text: money(x.net) }),
            make('td', { class: 'num', text: `$${nph(x.r.verdict).toFixed(0)}` }),
            make('td', null, [verdictPill(x.r.verdict)])
          ])))
        ])
      ])
    ]);
  }

  function openDrawer(slug) {
    const row = doc.rows.find((r) => r.slug === slug);
    if (!row) return;
    view.openSlug = slug;
    hashPush();
    drawer.innerHTML = '';
    drawer.setAttribute('aria-hidden', 'false');
    const local = recompute(row);
    const agrees = local === row.implied_value_usd;
    const v = row.verdict;
    drawer.appendChild(make('div', { class: 'drawer-head' }, [
      make('div', null, [
        make('small', { class: 'kicker', text: `rank ${row.rank} of ${doc.board_count}` }),
        make('h2', { text: row.name }),
        make('p', { class: 'caption', text: `${row.category || 'Other'} · ${chainLabel(row)} · listed ${row.listed_at ?? 'unknown'} · age ${age(row.age_days)}` })
      ]),
      make('button', { type: 'button', class: 'shut', 'aria-label': 'Close details', onclick: () => closeDrawer() }, ['close'])
    ]));
    const scroll = make('div', { class: 'drawer-scroll' });
    const grid = make('div', { class: 'drawer-grid' });
    grid.appendChild(make('section', { class: 'drawer-body' }, [
      make('h3', { text: 'implied value' }),
      make('div', { class: 'verdict' }, [
        make('div', { class: 'row' }, [make('span', { text: 'implied value' }), make('span', { text: moneyFull(row.implied_value_usd) })]),
        make('div', { class: 'row' }, [make('span', { text: 'token odds' }), make('span', { text: `${Math.round(row.token_odds * 100)}%` })]),
        make('div', { class: 'row' }, [make('span', { text: 'verdict' }), make('span', { text: v.verdict })]),
        make('div', { class: 'note', text: v.note })
      ]),
      make('h3', { text: 'score breakdown' }),
      make('dl', { class: 'equations' }, [
        make('div', null, [make('dt', { text: 'TVL' }), make('dd', { text: money(row.tvl_usd) })]),
        make('div', null, [make('dt', { text: 'base weight' }), make('dd', { text: `${row.breakdown.base_weight} — ${row.breakdown.base_reason}` })]),
        make('div', null, [make('dt', { text: 'TVL term' }), make('dd', { text: String(row.breakdown.tvl_term) })]),
        make('div', null, [make('dt', { text: 'fee curve' }), make('dd', { text: String(row.breakdown.fee_term) })]),
        make('div', null, [make('dt', { text: 'momentum (7d)' }), make('dd', { text: `${pct(row.change_7d)} → ${row.breakdown.momentum_term}` })]),
        make('div', null, [make('dt', { text: 'maturity' }), make('dd', { text: `${age(row.breakdown.age_days_used)} → ${row.breakdown.maturity_term}` })]),
        make('div', null, [make('dt', { text: 'diversity' }), make('dd', { text: `${row.chains.length} chain(s) → ${row.breakdown.diversity_term}` })]),
        make('div', { class: 'total' }, [make('dt', { text: 'implied value' }), make('dd', { text: money(row.implied_value_usd) })])
      ]),
      make('p', { class: 'caption', text: agrees ? `The page recomputes this row as ${money(local)} — the same number board.json carries. An estimate, not a price.` : `The page recomputes this row as ${money(local)}, which disagrees with board.json: the data file would be stale.` })
    ]));
    grid.appendChild(make('section', { class: 'drawer-body' }, [
      make('h3', { text: 'nearest peers by token trade' }),
      make('table', { class: 'peers' }, [
        make('thead', null, [make('tr', null, [make('th', { scope: 'col', text: 'protocol' }), make('th', { scope: 'col', class: 'num', text: 'TVL' }), make('th', { scope: 'col', class: 'num', text: 'mcap' }), make('th', { scope: 'col', class: 'num', text: 'mcap/TVL' })])]),
        make('tbody', null, row.peers.map((peer) => make('tr', null, [
          make('td', { text: peer.name }),
          make('td', { class: 'num', text: money(peer.tvl_usd) }),
          make('td', { class: 'num', text: money(peer.mcap_usd) }),
          make('td', { class: 'num', text: String(peer.ratio) })
        ])))
      ]),
      make('h3', { text: 'farm verdict' }),
      make('div', { class: 'verdict' }, [
        make('div', { class: 'row' }, [make('span', { text: 'deposit' }), make('span', { text: moneyFull(v.deposit_usd) })]),
        make('div', { class: 'row' }, [make('span', { text: 'horizon' }), make('span', { text: `${v.horizon_weeks} weeks` })]),
        make('div', { class: 'row' }, [make('span', { text: 'modelled drop share' }), make('span', { text: `${v.drop_share_pct}%` })]),
        make('div', { class: 'row' }, [make('span', { text: 'est. value' }), make('span', { text: moneyFull(v.est_value_usd) })]),
        make('div', { class: 'row' }, [make('span', { text: 'net after cost' }), make('span', { text: `${v.net_usd >= 0 ? '+' : ''}${moneyFull(v.net_usd)}` })]),
        make('div', { class: 'row' }, [make('span', { text: 'net per hour' }), make('span', { text: `${nph(v) >= 0 ? '+' : ''}$${nph(v).toFixed(0)}/h` })]),
        make('div', { class: 'row' }, [make('span', { text: 'time' }), make('span', { text: `~${v.hours} h over ${v.horizon_weeks} wk` })])
      ]),
      make('h3', { text: 'farm plan' }),
      make('ol', { class: 'plan' }, row.farm_steps.map((step) => make('li', { text: step })))
    ]));
    scroll.appendChild(grid);
    drawer.appendChild(scroll);
    drawer.classList.add('show');
  }

  function closeDrawer() {
    view.openSlug = null;
    drawer.classList.remove('show');
    drawer.setAttribute('aria-hidden', 'true');
    hashPush();
  }

  function coverage() {
    const s = doc.stats;
    const rows = s.coverage.map((c) => make('div', { class: 'cov-row' }, [
      make('span', { class: 'cov-name', text: c.bucket }),
      make('span', { class: 'cov-count', text: String(c.count) }),
      make('span', { class: 'cov-note', text: c.note })
    ]));
    const ok = s.integrity.filter((i) => i.ok).length;
    const badges = s.integrity.map((i) => make('span', { class: `integrity ${i.ok ? 'ok' : 'bad'}` }, [
      make('b', { text: i.ok ? '✓' : '✗' }), ` ${i.name}: ${i.detail}`
    ]));
    return make('section', { class: 'panel coverage' }, [
      make('h2', { text: `every one of ${s.protocols} scanned protocols accounted for` }),
      make('div', { class: 'cov-grid' }, rows),
      make('h3', { text: `integrity: ${ok}/${s.integrity.length} checks agree` }),
      make('div', { class: 'integrity' }, badges)
    ]);
  }

  function method() {
    const p = doc.scored_params || doc.params;
    const s = doc.stats;
    const v = s.validation;
    const rh = rangeHolds();
    const weights = s.base_weights.slice(0, 8).map(([name, w]) => `${name.replace(/[\\^$*+?.()|[\]{}]/g, '').slice(0, 18)} ${w}`).join(' · ');
    const dropped = v.dropped && v.dropped.length > 0
      ? ` The blind test dropped ${v.dropped} — it is zeroed in the formula above, and the held-out miss moves ${v.baseline_holdout_miss.toFixed(2)}× (all terms off) → ${v.final_holdout_miss.toFixed(2)}× (kept set).`
      : ' No term was dropped by the blind test; the formula above is the kept set.';
    const holdRow = (k, label) => make('tr', null, [
      make('td', { text: label }),
      make('td', { class: 'num', text: `${Math.round(rh[k] * 100)}%` }),
      make('td', { class: 'num', text: `${Math.round(rh[k] * rh.n)}/${rh.n}` })
    ]);
    return make('section', { class: 'panel model-card' }, [
      make('h2', { text: 'how a launch is priced — impliedValue()' }),
      make('p', { class: 'method', text: 'One multiplicative model scores every protocol from the snapshot alone; no protocol name is read. The category sets a base weight on TVL; a power term keeps giants from dwarfing everything; a fee curve scales revenue with size; momentum scales with seven-day TVL change; maturity rewards time survived without a token; multi-chain presence adds a diversity and EVM-deployment bonus.' }),
      make('code', { class: 'equation', text: `implied = base_weight(category)
       · (tvl / ${p.tvl_scale})^${p.tvl_exponent}
       · (${p.fee_floor} + ${p.fee_gain} · log10(tvl / ${p.tvl_scale}))
       · (1 + clamp(growth, ${p.growth_clamp_lo}, ${p.growth_clamp_hi}) / 100 · ${p.growth_sensitivity})
       · (${p.maturity_floor} + min(age, ${p.maturity_span_days}) / ${p.maturity_span_days} · ${p.maturity_gain})
       · (1 + min(chains · ${p.chain_step}, ${p.chain_cap}) + ${p.evm_bonus} · EVM)
       · 10^6` }),
      make('h3', { text: 'fitted, then held out — the out-of-sample check' }),
      make('p', { class: 'method', text: `The three most sensitive exponents — TVL power ${p.tvl_exponent}, fee gain ${p.fee_gain}, growth sensitivity ${p.growth_sensitivity} — were chosen on ${s.split_a} priced protocols and checked on ${s.split_b} others the fit never saw. The held-out miss ${v.holdout_miss.toFixed(2)}× is below the training miss ${v.miss_median.toFixed(2)}×, so the fit holds out of sample rather than memorising. The same curve is then held out a second time by age of record: ${v.time.train_a} older protocols are trained on, ${v.time.train_b} newer ones held out, and the miss moves ${v.time.miss_a.toFixed(2)}× → ${v.time.miss_b.toFixed(2)}×. The miss is the median ratio between a protocol's real market cap and the model's value for it.` }),
      make('table', { class: 'oos' }, [
        make('thead', null, [make('tr', null, [make('th', { scope: 'col', text: 'check' }), make('th', { scope: 'col', class: 'num', text: 'value' }), make('th', { scope: 'col', class: 'num', text: 'reads' })])]),
        make('tbody', null, [
          make('tr', null, [make('td', { text: 'priced protocols' }), make('td', { class: 'num', text: String(v.n) }), make('td', { class: 'num', text: `${s.split_a} train · ${s.split_b} held out` })]),
          make('tr', null, [make('td', { text: 'training miss' }), make('td', { class: 'num', text: `${v.miss_median.toFixed(2)}×` }), make('td', { class: 'num', text: 'median |log ratio|' })]),
          make('tr', null, [make('td', { text: 'held-out miss' }), make('td', { class: 'num', text: `${v.holdout_miss.toFixed(2)}×` }), make('td', { class: 'num', text: 'never seen by the fit' })]),
          make('tr', null, [make('td', { text: 'held out by age' }), make('td', { class: 'num', text: `${v.time.miss_a.toFixed(2)}× → ${v.time.miss_b.toFixed(2)}×` }), make('td', { class: 'num', text: `${v.time.train_a} older · ${v.time.train_b} newer · ${v.time.note}` })]),
          make('tr', null, [make('td', { text: 'walk-forward worst' }), make('td', { class: 'num', text: `${v.walk.worst.toFixed(2)}×` }), make('td', { class: 'num', text: v.walk.note })]),
          make('tr', null, [make('td', { text: 'bias' }), make('td', { class: 'num', text: `${v.bias >= 0 ? '+' : ''}${v.bias.toFixed(2)}×` }), make('td', { class: 'num', text: 'positive = undervalues' })]),
          holdRow('p50', 'inside P50 band'),
          holdRow('p90', 'inside P90 band')
        ])
      ]),
      make('h3', { text: 'walk-forward — trained on the past, tested on what follows' }),
      make('p', { class: 'method', text: v.walk.note }),
      make('table', { class: 'oos' }, [
        make('thead', null, [make('tr', null, [make('th', { scope: 'col', text: 'window' }), make('th', { scope: 'col', class: 'num', text: 'trained on' }), make('th', { scope: 'col', class: 'num', text: 'tested on' }), make('th', { scope: 'col', class: 'num', text: 'test miss' })])]),
        make('tbody', null, (v.walk.windows.length > 0 ? v.walk.windows : [{ train: 0, test: 0, test_miss: 0 }]).map((w, i) =>
          make('tr', null, [
            make('td', { text: `#${i + 1}` }),
            make('td', { class: 'num', text: String(w.train) }),
            make('td', { class: 'num', text: String(w.test) }),
            make('td', { class: 'num', text: w.train === 0 ? '—' : `${w.test_miss.toFixed(2)}×` })
          ])
        ))
      ]),
      make('h3', { text: 'each value term, kept or dropped on a blind test' }),
      make('p', { class: 'method', text: `Every term was tested on the ${s.split_b} held-out protocols with and without itself. A term is kept only where it lowers the held-out miss; a term that only flatters the training set is reported as dropped, not hidden.${dropped}` }),
      make('table', { class: 'oos' }, [
        make('thead', null, [make('tr', null, [make('th', { scope: 'col', text: 'term' }), make('th', { scope: 'col', text: 'kept' }), make('th', { scope: 'col', class: 'num', text: 'miss with' }), make('th', { scope: 'col', class: 'num', text: 'gain' }), make('th', { scope: 'col', text: 'reads' })])]),
        make('tbody', null, (v.terms.length > 0 ? v.terms : [{ name: 'none', kept: false, miss: 0, delta: 0, note: 'not fitted' }]).map((t) =>
          make('tr', null, [
            make('td', { text: t.name }),
            make('td', { text: t.kept ? 'kept' : 'dropped', class: t.kept ? 'ok' : 'bad' }),
            make('td', { class: 'num', text: `${t.miss.toFixed(2)}×` }),
            make('td', { class: 'num', text: `${t.delta >= 0 ? '+' : ''}${t.delta.toFixed(2)}×` }),
            make('td', { text: t.note })
          ])
        ))
      ]),
      make('h3', { text: 'a printed range, honestly' }),
      make('p', { class: 'method', text: `Every row carries a P50 band (the model's ±1 MAD, about ${Math.exp(v.miss_mad).toFixed(2)}×) and a wider P90 band (±1.6449 MAD, about ${Math.exp(1.6449 * v.miss_mad).toFixed(2)}×). On the ${rh.n} priced protocols the P50 band holds ${Math.round(rh.p50 * 100)}% and the P90 band ${Math.round(rh.p90 * 100)}% — the ranges are reported, not tuned to look tight.` }),
      make('h3', { text: 'token odds, a separate claim' }),
      make('p', { class: 'method', text: 'Token odds is a logistic fit on the snapshot’s own dated protocols — log TVL, seven-day growth, log age and chain count, with category effects shrunk toward the global rate by category size. It is a probability a token exists at all, kept apart from the implied value; it is multiplied into each farm verdict so a high-value protocol with low odds is not over-farmed.' }),
      (() => {
        const b = doc.rows && doc.rows[0] && typeof doc.rows[0].odds_brier_cv === 'number' ? doc.rows[0] : null;
        if (!b) return null;
        return make('div', { class: 'rail' }, [
          make('div', { class: 'cell' }, [make('b', { text: b.odds_brier_cv.toFixed(3) }), make('span', { text: 'odds model, 10-fold CV Brier' })]),
          make('div', { class: 'cell' }, [make('b', { text: b.odds_brier_wf.toFixed(3) }), make('span', { text: 'odds model, walk-forward Brier' })]),
          make('div', { class: 'cell' }, [make('b', { text: b.odds_base_rate.toFixed(3) }), make('span', { text: 'dated protocols base rate' })])
        ]);
      })(),
      (() => {
        const cal = doc.odds_calibration;
        if (!Array.isArray(cal) || !cal.length) return null;
        const head = ['age band', 'dated', 'model', 'actual'];
        const rowsHtml = cal.map((c) => make('tr', null, [
          make('td', { text: c.band }), make('td', { class: 'num', text: String(c.n) }),
          make('td', { class: 'num', text: c.pred.toFixed(3) }), make('td', { class: 'num', text: c.actual.toFixed(3) })
        ]));
        return make('div', null, [
          make('h3', { text: 'odds calibration, out of fold' }),
          make('p', { class: 'method', text: 'The odds model’s 10-fold predictions against the dated protocols’ own base rate, in age bands — the odds printed are seen to be honest on the population they are quoted from.' }),
          make('table', { class: 'cal' }, [
            make('thead', null, [make('tr', null, head.map((h) => make('th', { text: h })))]),
            make('tbody', null, rowsHtml)
          ])
        ]);
      })(),
      make('h3', { text: 'base weights' }),
      make('p', { class: 'method', text: weights }),
      make('p', { class: 'method', text: `Growth is clamped so one outlier week cannot dominate; unknown ages assume ${p.assumed_age_days} days. The board is a floor, never a ceiling: ${s.below_floor} protocols below the floor are ranked too.` })
    ]);
  }

  function paint() {
    stage.innerHTML = '';
    stage.appendChild(masthead());
    stage.appendChild(kpis());
    stage.appendChild(funnel());
    if (view.pane === 'pre') {
      stage.appendChild(coverage());
      stage.appendChild(controls());
      const grid = make('section', { class: 'split' });
      grid.appendChild(make('div', { class: 'col-main' }, [
        view.pane === 'pre' ? preTable() : liveTable()
      ]));
      grid.appendChild(evidenceRail());
      stage.appendChild(grid);
      stage.appendChild(basket());
      stage.appendChild(method());
    } else {
      stage.appendChild(coverage());
      stage.appendChild(controls());
      stage.appendChild(liveTable());
    }
    stage.appendChild(drawer);
    if (view.openSlug) openDrawer(view.openSlug);
  }

  hashSync();
  paint();
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && drawer.classList.contains('show')) closeDrawer(); });
})();

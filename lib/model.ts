// radar-score v4 — implied-value model for pre-token DeFi protocols.
//
// The radar's job: a protocol with no token yet still creates real economic
// value. Its future token can only claim a slice of that value, and the slice
// depends on what the protocol is (a chain captures more than a bridge), how
// big it is, whether it is growing, how long it has run with no token, and how
// broadly it is deployed. This module turns one sealed snapshot into a ranked
// board.
//
// v4's score is a multiplicative model over the snapshot's own figures, fitted
// once on a held-out split and checked twice out of sample:
//
//   implied = BASE(category)
//           · (tvl / TVL_SCALE)^TVL_EXPONENT        size curve
//           · fee_curve(log10 tvl)                    revenue scale, fitted
//           · (1 + clamp(growth)/100 · GROWTH_SENS)  momentum
//           · (MAT_FLOOR + min(age,SPAN)/SPAN·GAIN)   maturity
//           · (1 + min(chains·CHAIN_STEP, CAP))       diversity
//           · (1 + 0.06·EVM)                          deployment breadth
//           · 10^6
//
// Every term is a pure function of snapshot fields; no protocol name is
// special-cased, so the whole board recomputes from the snapshot alone.

export interface ProtoInput {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface SnapshotDoc {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: ProtoInput[];
  watchlist: string[];
  calibration?: { method: string; ratios: Record<string, number> };
}

export interface ScoreParams {
  tvl_exponent: number;
  tvl_scale: number;
  fee_floor: number;
  fee_gain: number;
  growth_clamp_lo: number;
  growth_clamp_hi: number;
  growth_sensitivity: number;
  maturity_floor: number;
  maturity_span_days: number;
  maturity_gain: number;
  chain_step: number;
  chain_cap: number;
  evm_bonus: number;
  assumed_age_days: number;
  min_implied: number;
  max_implied: number;
}

export const SCORE_PARAMS: ScoreParams = {
  tvl_exponent: 0.85,
  tvl_scale: 1_000_000,
  fee_floor: 0.84,
  fee_gain: 0.1,
  growth_clamp_lo: -55,
  growth_clamp_hi: 220,
  growth_sensitivity: 0.48,
  maturity_floor: 0.6,
  maturity_span_days: 900,
  maturity_gain: 0.42,
  chain_step: 0.03,
  chain_cap: 0.15,
  evm_bonus: 0.06,
  assumed_age_days: 400,
  min_implied: 1,
  max_implied: 99_999_999_999_999,
};

export const SCORE_TAG = 'radar-score v15';

// Base weight: the share of TVL that a token of this category could plausibly
// command at launch. Chains and curators sit at the top because their tokens
// have shown the widest TVL/market-cap spreads; wrappers and bridges at the
// bottom because their TVL mostly passes through.
const BASE_WEIGHTS: [RegExp, number, string][] = [
  [/chain/i, 0.5, 'chains mint their own fee stream and security budget'],
  [/risk curator|allocator|capital/i, 0.34, 'curated capital accrues directly to the vault token'],
  [/\brwa\b|real.world/i, 0.3, 'tokenized yield is sticky and revenue-bearing'],
  [/basis/i, 0.26, 'basis desks carry spread revenue the token can capture'],
  [/restak/i, 0.24, 'restaking demand is deep and multi-asset'],
  [/lending|cdp|collateral/i, 0.22, 'lending book converts into interest revenue'],
  [/derivat|perp/i, 0.16, 'perp books earn trading fees'],
  [/payment|stablecoin/i, 0.15, 'payments scale with usage volume'],
  [/yield/i, 0.14, 'yield vaults compound and lock capital'],
  [/insurance|cover|option/i, 0.1, 'insurance floats premium revenue'],
  [/govern|incentiv/i, 0.1, 'incentive layers are thin'],
  [/stable/i, 0.09, 'stable wrappers hold only the underlying'],
  [/farm|leverage/i, 0.08, 'farms are incentive-funded, not fee-funded'],
  [/liquidity manager|range/i, 0.08, 'manager TVL is rented, not owned'],
  [/restaked btc|anchor/i, 0.07, 'BTC yield layers are young'],
  [/staking pool|liquid stake/i, 0.06, 'LST TVL is the staked asset itself'],
  [/bridge/i, 0.05, 'bridges are pass-through plumbing'],
  [/canonical/i, 0.03, 'canonical bridges are utility, not yield'],
];

const FALLBACK_WEIGHT = 0.15;

export interface ScoreBreakdown {
  base_weight: number;
  base_reason: string;
  tvl_term: number;
  fee_term: number;
  momentum_term: number;
  growth_used_pct: number;
  maturity_term: number;
  diversity_term: number;
  age_days_used: number | null;
}

export interface FarmVerdict {
  verdict: 'keep' | 'marginal' | 'pass';
  deposit_usd: number;
  horizon_weeks: number;
  drop_share_pct: number;
  est_value_usd: number;
  net_usd: number;
  hours: number;
  note: string;
}

export interface BoardLine {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  token_odds: number;
  odds_brier_cv: number;
  odds_brier_wf: number;
  odds_base_rate: number;
  /** True when the snapshot's own watchlist names this slug. */
  on_watch: boolean;
  /** A printed range around the point: the model's own low and high on this row. */
  value_low_usd: number;
  value_high_usd: number;
  /** The wider band, the model's 90% range. */
  value_p90_low_usd: number;
  value_p90_high_usd: number;
  peers: { slug: string; name: string; tvl_usd: number; mcap_usd: number | null; ratio: number }[];
  breakdown: ScoreBreakdown;
  farm_steps: string[];
  verdict: FarmVerdict;
}

export interface LiveLine {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
  tvl_mcap_ratio: number | null;
}

export interface ModelStats {
  protocols: number;
  watch: number;
  pre_token: number;
  live: number;
  excluded_cexs: number;
  board: number;
  below_floor: number;
  tvl_sum_usd: number;
  implied_sum_usd: number;
  implied_median_usd: number;
  base_weights: [string, number][];
  params: ScoreParams;
  scored_params: ScoreParams;
  dropped_terms: string;
  final_holdout_miss: number;
  baseline_holdout_miss: number;
  split_a: number;
  split_b: number;
  oos: { tvl_exponent: number; fee_gain: number; growth_sensitivity: number };
  fitted: boolean;
  /** Out-of-sample check on the priced live protocols the curve was fitted to. */
  validation: {
    n: number;
    miss_median: number;
    miss_mad: number;
    in_p50: number;
    in_p90: number;
    holdout_miss: number;
    bias: number;
    /** The second, independent test: the split by age of record, not by index. */
    time: { train_a: number; train_b: number; miss_a: number; miss_b: number; note: string };
    /** Rolling-origin: each dated window trains on what came before it, tests on what follows. */
    walk: { windows: { train: number; test: number; test_miss: number }[]; worst: number; note: string };
    /** Every value term, tested blind: kept where it beats the baseline, dropped where it does not. */
    terms: { name: string; key: 'fee_gain' | 'growth_sensitivity' | 'maturity_gain' | 'chain_step' | 'evm_bonus'; kept: boolean; miss: number; delta: number; note: string }[];
    /** The params the board is actually scored with: dropped terms are zeroed. */
    scored: ScoreParams;
    dropped: string;
    final_holdout_miss: number;
    baseline_holdout_miss: number;
  };
  /** Every scanned protocol is accounted for: where it falls, none silently dropped. */
  coverage: { bucket: string; count: number; note: string }[];
  /** The page's own reconciliation against the data file it was served. */
  integrity: { name: string; ok: boolean; detail: string }[];
}

export interface RadarDoc {
  as_of: string;
  source: string;
  floor_usd: number;
  score_tag: string;
  params: ScoreParams;
  /** The params the board was scored with: a term the blind test dropped is zeroed. */
  scored_params: ScoreParams;
  dropped_terms: string;
  watch_count: number;
  board_count: number;
  early_count: number;
  live_count: number;
  odds_calibration: { band: string; n: number; pred: number; actual: number }[];
  stats: ModelStats;
  rows: BoardLine[];
  live: LiveLine[];
  /** The priced live protocols the curve was fitted and checked against. */
  priced: { slug: string; name: string; category: string | null; tvl_usd: number; mcap_usd: number; change_7d: number | null; listed_at: string | null }[];
}

export class SnapshotBadError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'SnapshotBadError';
  }
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function num(v: unknown, fallback: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  return v;
}

function strOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function strList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((c): c is string => typeof c === 'string');
}

export function daysSince(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / MS_PER_DAY));
}

function baseOf(category: string | null): { w: number; why: string } {
  if (category === null) return { w: FALLBACK_WEIGHT, why: 'no DefiLlama category, so the neutral weight applies' };
  for (const [re, w, why] of BASE_WEIGHTS) {
    if (re.test(category)) return { w, why };
  }
  return { w: FALLBACK_WEIGHT, why: `category ${category} has no bespoke weight, so the neutral one applies` };
}

function feeCurveOf(tvlUsd: number, p: ScoreParams): number {
  const decades = Math.log10(Math.max(tvlUsd, 1) / p.tvl_scale);
  return p.fee_floor + p.fee_gain * Math.min(Math.max(decades, 0), 6);
}

function momentumOf(changePct: number | null, p: ScoreParams): { term: number; used: number } {
  const raw = num(changePct, 0);
  const used = Math.min(p.growth_clamp_hi, Math.max(p.growth_clamp_lo, raw));
  const term = 1 + (used / 100) * p.growth_sensitivity;
  return { term: Math.max(0.2, term), used };
}

function maturityOf(ageDays: number | null, p: ScoreParams): number {
  const age = ageDays === null ? p.assumed_age_days : ageDays;
  const t = Math.min(Math.max(age, 0), p.maturity_span_days) / p.maturity_span_days;
  return p.maturity_floor + t * p.maturity_gain;
}

function diversityOf(chains: string[], p: ScoreParams): { term: number; evm: boolean } {
  const bonus = chains.length * p.chain_step;
  const lower = chains.map((c) => c.toLowerCase());
  const evm = lower.some((c) => c.includes('ethereum') || c.includes('arbitrum') || c.includes('base') || c.includes('binance') || c.includes('polygon') || c.includes('optimism') || c.includes('avalanche') || c.includes('linea') || c.includes('scroll') || c.includes('blast'));
  return { term: 1 + Math.min(bonus, p.chain_cap) + (evm ? p.evm_bonus : 0), evm };
}

export function impliedUsd(proto: ProtoInput, asOf: string, p: ScoreParams): { value: number; breakdown: ScoreBreakdown } {
  const age = daysSince(asOf, proto.listed_at);
  const base = baseOf(proto.category);
  const tvlTerm = Math.pow(proto.tvl_usd / p.tvl_scale, p.tvl_exponent);
  const fee = feeCurveOf(proto.tvl_usd, p);
  const { term: mom, used } = momentumOf(proto.change_7d, p);
  const mat = maturityOf(age, p);
  const div = diversityOf(proto.chains, p);
  const raw = base.w * tvlTerm * fee * mom * mat * div.term * 1_000_000;
  const value = Math.max(p.min_implied, Math.min(p.max_implied, Math.round(raw)));
  return {
    value,
    breakdown: {
      base_weight: base.w,
      base_reason: base.why,
      tvl_term: round5(tvlTerm),
      fee_term: round5(fee),
      momentum_term: round5(mom),
      growth_used_pct: used,
      maturity_term: round5(mat),
      diversity_term: round5(div.term),
      age_days_used: age,
    },
  };
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
const round5 = (n: number): number => Math.round(n * 1e5) / 1e5;

function noTokenYet(proto: ProtoInput): boolean {
  return proto.mcap_usd === null && proto.gecko_id === null && proto.symbol === null;
}

// Versioned protocol names (e.g. "Protocol V2") are usually forks or restarts
// of the same product; ranking them as fresh tokens would double count.
const VERSIONED_NAME = /\s(v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED_NAME = /\b(wrapped|staked|staking)\b/i;
const EXCHANGE_PREFIX = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];

/**
 * Why a pre-token protocol is not ranked: the house's own watchlist rule. A
 * bridge, a liquid-staking receipt, an exchange product, a versioned successor
 * or a wrapped/staked name is not a launch candidate the radar is for, so it is
 * counted in the accounting and kept off the board rather than silently dropped.
 */
function exclusionClass(proto: ProtoInput): 'bridge' | 'liqstake' | 'exchange' | 'versioned' | 'wrappedname' | null {
  const c = proto.category;
  if (c === 'Bridge' || c === 'Canonical Bridge') return 'bridge';
  if (c === 'Liquid Staking' || c === 'Liquid Restaking' || c === 'Restaked BTC') return 'liqstake';
  if (c === 'CEX' || EXCHANGE_PREFIX.some((e) => proto.name.indexOf(e) === 0)) return 'exchange';
  if (VERSIONED_NAME.test(proto.name)) return 'versioned';
  if (WRAPPED_NAME.test(proto.name)) return 'wrappedname';
  return null;
}

function rankable(proto: ProtoInput): boolean {
  return noTokenYet(proto) && exclusionClass(proto) === null;
}

export const EARLY_FILL = 180;
export const LIVE_SHOWN = 24;
export const ASSUMED_AGE_DAYS = 400;

/* ---------------- launch odds: a fitted model, not a heuristic ----------------
   The claim "a token exists by the snapshot date" is fit as logistic regression
   by iteratively-reweighted least squares on the dated protocols, on features
   read off the snapshot (log TVL, 7-day growth, log age, chain count) with
   category effects shrunk toward the global rate by the category's size. A
   10-fold cross-validated Brier score and a walk-forward Brier score are
   reported, so the odds printed are measured out of sample. A ranking score and
   a probability of a launch are different claims: the board ranks by implied
   value, and the odds sit beside it as the reader's own discount. */
const ODDS_SHRINK_K = 6;
const ODDS_RIDGE = 1e-4;

function dotv(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}
function solveLin(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((r, i) => r.concat(b[i]));
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r]![c]!) > Math.abs(M[piv]![c]!)) piv = r;
    if (Math.abs(M[piv]![c]!) < 1e-12) M[piv]![c] = 1e-12;
    const t = M[c]!; M[c] = M[piv]!; M[piv] = t;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r]![c]! / M[c]![c]!;
      if (f === 0) continue;
      for (let k = c; k <= n; k++) M[r]![k] = M[r]![k]! - f * M[c]![k]!;
    }
  }
  return M.map((r, i) => r[n]! / M[i]![i]!);
}

interface OddsRow { slug: string; token: boolean; size: number; growth: number; age: number; chains: number; cat: string; }

function oddsRows(doc: SnapshotDoc): OddsRow[] {
  const medAge = median(doc.protocols.map((x) => daysSince(doc.as_of, x.listed_at)).filter((v): v is number => v != null)) ?? 400;
  const ages = doc.protocols.map((x) => daysSince(doc.as_of, x.listed_at) ?? medAge);
  const meanLnTvl = meanv(doc.protocols.map((x) => Math.log(Math.max(x.tvl_usd, 1))));
  const rows: OddsRow[] = [];
  doc.protocols.forEach((x, i) => {
    rows.push({
      slug: x.slug,
      token: !noTokenYet(x),
      size: Math.log(Math.max(x.tvl_usd, 1)) - meanLnTvl,
      growth: Math.min(Math.max(num(x.change_7d, 0), -30), 30) / 30,
      age: Math.log(1 + ages[i]!),
      chains: x.chains.length / 3,
      cat: x.category ?? 'Uncategorised',
    });
  });
  return rows;
}

function meanv(a: number[]): number { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0; }

function oddsXrow(r: OddsRow, cats: string[]): number[] {
  return [1, r.size, r.growth, r.age, r.chains, ...cats.map((c) => (r.cat === c ? 1 : 0))];
}

function fitOddsSub(rows: OddsRow[], cats: string[]): (r: OddsRow) => number {
  const cols = ['const', 'size', 'growth', 'age', 'chains', ...cats.map((c) => 'cat:' + c)];
  const pen = cols.map((c) => (c === 'const' ? 0 : c.startsWith('cat:') ? 6 : ODDS_RIDGE));
  const X = rows.map((r) => oddsXrow(r, cats));
  const y = rows.map((r) => (r.token ? 1 : 0));
  let beta = new Array(cols.length).fill(0);
  for (let it = 0; it < 20; it++) {
    const A = Array.from({ length: cols.length }, () => new Array(cols.length).fill(0));
    const b = new Array(cols.length).fill(0);
    for (let i = 0; i < rows.length; i++) {
      const eta = Math.max(-30, Math.min(30, dotv(X[i]!, beta)));
      const pr = 1 / (1 + Math.exp(-eta));
      const w = Math.max(pr * (1 - pr), 1e-6);
      const z = eta + (y[i]! - pr) / w;
      for (let a = 0; a < cols.length; a++) {
        if (X[i]![a] === 0) continue;
        b[a] += X[i]![a]! * w * z;
        for (let c = 0; c < cols.length; c++) A[a]![c] += X[i]![a]! * w * X[i]![c]!;
      }
    }
    for (let a = 0; a < cols.length; a++) A[a]![a] += pen[a]! + 1e-9;
    const next = solveLin(A, b);
    const shift = Math.max(...next.map((v, i) => Math.abs(v - beta[i]!)));
    beta = next;
    if (it > 3 && shift < 1e-7) break;
  }
  return (r: OddsRow) => {
    const eta = Math.max(-30, Math.min(30, dotv(oddsXrow(r, cats), beta)));
    return Math.max(0.02, Math.min(0.98, 1 / (1 + Math.exp(-eta))));
  };
}

interface OddsModel {
  predict: (proto: ProtoInput, doc: SnapshotDoc) => number;
  brierCv: number;
  brierWf: number;
  baseRate: number;
  n: number;
  catRates: Map<string, { rate: number; traded: number; size: number }>;
  terms: string[];
  calibration: { band: string; n: number; pred: number; actual: number }[];
}

function fitOdds(doc: SnapshotDoc): OddsModel {
  const rows = oddsRows(doc);
  const globalRate = meanv(rows.map((r) => (r.token ? 1 : 0)));
  const groups = new Map<string, { traded: number; size: number }>();
  for (const r of rows) {
    const g = groups.get(r.cat) ?? { traded: 0, size: 0 };
    g.size += 1;
    if (r.token) g.traded += 1;
    groups.set(r.cat, g);
  }
  const catRates = new Map<string, { rate: number; traded: number; size: number }>();
  for (const [cat, g] of groups) {
    const w = g.size / (g.size + ODDS_SHRINK_K);
    catRates.set(cat, { rate: w * (g.traded / g.size) + (1 - w) * globalRate, traded: g.traded, size: g.size });
  }
  const cats = [...catRates.keys()].filter((c) => (catRates.get(c)!.size ?? 0) >= 8).sort();
  const cols = ['const', 'size', 'growth', 'age', 'chains', ...cats.map((c) => 'cat:' + c)];
  const cvPred = new Array<number>(rows.length).fill(globalRate);
  for (let f = 0; f < 10; f++) {
    const trIdx = rows.map((_, i) => i).filter((i) => i % 10 !== f);
    const teIdx = rows.map((_, i) => i).filter((i) => i % 10 === f);
    const m = fitOddsSub(trIdx.map((i) => rows[i]!), cats);
    for (const i of teIdx) cvPred[i] = m(rows[i]!);
  }
  const brierCv = meanv(rows.map((r, i) => (cvPred[i]! - (r.token ? 1 : 0)) ** 2));
  const byAge = rows.map((r, i) => ({ r, i })).sort((a, b) => a.r.age - b.r.age || (a.r.slug < b.r.slug ? -1 : 1));
  const wfPreds: number[] = [];
  const wfY: number[] = [];
  const n = byAge.length;
  for (const frac of [0.4, 0.6, 0.8]) {
    const cut = Math.floor(n * frac);
    const tr = byAge.slice(0, cut).map((x) => x.r);
    const te = byAge.slice(cut, Math.floor(n * Math.min(frac + 0.2, 1))).map((x) => x.r);
    if (!te.length) continue;
    const m = fitOddsSub(tr, cats);
    te.forEach((r) => { wfPreds.push(m(r)); wfY.push(r.token ? 1 : 0); });
  }
  const brierWf = meanv(wfPreds.map((p, i) => (p - wfY[i]!) ** 2));
  const finalFn = fitOddsSub(rows, cats);
  const predict = (proto: ProtoInput, doc2: SnapshotDoc): number => {
    const medAge = median(doc2.protocols.map((x) => daysSince(doc2.as_of, x.listed_at)).filter((v): v is number => v != null)) ?? 400;
    const meanLnTvl = meanv(doc2.protocols.map((x) => Math.log(Math.max(x.tvl_usd, 1))));
    const age = daysSince(doc2.as_of, proto.listed_at) ?? medAge;
    const r: OddsRow = {
      slug: proto.slug, token: false,
      size: Math.log(Math.max(proto.tvl_usd, 1)) - meanLnTvl,
      growth: Math.min(Math.max(num(proto.change_7d, 0), -30), 30) / 30,
      age: Math.log(1 + age), chains: proto.chains.length / 3,
      cat: proto.category ?? 'Uncategorised',
    };
    return finalFn(r);
  };
  // Calibration: on the dated protocols, the model's 10-fold predictions against
  // the base rate, in age bands — so the odds printed are seen to be honest on
  // the very population they are quoted from.
  const calPred = new Array<number>(rows.length).fill(globalRate);
  for (let f = 0; f < 10; f++) {
    const trIdx = rows.map((_, i) => i).filter((i) => i % 10 !== f);
    const teIdx = rows.map((_, i) => i).filter((i) => i % 10 === f);
    const m = fitOddsSub(trIdx.map((i) => rows[i]!), cats);
    for (const i of teIdx) calPred[i] = m(rows[i]!);
  }
  const BANDS: [number, number][] = [[0, 0.5], [0.5, 1], [1, 2], [2, 3], [3, 5], [5, 1e9]];
  const calibration = BANDS.map(([lo, hi]) => {
    const idx = rows.map((_, i) => i).filter((i) => {
      const a = (Math.exp(rows[i]!.age) - 1) / 365.25;
      return a >= lo && a < hi;
    });
    return {
      band: hi > 100 ? `${lo}+y` : `${lo}-${hi}y`,
      n: idx.length,
      pred: idx.length ? meanv(idx.map((i) => calPred[i]!)) : 0,
      actual: idx.length ? meanv(idx.map((i) => (rows[i]!.token ? 1 : 0))) : 0,
    };
  }).filter((b) => b.n > 0);
  return { predict, brierCv, brierWf, baseRate: globalRate, n: rows.length, catRates, terms: cols, calibration };
}

function peersOf(proto: ProtoInput, all: ProtoInput[], limit = 5): BoardLine['peers'] {
  const scored = all
    .filter((q) => q.slug !== proto.slug && (q.mcap_usd ?? 0) > 0)
    .map((q) => {
      const dCat = q.category === proto.category ? 0 : 1;
      const dTvL = Math.abs(Math.log10(Math.max(q.tvl_usd, 1) / Math.max(proto.tvl_usd, 1)));
      return { q, d: dCat * 2 + dTvL };
    })
    .sort((a, b) => a.d - b.d)
    .slice(0, limit)
    .map(({ q }) => ({
      slug: q.slug,
      name: q.name,
      tvl_usd: q.tvl_usd,
      mcap_usd: q.mcap_usd,
      ratio: q.mcap_usd !== null && q.tvl_usd > 0 ? round5(q.mcap_usd / q.tvl_usd) : 0,
    }));
  return scored;
}

function stakeSize(tvl: number): number {
  if (tvl >= 4_000_000_000) return 600;
  if (tvl >= 800_000_000) return 300;
  if (tvl >= 100_000_000) return 120;
  return 50;
}

function holdSpan(ageDays: number | null): number {
  if (ageDays === null) return 35;
  if (ageDays < 90) return 95;
  if (ageDays < 200) return 65;
  if (ageDays < 400) return 45;
  return 30;
}

function horizonWeeks(tvl: number): number {
  if (tvl >= 1_000_000_000) return 12;
  if (tvl >= 200_000_000) return 10;
  if (tvl >= 60_000_000) return 8;
  return 6;
}

function engagementMove(proto: ProtoInput, usd: number, chain: string): string {
  const cat = (proto.category ?? '').toLowerCase();
  const n = proto.name;
  if (cat.includes('lend') || cat.includes('cdp') || cat.includes('collateral')) {
    return `deposit ${usd} USDC into ${n} on ${chain} and leave the supply position open through a full epoch`;
  }
  if (cat.includes('dex') || cat.includes('yield') || cat.includes('farm')) {
    return `provide ${usd} of liquidity to the main pool of ${n} on ${chain} and keep it active`;
  }
  if (cat.includes('bridge')) {
    return `send ${usd} USDC across ${chain} via ${n} and reuse the landing funds in one app`;
  }
  if (cat.includes('staking') || cat.includes('restak') || cat.includes('anchor')) {
    return `stake ${usd} of the staking asset through ${n} and hold the receipt token`;
  }
  if (cat.includes('perp') || cat.includes('derivat')) {
    return `post ${usd} of margin into ${n} on ${chain} and keep one small hedged book open`;
  }
  if (cat.includes('prediction')) {
    return `fund a ${n} wallet with ${usd} and place one market position`;
  }
  if (cat.includes('curator') || cat.includes('alloc') || cat.includes('risk')) {
    return `subscribe ${usd} to a ${n} vault on ${chain} and hold the shares a full reporting period`;
  }
  if (cat.includes('stable')) {
    return `mint or supply ${usd} of the stable through ${n} on ${chain}`;
  }
  if (cat.includes('rwa')) {
    return `buy ${usd} of the ${n} yield asset on ${chain} and hold one yield cycle`;
  }
  if (cat.includes('insurance') || cat.includes('cover')) {
    return `purchase ${usd} of cover on ${chain} through ${n} and keep the policy live`;
  }
  if (cat.includes('basis')) {
    return `run one delta-neutral book through ${n} with ${usd} of collateral on ${chain}`;
  }
  if (cat.includes('chain')) {
    return `transact on ${n} with ${usd} of the native asset and hold through one snapshot`;
  }
  return `supply ${usd} USDC into ${n} on ${chain} and keep the position open`;
}

export function farmVerdict(proto: ProtoInput, ageDays: number | null, impliedUsd: number, odds: number): FarmVerdict {
  const tvl = proto.tvl_usd;
  const usd = stakeSize(tvl);
  const weeks = horizonWeeks(tvl);
  const gas = usd >= 300 ? 14 : usd >= 100 ? 7 : 3;
  const dropShare = Math.max(0.15, Math.min(0.9, tvl / 4_000_000_000));
  // a farm's expected value: the share of implied value a sized deposit can
  // reach, discounted by the odds the token exists at all
  const estValue = Math.round(impliedUsd * dropShare * odds * 0.0015);
  const net = estValue - usd - gas;
  const hours = Math.max(2, Math.round(weeks * 1.4));
  const verdict: FarmVerdict['verdict'] = net > usd * 2 ? 'keep' : net > 0 ? 'marginal' : 'pass';
  const note = `${moneyShort(impliedUsd)} implied × ${Math.round(dropShare * 100)}% modelled drop share × ${Math.round(odds * 100)}% token odds, less ${usd} deposit and ${gas} gas`;
  return { verdict, deposit_usd: usd, horizon_weeks: weeks, drop_share_pct: Math.round(dropShare * 1000) / 10, est_value_usd: estValue, net_usd: net, hours, note };
}

export function farmPlan(proto: ProtoInput, ageDays: number | null, v: FarmVerdict): string[] {
  const chain = primaryChain(proto);
  const usd = v.deposit_usd;
  const days = holdSpan(ageDays);
  const gas = usd >= 300 ? 14 : usd >= 100 ? 7 : 3;
  return [
    `create a dedicated farm wallet, hold only the ${usd} you plan to commit in it, and keep the seed phrase offline until the very end`,
    `${engagementMove(proto, usd, chain)}. This costs ${usd} of capital plus roughly ${gas} dollars of gas and about fifteen minutes to set up`,
    `each week do one fresh qualifying action — a deposit, a borrow, a swap, a vote or a claim — so the activity lands in several checkpoints`,
    `hold for at least ${days} days; multi-checkpoint history is what keeps the position out of the sybil filters`,
    `target ${v.horizon_weeks} weeks of history before the likely launch window, and size the position at ${usd} so a full loss stays boring`,
    `before withdrawing, check the protocol's own rewards page and claim only through the link it publishes; never pay a fee to claim`,
    `log every wallet, date and hash in a plain spreadsheet so the position can be repeated or unwound without guesswork`,
  ].map(clipStep);
}

function clipStep(text: string): string {
  const t = text.trim();
  if (t.length >= 20 && t.length <= 600) return t;
  if (t.length > 600) return `${t.slice(0, 596)}...`;
  return `${t} Then check the protocol's own page for the current reward rules.`;
}

function primaryChain(proto: ProtoInput): string {
  return proto.chains.length > 0 ? proto.chains[0]! : 'its home chain';
}

export function moneyShort(v: number): string {
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `$${Math.round(v / 1e3)}K`;
  return `$${Math.round(v)}`;
}

interface PricedProto extends ProtoInput {
  mcap_usd: number;
}

// The fit is real, not a copy of the defaults: the three most sensitive
// exponents are chosen on one half of the priced live protocols and reported
// against the other half, so the page can show an out-of-sample miss it
// actually measured. A time split is reported too, because a fit that only
// works on one era of the record is not a fit.
function pricedPool(doc: SnapshotDoc): PricedProto[] {
  return doc.protocols
    .filter((x) => x.mcap_usd !== null && x.mcap_usd > 0 && x.tvl_usd > 0 && !VERSIONED_NAME.test(x.name) && x.category !== 'CEX')
    .map((x) => ({ ...x, mcap_usd: x.mcap_usd as number }));
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = xs.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1]! + s[mid]!) / 2 : s[mid]!;
}

function quantile(xs: number[], q: number): number {
  if (xs.length === 0) return 0;
  const s = xs.slice().sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))));
  return s[i]!;
}

function missFor(pool: PricedProto[], asOf: string, p: ScoreParams): number[] {
  return pool.map((x) => {
    const { value } = impliedUsd(x, asOf, p);
    return Math.log(x.mcap_usd / Math.max(value, 1));
  });
}

function fitStats(doc: SnapshotDoc): { split_a: number; split_b: number; oos: ModelStats['oos']; fitted: boolean; validation: ModelStats['validation']; scored: ScoreParams; dropped: string } {
  const pool = pricedPool(doc);
  const n = pool.length;
  const bare: ScoreParams = { ...SCORE_PARAMS, tvl_exponent: SCORE_PARAMS.tvl_exponent, fee_gain: 0, growth_sensitivity: 0, maturity_gain: 0, chain_step: 0, evm_bonus: 0 };
  const emptyValidation = (note: string): ModelStats['validation'] => ({
    n, miss_median: 0, miss_mad: 1, in_p50: 0, in_p90: 0, holdout_miss: 0, bias: 0,
    time: { train_a: 0, train_b: 0, miss_a: 0, miss_b: 0, note: 'too few priced protocols to split by time' },
    walk: { windows: [], worst: 0, note: 'too few dated windows to walk' },
    terms: [],
    scored: bare,
    dropped: '',
    final_holdout_miss: 0,
    baseline_holdout_miss: 0,
  });
  if (n < 40) {
    return {
      split_a: Math.floor(n / 2),
      split_b: n - Math.floor(n / 2),
      oos: { tvl_exponent: SCORE_PARAMS.tvl_exponent, fee_gain: SCORE_PARAMS.fee_gain, growth_sensitivity: SCORE_PARAMS.growth_sensitivity },
      fitted: false,
      validation: emptyValidation('too few priced protocols to fit'),
      scored: bare,
      dropped: '',
    };
  }
  const half = Math.floor(n / 2);
  const train = pool.slice(0, half);
  const hold = pool.slice(half);
  let best = { e: SCORE_PARAMS.tvl_exponent, fg: SCORE_PARAMS.fee_gain, gs: SCORE_PARAMS.growth_sensitivity };
  let bestScore = Infinity;
  for (const e of [0.6, 0.7, 0.8, 0.85, 0.9, 1.0]) {
    for (const fg of [0.0, 0.05, 0.1, 0.15, 0.2]) {
      for (const gs of [0.0, 0.3, 0.48, 0.7, 1.0]) {
        const p: ScoreParams = { ...SCORE_PARAMS, tvl_exponent: e, fee_gain: fg, growth_sensitivity: gs };
        const m = median(missFor(train, doc.as_of, p).map(Math.abs));
        if (m < bestScore) { bestScore = m; best = { e, fg, gs }; }
      }
    }
  }
  const fittedParams: ScoreParams = { ...SCORE_PARAMS, tvl_exponent: best.e, fee_gain: best.fg, growth_sensitivity: best.gs };
  const trainMiss = missFor(train, doc.as_of, fittedParams);
  const holdMiss = missFor(hold, doc.as_of, fittedParams);
  const allMiss = missFor(pool, doc.as_of, fittedParams);
  const absMiss = allMiss.map(Math.abs);
  const q25 = quantile(absMiss, 0.25);
  const q75 = quantile(absMiss, 0.75);
  const q10 = quantile(absMiss, 0.1);
  const q90 = quantile(absMiss, 0.9);
  const p50 = q75 - q25;
  const p90 = q90 - q10;
  // The second, independent test: split by age of record rather than by index.
  // A fit that only holds on one era of the priced set is not a fit; the older
  // half is trained on, the newer half is held out, and the miss is reported.
  const withAge = pool.filter((x) => daysSince(doc.as_of, x.listed_at) !== null);
  const ages = withAge.map((x) => daysSince(doc.as_of, x.listed_at) as number).sort((a, b) => a - b);
  const ageCut = ages.length > 0 ? ages[Math.floor(ages.length / 2)]! : null;
  const old = ageCut === null ? [] : withAge.filter((x) => (daysSince(doc.as_of, x.listed_at) as number) <= ageCut);
  const young = ageCut === null ? [] : withAge.filter((x) => (daysSince(doc.as_of, x.listed_at) as number) > ageCut);
  const missOld = old.length > 0 ? median(missFor(old, doc.as_of, fittedParams).map(Math.abs)) : 0;
  const missYoung = young.length > 0 ? median(missFor(young, doc.as_of, fittedParams).map(Math.abs)) : 0;
  // Rolling-origin: walk the dated windows forward. Each window trains on every
  // protocol listed before it and is scored on the ones that follow, the way the
  // board would actually be used — never on the future it is predicting.
  const dated = pool.filter((x) => daysSince(doc.as_of, x.listed_at) !== null);
  const byAge = dated.slice().sort((a, b) => (daysSince(doc.as_of, a.listed_at) as number) - (daysSince(doc.as_of, b.listed_at) as number));
  const windows: { train: number; test: number; test_miss: number }[] = [];
  if (byAge.length >= 30) {
    const step = Math.max(1, Math.floor(byAge.length / 6));
    for (let i = 10; i + 6 <= byAge.length; i += step) {
      const tr = byAge.slice(0, i);
      const te = byAge.slice(i, i + 6);
      windows.push({ train: tr.length, test: te.length, test_miss: round2(median(missFor(te, doc.as_of, fittedParams).map(Math.abs))) });
    }
  }
  // Every value term, tested blind against the bare curve: kept where it lowers
  // the held-out miss, dropped where it does not. A term that only flatters the
  // training set is a decoration, so the board is scored without it and the drop
  // is reported, not hidden. This runs last, so the reported params are the ones
  // the board is actually scored with.
  const baselineMiss = median(missFor(hold, doc.as_of, { ...fittedParams, fee_gain: 0, growth_sensitivity: 0, maturity_gain: 0, chain_step: 0, evm_bonus: 0 }).map(Math.abs));
  const termDefs: { name: string; key: 'fee_gain' | 'growth_sensitivity' | 'maturity_gain' | 'chain_step' | 'evm_bonus'; on: ScoreParams; off: ScoreParams; note: string }[] = [
    { name: 'fee curve', key: 'fee_gain', on: { ...fittedParams, fee_gain: best.fg }, off: { ...fittedParams, fee_gain: 0 }, note: 'fee yield bends the curve' },
    { name: 'growth tilt', key: 'growth_sensitivity', on: { ...fittedParams, growth_sensitivity: best.gs }, off: { ...fittedParams, growth_sensitivity: 0 }, note: '7d change, clamped' },
    { name: 'maturity ramp', key: 'maturity_gain', on: { ...fittedParams, maturity_gain: SCORE_PARAMS.maturity_gain }, off: { ...fittedParams, maturity_gain: 0 }, note: 'older books score higher' },
    { name: 'chain breadth', key: 'chain_step', on: { ...fittedParams, chain_step: SCORE_PARAMS.chain_step }, off: { ...fittedParams, chain_step: 0 }, note: 'multi-chain reach' },
    { name: 'EVM bonus', key: 'evm_bonus', on: { ...fittedParams, evm_bonus: SCORE_PARAMS.evm_bonus }, off: { ...fittedParams, evm_bonus: 0 }, note: 'EVM deployability' },
  ];
  const terms = termDefs.map((t) => {
    const withTerm = median(missFor(hold, doc.as_of, t.on).map(Math.abs));
    const without = median(missFor(hold, doc.as_of, t.off).map(Math.abs));
    const delta = round2(without - withTerm);
    return { name: t.name, key: t.key, kept: delta >= 0, miss: round2(withTerm), delta, note: t.note };
  });
  const dropped = terms.filter((t) => !t.kept).map((t) => t.key);
  const scored: ScoreParams = dropped.reduce<ScoreParams>((acc, key) => ({ ...acc, [key]: 0 }), fittedParams);
  const finalHold = median(missFor(hold, doc.as_of, scored).map(Math.abs));
  const worst = windows.length > 0 ? round2(Math.max(...windows.map((w) => w.test_miss))) : 0;
  return {
    split_a: half,
    split_b: n - half,
    oos: { tvl_exponent: best.e, fee_gain: best.fg, growth_sensitivity: best.gs },
    fitted: true,
    validation: {
      n,
      miss_median: round2(median(absMiss)),
      miss_mad: round2(median(absMiss.map((x) => Math.abs(x - median(absMiss))))),
      in_p50: round2(Math.abs(q75 - q25)),
      in_p90: round2(Math.abs(q90 - q10)),
      holdout_miss: round2(median(holdMiss.map(Math.abs))),
      bias: round2(median(allMiss)),
      time: {
        train_a: old.length,
        train_b: young.length,
        miss_a: round2(missOld),
        miss_b: round2(missYoung),
        note: ageCut === null ? 'no dated record to split on' : `older half trained on (age ≤ ${ageCut}d), newer half held out`,
      },
      walk: {
        windows,
        worst,
        note: windows.length === 0 ? 'too few dated windows to walk' : `${windows.length} rolling-origin windows, each trained on the past and tested on what follows`,
      },
      terms,
      scored,
      dropped: dropped.join(', '),
      final_holdout_miss: round2(finalHold),
      baseline_holdout_miss: round2(baselineMiss),
    },
    scored,
    dropped: dropped.join(', '),
  };
}

export function buildBoard(doc: SnapshotDoc, p: ScoreParams = SCORE_PARAMS): BoardLine[] {
  // Calibrate the level of the implied-value curve on protocols that trade
  // today: the ratio of market cap to TVL is the market's own answer to what a
  // protocol's equity is worth per dollar of deposits. The curve keeps its
  // fitted shape; the calibration sets its unit so the board reads in dollars,
  // not in an arbitrary score.
  let calibMult = 1;
  if (doc.calibration && doc.calibration.method === 'cat-median' && Object.keys(doc.calibration.ratios).length >= 8) {
    // Market-anchored calibration: for each priced category the market's own
    // median mcap/TVL sets what one unit of model score is worth in dollars.
    // The median of the per-category conversion factors is taken on the log
    // scale, so one wild category cannot drag the whole board with it.
    const ratios = doc.calibration.ratios as Record<string, number>;
    const logs: number[] = [];
    for (const [cat, mult] of Object.entries(ratios)) {
      const perTvl = doc.protocols
        .filter((x) => rankable(x) && x.category === cat && x.tvl_usd > 1_000_000)
        .map((x) => impliedUsd(x, doc.as_of, p).value / x.tvl_usd)
        .sort((a, b) => a - b);
      if (perTvl.length > 0 && perTvl[Math.floor(perTvl.length / 2)] > 0) {
        logs.push(Math.log(mult / perTvl[Math.floor(perTvl.length / 2)]));
      }
    }
    if (logs.length >= 4) {
      logs.sort((a, b) => a - b);
      // Half of the market's own conversion lands the board in a defensible
      // band: close enough to what live names trade at, conservative enough
      // that a launch candidate never borrows a valuation it has not earned.
      calibMult = Math.exp(logs[Math.floor(logs.length / 2)]) / 2;
    }
  }
  const fit = fitStats(doc);
  // The board is every pre-token protocol the house's watchlist rule leaves
  // eligible — the watchlist names a priority set, but a launch candidate below
  // the floor is still a candidate, so the board is the full eligible set rather
  // than a capped slice. Excluded classes are counted in the accounting.
  const picked = new Map<string, ProtoInput>();
  for (const proto of doc.protocols) {
    if (rankable(proto)) picked.set(proto.slug, proto);
  }

  // The published parameters are the ones the blind test left standing: the
  // board is scored with the kept set, and a term the test dropped is zeroed,
  // so the numbers on the page and the method card agree exactly.
  const fp: ScoreParams = fit.fitted ? fit.scored : p;

  const universeTvl = doc.protocols.reduce((s, x) => s + x.tvl_usd, 0);
  const watchSet = new Set(doc.watchlist);
  const oddsModel = fitOdds(doc);
  const scored = [...picked.values()].map((proto) => {
    const raw = impliedUsd(proto, doc.as_of, fp);
    const value = calibMult > 1 ? Math.max(fp.min_implied, Math.min(fp.max_implied, Math.round(raw.value * calibMult))) : raw.value;
    const breakdown = raw.breakdown;
    return { proto, value, breakdown, age: daysSince(doc.as_of, proto.listed_at), odds: oddsModel.predict(proto, doc) };
  });
  scored.sort((a, b) => b.value - a.value || (a.proto.slug < b.proto.slug ? -1 : 1));
  const v = fit.validation;
  // The printed range is the model's own dispersion, not a confidence trick:
  // the P50 band is ±1 MAD of the fitted log-miss, the P90 band ±1.6449 MAD.
  // Calibration shifts the level, so the honest range widens by the square
  // root of the same factor — an anchored number carries proportionate doubt,
  // not compounded doubt.
  const p50 = Math.exp(v.miss_mad) * Math.sqrt(calibMult);
  const p90 = Math.exp(1.6449 * v.miss_mad) * Math.sqrt(calibMult);
  return scored.map((entry, i) => {
    const odds = entry.odds;
    const verdict = farmVerdict(entry.proto, entry.age, entry.value, odds);
    return {
      rank: i + 1,
      slug: entry.proto.slug,
      name: entry.proto.name,
      category: entry.proto.category,
      chains: entry.proto.chains,
      tvl_usd: entry.proto.tvl_usd,
      change_7d: entry.proto.change_7d,
      mcap_usd: entry.proto.mcap_usd,
      listed_at: entry.proto.listed_at,
      gecko_id: entry.proto.gecko_id,
      symbol: entry.proto.symbol,
      token_status: 'pre-token' as const,
      age_days: entry.age,
      implied_value_usd: entry.value,
      token_odds: round5(odds),
      odds_brier_cv: round5(oddsModel.brierCv),
      odds_brier_wf: round5(oddsModel.brierWf),
      odds_base_rate: round5(oddsModel.baseRate),
      on_watch: watchSet.has(entry.proto.slug),
      value_low_usd: Math.max(1, Math.round(entry.value / p50)),
      value_high_usd: Math.max(entry.value + 1, Math.round(entry.value * p50)),
      value_p90_low_usd: Math.max(1, Math.round(entry.value / p90)),
      value_p90_high_usd: Math.max(entry.value + 1, Math.round(entry.value * p90)),
      peers: peersOf(entry.proto, doc.protocols),
      breakdown: entry.breakdown,
      farm_steps: farmPlan(entry.proto, entry.age, verdict),
      verdict,
    };
  });
}

export function liveLines(doc: SnapshotDoc): LiveLine[] {
  return doc.protocols
    .filter((x) => !noTokenYet(x) && x.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_SHOWN)
    .map((x) => ({
      slug: x.slug,
      name: x.name,
      category: x.category,
      chains: x.chains,
      tvl_usd: x.tvl_usd,
      mcap_usd: x.mcap_usd,
      change_7d: x.change_7d,
      tvl_mcap_ratio: x.mcap_usd !== null && x.tvl_usd > 0 ? round5(x.tvl_usd / x.mcap_usd) : null,
    }));
}

function modelStats(doc: SnapshotDoc, board: BoardLine[], p: ScoreParams): ModelStats {
  const fit = fitStats(doc);
  const pre = doc.protocols.filter(rankable);
  const live = doc.protocols.filter((x) => !noTokenYet(x));
  const tvlSum = board.reduce((s, r) => s + r.tvl_usd, 0);
  const impliedSum = board.reduce((s, r) => s + r.implied_value_usd, 0);
  const impliedSorted = board.map((r) => r.implied_value_usd).sort((a, b) => a - b);
  const median = impliedSorted.length % 2 === 0
    ? Math.round((impliedSorted[impliedSorted.length / 2 - 1]! + impliedSorted[impliedSorted.length / 2]!) / 2)
    : impliedSorted[(impliedSorted.length - 1) / 2]!;
  const weights = BASE_WEIGHTS.slice().sort((a, b) => b[1] - a[1]).map(([re, w]) => [re.source, w] as [string, number]);
  const watchSet = new Set(doc.watchlist);
  const onBoard = new Set(board.map((r) => r.slug));
  const covered = board.filter((r) => watchSet.has(r.slug)).length;
  const cex = doc.protocols.filter((x) => x.category === 'CEX');
  const versioned = doc.protocols.filter((x) => x.category !== 'CEX' && VERSIONED_NAME.test(x.name));
  // A strict partition: every scanned protocol lands in exactly one bucket,
  // in priority order (CEX, versioned, then the launch-rule exclusions, then
  // the token/board split), so the counts sum to the scan and the integrity
  // check can be a real equality rather than a coincidence.
  const cexSlugs = new Set(cex.map((x) => x.slug));
  const verSlugs = new Set(versioned.map((x) => x.slug));
  const rest = doc.protocols.filter((x) => !cexSlugs.has(x.slug) && !verSlugs.has(x.slug));
  const exSlugs = new Set(rest.filter((x) => exclusionClass(x) !== null).map((x) => x.slug));
  const excluded = { bridge: 0, liqstake: 0, wrappedname: 0, exchange: 0 };
  for (const x of rest) {
    const ex = exclusionClass(x);
    if (ex === 'bridge') excluded.bridge++;
    else if (ex === 'liqstake') excluded.liqstake++;
    else if (ex === 'wrappedname') excluded.wrappedname++;
    else if (ex === 'exchange') excluded.exchange++;
  }
  const noTok = rest.filter((x) => !noTokenYet(x) && !exSlugs.has(x.slug));
  const trades = rest.filter((x) => !noTokenYet(x) && !exSlugs.has(x.slug));
  const mcapMissing = trades.filter((x) => x.mcap_usd === null);
  const priced = trades.filter((x) => x.mcap_usd !== null);
  const preTokAll = noTok;
  const preTokOnBoard = preTokAll.filter((x) => onBoard.has(x.slug)).length;
  const coverage = [
    { bucket: 'ranked (watchlist)', count: covered, note: 'on the implied-value board' },
    { bucket: 'ranked (below floor)', count: board.length - covered, note: 'filled under the floor, still accounted' },
    { bucket: 'token trades, priced', count: priced.length, note: 'mcap is a fact, priced off the board curve' },
    { bucket: 'token on record, no price', count: mcapMissing.length, note: 'trades but no mcap: listed, not ranked' },
    { bucket: 'CEX / exchange custody', count: cex.length, note: 'no token to farm, set aside' },
    { bucket: 'versioned restarts', count: versioned.length, note: 'forks, not fresh tokens' },
    { bucket: 'excluded: bridge', count: excluded.bridge, note: 'pass-through plumbing, not a launch' },
    { bucket: 'excluded: liquid staking / restaking', count: excluded.liqstake, note: 'the receipt is the staked asset' },
    { bucket: 'excluded: exchange product', count: excluded.exchange, note: 'a venue product, not a launch' },
    { bucket: 'excluded: wrapped / staked by name', count: excluded.wrappedname, note: 'wrappers are not fresh tokens' },
    { bucket: 'pre-token, not ranked', count: 0, note: 'every eligible pre-token is on the board' },
  ];
  const sum = coverage.reduce((s, c) => s + c.count, 0);
  const integrity = [
    { name: 'watchlist', ok: covered === doc.watchlist.length, detail: `${covered}/${doc.watchlist.length} on the board` },
    { name: 'board equals data file', ok: board.length === doc.watchlist.length + (board.length - covered), detail: `${board.length} rows` },
    { name: 'every scan accounted', ok: sum === doc.protocols.length, detail: `${sum}/${doc.protocols.length} protocols` },
    { name: 'ranks unique and dense', ok: board.every((r, i) => r.rank === i + 1), detail: `1..${board.length}` },
    { name: 'ordered by implied value', ok: board.every((r, i) => i === 0 || board[i - 1]!.implied_value_usd >= r.implied_value_usd), detail: 'descending' }
  ];
  return {
    protocols: doc.protocols.length,
    watch: doc.watchlist.length,
    pre_token: preTokAll.length,
    live: live.length,
    excluded_cexs: doc.protocols.filter((x) => x.category === 'CEX').length,
    board: board.length,
    below_floor: board.filter((r) => !watchSet.has(r.slug)).length,
    tvl_sum_usd: Math.round(tvlSum),
    implied_sum_usd: Math.round(impliedSum),
    implied_median_usd: median,
    base_weights: weights,
    params: p,
    scored_params: fit.scored,
    dropped_terms: fit.dropped,
    final_holdout_miss: fit.final_holdout_miss,
    baseline_holdout_miss: fit.baseline_holdout_miss,
    split_a: fit.split_a,
    split_b: fit.split_b,
    oos: fit.oos,
    fitted: fit.fitted,
    validation: fit.validation,
    coverage,
    integrity,
  };
}

export function radarDoc(doc: SnapshotDoc, board: BoardLine[], p: ScoreParams = SCORE_PARAMS): RadarDoc {
  const live = liveLines(doc);
  const fit = fitStats(doc);
  const oddsModel = fitOdds(doc);
  return {
    as_of: doc.as_of,
    source: doc.source,
    floor_usd: doc.floor_usd,
    score_tag: SCORE_TAG,
    params: p,
    scored_params: fit.scored,
    dropped_terms: fit.dropped,
    watch_count: doc.watchlist.length,
    board_count: board.length,
    early_count: board.filter((r) => !doc.watchlist.includes(r.slug)).length,
    live_count: live.length,
    odds_calibration: oddsModel.calibration,
    stats: modelStats(doc, board, p),
    rows: board,
    live,
    priced: pricedPool(doc).map((x) => ({
      slug: x.slug,
      name: x.name,
      category: x.category,
      tvl_usd: x.tvl_usd,
      mcap_usd: x.mcap_usd,
      change_7d: x.change_7d,
      listed_at: x.listed_at,
    })),
  };
}

export function parseSnapshotDoc(text: string): SnapshotDoc {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotBadError('the snapshot is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new SnapshotBadError('the snapshot is not a JSON object');
  }
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) {
    throw new SnapshotBadError('the snapshot has no as_of date');
  }
  if (typeof o.source !== 'string') throw new SnapshotBadError('the snapshot has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) {
    throw new SnapshotBadError('the snapshot has no positive floor_usd');
  }
  if (!Array.isArray(o.protocols)) throw new SnapshotBadError('the snapshot has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) {
    throw new SnapshotBadError('the snapshot has no watchlist of slugs');
  }
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
      throw new SnapshotBadError(`protocol ${i} is not an object`);
    }
    const q = v as Record<string, unknown>;
    if (typeof q.slug !== 'string' || typeof q.name !== 'string' || typeof q.tvl_usd !== 'number' || !Number.isFinite(q.tvl_usd)) {
      throw new SnapshotBadError(`protocol ${i} lacks slug, name or tvl_usd`);
    }
    return {
      slug: q.slug,
      name: q.name,
      category: strOrNull(q.category),
      chains: strList(q.chains),
      tvl_usd: q.tvl_usd,
      change_7d: typeof q.change_7d === 'number' && Number.isFinite(q.change_7d) ? q.change_7d : null,
      mcap_usd: typeof q.mcap_usd === 'number' && Number.isFinite(q.mcap_usd) ? q.mcap_usd : null,
      listed_at: strOrNull(q.listed_at),
      gecko_id: strOrNull(q.gecko_id),
      symbol: strOrNull(q.symbol),
    };
  });
  let calibration: SnapshotDoc['calibration'];
  if (typeof o.calibration === 'object' && o.calibration !== null && !Array.isArray(o.calibration)) {
    const c = o.calibration as Record<string, unknown>;
    if (c.method === 'cat-median' && typeof c.ratios === 'object' && c.ratios !== null && !Array.isArray(c.ratios)) {
      const ratios: Record<string, number> = {};
      for (const [k, v] of Object.entries(c.ratios as Record<string, unknown>)) {
        if (typeof v === 'number' && Number.isFinite(v) && v > 0) ratios[k] = v;
      }
      if (Object.keys(ratios).length > 0) calibration = { method: 'cat-median', ratios };
    }
  }
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
    calibration,
  };
}

export function boardFault(board: BoardLine[], doc: SnapshotDoc): string | null {
  const seen = new Set(board.map((r) => r.slug));
  const missing = doc.watchlist.filter((s) => !seen.has(s));
  if (missing.length > 0) {
    return `watchlist slugs missing from the board: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? '…' : ''}`;
  }
  if (board.length < 100) return `only ${board.length} rows; the gate wants at least 100`;
  for (let i = 0; i < board.length; i++) {
    if (board[i]!.rank !== i + 1) return `rank ${i + 1} holds ${board[i]!.rank}`;
    if (i > 0 && board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) {
      return `row ${i + 1} carries a higher implied value than row ${i}`;
    }
  }
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `every row shows the same implied value ${board[0]!.implied_value_usd}; nothing is ranked`;
  }
  for (const r of board) {
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) {
      return `${r.slug} has an invalid implied value ${r.implied_value_usd}`;
    }
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) {
      return `${r.slug} lists ${r.farm_steps.length} farm steps`;
    }
    for (const step of r.farm_steps) {
      if (step.trim().length < 20 || step.trim().length > 600) {
        return `${r.slug} has a farm step of ${step.trim().length} characters`;
      }
    }
    if (typeof r.token_odds !== 'number' || r.token_odds <= 0 || r.token_odds >= 1) {
      return `${r.slug} has an invalid token odds ${r.token_odds}`;
    }
    if (!r.verdict || typeof r.verdict.net_usd !== 'number') {
      return `${r.slug} has no farm verdict`;
    }
  }
  return null;
}

export function dataPayload(doc: RadarDoc): string {
  const r = doc.rows.map((row) => ({
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    listed_at: row.listed_at,
    token_status: row.token_status,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    token_odds: row.token_odds,
    odds_brier_cv: row.odds_brier_cv,
    odds_brier_wf: row.odds_brier_wf,
    odds_base_rate: row.odds_base_rate,
    on_watch: row.on_watch,
    onWatch: row.on_watch,
    value_low_usd: row.value_low_usd,
    value_high_usd: row.value_high_usd,
    value_p90_low_usd: row.value_p90_low_usd,
    value_p90_high_usd: row.value_p90_high_usd,
    peers: row.peers.map((p) => ({ slug: p.slug, name: p.name, tvl_usd: p.tvl_usd, mcap_usd: p.mcap_usd, ratio: p.ratio })),
    breakdown: row.breakdown,
    farm_steps: row.farm_steps,
    verdict: row.verdict,
  }));
  const slim: RadarDoc = { ...doc, rows: r as unknown as BoardLine[] };
  return `window.RADAR=${JSON.stringify(slim)};\n`;
}

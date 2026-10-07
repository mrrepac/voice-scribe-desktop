// Diagnostic: run speaker diarization on a real file with several configs and
// score clusters against a pitch-based male/female pseudo-reference.
// Usage: node scripts/diarize-probe.mjs <audio> [--emb a.onnx,b.onnx] [--thr 0.3,0.5,0.7] [--clusters 2] [--threads 8] [--duration 180]
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const ffmpeg = require('ffmpeg-static');
const { OfflineSpeakerDiarization } = require('sherpa-onnx-node');

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : fallback; };
const file = args[0];
if (!file) { console.error('usage: node scripts/diarize-probe.mjs <audio> [--emb ...] [--thr ...] [--clusters N]'); process.exit(1); }
const models = path.join(process.env.APPDATA ?? '', 'Voice Scribe', 'models', 'speakers');
const embeddings = opt('emb', path.join(models, 'embedding.onnx')).split(',');
const thresholds = opt('thr', '0.5').split(',').map(Number);
const clusters = Number(opt('clusters', '-1'));
const threads = Number(opt('threads', String(Math.max(2, Math.floor(os.availableParallelism() / 2)))));

function decode(source) {
  return new Promise((resolve, reject) => {
    const limit = opt('duration') ? ['-t', opt('duration')] : [];
    const child = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', source, ...limit,'-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-f', 'f32le', '-'], { stdio: ['ignore', 'pipe', 'inherit'] });
    const parts = [];
    child.stdout.on('data', d => parts.push(d));
    child.on('error', reject);
    child.on('close', code => {
      if (code) return reject(new Error('ffmpeg ' + code));
      const buf = Buffer.concat(parts);
      resolve(new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4));
    });
  });
}

// Median F0 of a time span: 8 kHz autocorrelation, voiced frames only.
function pitch(pcm, start, end) {
  const from = Math.floor(start * 16000), to = Math.min(pcm.length, Math.floor(end * 16000));
  const win = 256, hop = 400; // 32 ms window at 8 kHz, 50 ms hop at 16 kHz
  const f0 = [];
  const x = new Float32Array(win);
  for (let p = from; p + win * 2 < to; p += hop) {
    let energy = 0;
    for (let i = 0; i < win; i++) { const v = (pcm[p + 2 * i] + pcm[p + 2 * i + 1]) / 2; x[i] = v; energy += v * v; }
    if (energy / win < 1e-5) continue;
    let best = 0, lag = 0;
    for (let l = 20; l <= 133; l++) { // 400..60 Hz
      let s = 0, a = 0, b = 0;
      for (let i = 0; i + l < win; i++) { s += x[i] * x[i + l]; a += x[i] * x[i]; b += x[i + l] * x[i + l]; }
      const r = s / Math.sqrt(a * b + 1e-12);
      if (r > best) { best = r; lag = l; }
    }
    if (best > 0.6) f0.push(8000 / lag);
  }
  if (f0.length < 3) return null;
  f0.sort((a, b) => a - b);
  return f0[f0.length >> 1];
}

const fmt = s => `${String(Math.floor(s / 60)).padStart(2, '0')}:${(s % 60).toFixed(1).padStart(4, '0')}`;

function score(pcm, turns) {
  const perSpeaker = new Map();
  let labelled = 0, pure = 0;
  const classes = { M: new Map(), F: new Map() };
  for (const t of turns) {
    const d = t.end - t.start;
    const s = perSpeaker.get(t.speaker) ?? { dur: 0, M: 0, F: 0, n: 0, f0: [] };
    s.dur += d; s.n++;
    const f = pitch(pcm, t.start, t.end);
    if (f) {
      const c = f < 165 ? 'M' : 'F';
      s[c] += d; s.f0.push(f);
      classes[c].set(t.speaker, (classes[c].get(t.speaker) ?? 0) + d);
    }
    perSpeaker.set(t.speaker, s);
  }
  for (const s of perSpeaker.values()) { labelled += s.M + s.F; pure += Math.max(s.M, s.F); }
  // Inverse purity: how much of each voice class stays within its main cluster.
  let covered = 0, classTotal = 0;
  for (const m of Object.values(classes)) { const v = [...m.values()]; classTotal += v.reduce((a, b) => a + b, 0); covered += v.length ? Math.max(...v) : 0; }
  return { perSpeaker, purity: labelled ? pure / labelled : 0, coverage: classTotal ? covered / classTotal : 0 };
}

// Per-second pseudo-reference: clear male (<155 Hz) or female (>180 Hz) voice only.
function grid(pcm) {
  const cells = [];
  for (let t = 0; t + 1 <= pcm.length / 16000; t++) {
    const f = pitch(pcm, t, t + 1);
    cells.push(!f || f < 75 ? null : f < 155 ? 'M' : f > 180 ? 'F' : null);
  }
  return cells;
}

// Accuracy of the best one-to-one mapping between the two largest clusters and M/F.
function gridScore(cells, turns) {
  const table = new Map();
  let total = 0, missed = 0;
  cells.forEach((c, t) => {
    if (!c) return;
    total++;
    let best = null, overlap = 0;
    for (const turn of turns) {
      const o = Math.min(t + 1, turn.end) - Math.max(t, turn.start);
      if (o > overlap) { overlap = o; best = turn.speaker; }
    }
    if (best === null) { missed++; return; }
    const row = table.get(best) ?? { M: 0, F: 0 };
    row[c]++; table.set(best, row);
  });
  const rows = [...table.values()];
  let mapped = 0;
  for (const [a, b] of rows.flatMap((r, i) => rows.map((s, j) => [i, j])).filter(([i, j]) => i !== j)) mapped = Math.max(mapped, rows[a].M + rows[b].F);
  if (rows.length === 1) mapped = Math.max(rows[0].M, rows[0].F);
  return { accuracy: total ? mapped / total : 0, missed: total ? missed / total : 0, table };
}

const pcm = await decode(file);
const cells = grid(pcm);
console.log(`reference seconds: male ${cells.filter(c => c === 'M').length}, female ${cells.filter(c => c === 'F').length}`);
console.log(`file: ${path.basename(file)} · ${fmt(pcm.length / 16000)} · threads ${threads}`);
const segmentation = path.join(models, 'segmentation.onnx');
for (const emb of embeddings) {
  for (const threshold of thresholds) {
    const engine = new OfflineSpeakerDiarization({
      segmentation: { pyannote: { model: segmentation }, numThreads: threads, provider: 'cpu' },
      embedding: { model: emb, numThreads: threads, provider: 'cpu' },
      clustering: { numClusters: clusters, threshold },
      minDurationOn: 0.2, minDurationOff: 0.5,
    });
    const t0 = Date.now();
    const turns = engine.process(pcm);
    const secs = (Date.now() - t0) / 1000;
    const { perSpeaker, purity, coverage } = score(pcm, turns);
    console.log(`\n== ${path.basename(emb)} · threshold ${threshold} · clusters ${clusters} · ${secs.toFixed(1)} s`);
    const g = gridScore(cells, turns);
    console.log(`speakers ${perSpeaker.size} · turns ${turns.length} · ACCURACY ${(g.accuracy * 100).toFixed(1)}% · unassigned ${(g.missed * 100).toFixed(1)}% · turn purity ${(purity * 100).toFixed(1)}% · coverage ${(coverage * 100).toFixed(1)}%`);
    console.log('  per-second table: ' + [...g.table].map(([s, r]) => `spk ${s} M${r.M}/F${r.F}`).join(', '));
    for (const [id, s] of [...perSpeaker].sort((a, b) => b[1].dur - a[1].dur)) {
      const f0 = s.f0.sort((a, b) => a - b)[s.f0.length >> 1];
      console.log(`  speaker ${id}: ${fmt(s.dur)} in ${s.n} turns · median F0 ${f0 ? Math.round(f0) + ' Hz' : '—'} · male ${fmt(s.M)} / female ${fmt(s.F)}`);
    }
    if (args.includes('--timeline')) for (const t of turns.slice(0, 80)) console.log(`    ${fmt(t.start)}–${fmt(t.end)} spk ${t.speaker} F0 ${Math.round(pitch(pcm, t.start, t.end) ?? 0)}`);
  }
}

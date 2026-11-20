/* bakudance 効果音 — Web Audio API で合成する (外部ファイル不要) */

let ctx = null;
let muted = false;
try {
  muted = localStorage.getItem('bakudance-muted') === '1';
} catch {
  // プライベートモード等では無視
}

function ac() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

/** 初回タップで音声を有効化する (ブラウザの自動再生制限のため) */
export function unlockAudio() {
  ac();
}

export function isMuted() {
  return muted;
}

export function toggleMuted() {
  muted = !muted;
  try {
    localStorage.setItem('bakudance-muted', muted ? '1' : '0');
  } catch {}
  return muted;
}

/** 短い音 (サイン波などのオシレーター) */
function tone({ type = 'sine', from = 440, to = null, dur = 0.1, vol = 0.2, delay = 0 }) {
  const c = ac();
  if (!c) return;
  const t0 = c.currentTime + delay;
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(from, t0);
  if (to) o.frequency.exponentialRampToValueAtTime(Math.max(1, to), t0 + dur);
  g.gain.setValueAtTime(vol, t0);
  g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
  o.connect(g).connect(c.destination);
  o.start(t0);
  o.stop(t0 + dur + 0.02);
}

/** ノイズ (爆発用)。音量はフェードアウトしながら低音へ絞る */
function noise({ dur = 0.4, vol = 0.4, delay = 0, freq = 1200 }) {
  const c = ac();
  if (!c) return;
  const t0 = c.currentTime + delay;
  const len = Math.floor(c.sampleRate * dur);
  const buf = c.createBuffer(1, len, c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const src = c.createBufferSource();
  src.buffer = buf;
  const f = c.createBiquadFilter();
  f.type = 'lowpass';
  f.frequency.setValueAtTime(freq, t0);
  f.frequency.exponentialRampToValueAtTime(80, t0 + dur);
  const g = c.createGain();
  g.gain.setValueAtTime(vol, t0);
  g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
  src.connect(f).connect(g).connect(c.destination);
  src.start(t0);
}

export function playSfx(name) {
  if (muted || document.hidden) return;
  try {
    switch (name) {
      case 'click': // ボタンのタップ
        tone({ type: 'square', from: 700, dur: 0.05, vol: 0.08 });
        break;
      case 'pop': // 誰かが参加
        tone({ from: 500, to: 900, dur: 0.09, vol: 0.15 });
        break;
      case 'pass': // 爆弾が誰かに渡った
        tone({ type: 'triangle', from: 650, to: 1100, dur: 0.09, vol: 0.18 });
        break;
      case 'receive': // 爆弾が自分に来た (2音で知らせる)
        tone({ from: 880, dur: 0.07, vol: 0.2 });
        tone({ from: 660, dur: 0.09, vol: 0.2, delay: 0.07 });
        break;
      case 'tick': // 爆弾が熱くなった (緊張が高まる合図)
        tone({ type: 'square', from: 1200, dur: 0.03, vol: 0.06 });
        break;
      case 'explosion':
        noise({ dur: 0.5, vol: 0.5, freq: 1200 });
        tone({ from: 160, to: 35, dur: 0.5, vol: 0.5 });
        break;
      case 'start': // ゲーム開始
        [523, 659, 784].forEach((f, i) => tone({ from: f, dur: 0.1, vol: 0.18, delay: i * 0.09 }));
        break;
      case 'win':
        [523, 659, 784, 1047].forEach((f, i) => tone({ from: f, dur: 0.14, vol: 0.2, delay: i * 0.11 }));
        break;
      case 'lose':
        [400, 300, 200].forEach((f, i) => tone({ from: f, dur: 0.16, vol: 0.18, delay: i * 0.13 }));
        break;
    }
  } catch {
    // 音声が使えない環境では無音のまま
  }
}

// 初回のタップ/キーで音声を有効化する
window.addEventListener('pointerdown', unlockAudio, { once: true });
window.addEventListener('keydown', unlockAudio, { once: true });

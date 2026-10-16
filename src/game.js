// 自瞄靶场 · 游戏逻辑
// 结构：画布尺寸 → 状态 → 音效 → 敌人 → 瞄准（含走位预判）→ 更新 → 绘制 → 界面 → 输入 → 主循环
(() => {
  const cv = document.getElementById('cv');
  const ctx = cv.getContext('2d');
  const stage = document.getElementById('stage');
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const css = getComputedStyle(document.documentElement);
  const C = k => css.getPropertyValue(k).trim();
  const COL = { player: C('--player'), enemy: C('--enemy'), esp: C('--esp'), lock: C('--lock'), grid: C('--grid'), fg: C('--fg'), muted: C('--muted') };

  const MODES = { off: '手动', assist: '辅助瞄准', rage: '暴力自瞄' };
  const BULLET_SPEED = 950;
  const FOV = 130;               // assist radius around the cursor, px
  const PLAYER_R = 20;

  let W = 0, H = 0, dpr = 1;
  function resize() {
    const r = stage.getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = r.width; H = r.height;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  new ResizeObserver(resize).observe(stage);
  resize();

  // ---------- state ----------
  let mode = 'rage', esp = true, sound = true;
  let running = false, paused = false;
  let S;                          // per-run state
  const records = [];
  const pointer = { x: 0, y: 0, down: false, seen: false };

  function newRun() {
    S = {
      t: 0, hp: 100, score: 0, kills: 0, shots: 0, hits: 0,
      enemies: [], bullets: [], parts: [], spawnT: 0.4, cool: 0,
      cross: { x: W / 2 + 120, y: H / 2 }, target: null, shake: 0, flash: 0,
      modesUsed: new Set([mode]), lockSpin: 0,
    };
  }

  // ---------- audio ----------
  let ac = null;
  function blip(freq, dur, type = 'square', vol = 0.04) {
    if (!sound) return;
    try {
      ac = ac || new (window.AudioContext || window.webkitAudioContext)();
      const o = ac.createOscillator(), g = ac.createGain();
      o.type = type; o.frequency.setValueAtTime(freq, ac.currentTime);
      o.frequency.exponentialRampToValueAtTime(Math.max(40, freq * 0.4), ac.currentTime + dur);
      g.gain.setValueAtTime(vol, ac.currentTime);
      g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + dur);
      o.connect(g).connect(ac.destination); o.start(); o.stop(ac.currentTime + dur);
    } catch (e) { /* audio is optional */ }
  }

  // ---------- enemies ----------
  const TYPES = {
    drone: { r: 13, hp: 1, speed: 115, amp: 30, freq: 2.4, pts: 10, dmg: 10, name: '无人机' },
    gale:  { r: 10, hp: 1, speed: 170, amp: 280, freq: 6.5, pts: 25, dmg: 10, name: '疾风' },
    heavy: { r: 22, hp: 5, speed: 70, amp: 12, freq: 1.0, pts: 60, dmg: 25, name: '重甲' },
  };
  function wave() { return 1 + Math.floor(S.t / 15); }
  function spawn() {
    const w = wave();
    const roll = Math.random();
    const type = roll < Math.min(0.45, 0.12 + w * 0.05) ? 'gale' : roll > 1 - Math.min(0.22, 0.04 + w * 0.025) ? 'heavy' : 'drone';
    const T = TYPES[type];
    const a = Math.random() * Math.PI * 2;
    const R = Math.hypot(W, H) / 2 + 40;
    S.enemies.push({
      type, x: W / 2 + Math.cos(a) * R, y: H / 2 + Math.sin(a) * R,
      r: T.r, hp: T.hp, maxHp: T.hp, speed: T.speed * (1 + w * 0.08), amp: T.amp, freq: T.freq,
      phase: Math.random() * 6.28, vx: 0, vy: 0, flash: 0, rot: Math.random() * 6.28,
    });
  }

  // ---------- aiming ----------
  function onScreen(e) { return e.x > -e.r && e.x < W + e.r && e.y > -e.r && e.y < H + e.r; }
  function enemyVel(e, x, y, t) {
    const dx = W / 2 - x, dy = H / 2 - y, d = Math.hypot(dx, dy) || 1;
    const ux = dx / d, uy = dy / d;
    const lat = Math.cos(t * e.freq + e.phase) * e.amp * Math.min(1, d / 160);
    return [ux * e.speed - uy * lat, uy * e.speed + ux * lat];
  }
  function futurePos(e, T) {
    // replay the drone's own movement rule T seconds ahead
    let x = e.x, y = e.y, t = S.t; const h = 1 / 120;
    for (let el = 0; el < T; el += h) { const st = Math.min(h, T - el); const [vx, vy] = enemyVel(e, x, y, t); x += vx * st; y += vy * st; t += st; }
    return { x, y };
  }
  function leadPoint(e) {
    // where will it be when a bullet fired now arrives? (iterated intercept)
    const px = W / 2, py = H / 2;
    let p = { x: e.x, y: e.y };
    for (let i = 0; i < 5; i++) p = futurePos(e, Math.max(0, Math.hypot(p.x - px, p.y - py) - 26) / BULLET_SPEED);
    return p;
  }
  function pickTarget() {
    let best = null, bestScore = Infinity;
    for (const e of S.enemies) {
      if (e.dead || !onScreen(e)) continue;
      let s;
      if (mode === 'assist') {
        const d = Math.hypot(e.x - pointer.x, e.y - pointer.y);
        if (d > FOV) continue;
        s = d;
      } else if (mode === 'rage') {
        if ((e.pending || 0) >= e.hp) continue;   // enough bullets already on the way
        // most dangerous first: time until it reaches the turret
        s = Math.hypot(e.x - W / 2, e.y - H / 2) / e.speed;
      } else continue;
      if (s < bestScore) { bestScore = s; best = e; }
    }
    return best;
  }

  function fire() {
    const px = W / 2, py = H / 2;
    const dx = S.cross.x - px, dy = S.cross.y - py, d = Math.hypot(dx, dy) || 1;
    const spread = mode === 'rage' ? 0 : 0.015;
    const a = Math.atan2(dy, dx) + (Math.random() - 0.5) * spread;
    const tgt = mode === 'rage' ? S.target : null;
    if (tgt) tgt.pending = (tgt.pending || 0) + 1;
    S.bullets.push({ x: px + Math.cos(a) * 26, y: py + Math.sin(a) * 26, vx: Math.cos(a) * BULLET_SPEED, vy: Math.sin(a) * BULLET_SPEED, life: 1.2, tgt });
    S.shots++; S.flash = 0.06;
    blip(mode === 'rage' ? 880 : 620, 0.05, 'square', 0.025);
  }

  function burst(x, y, color, n) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * 6.28, s = 60 + Math.random() * 260;
      S.parts.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 0.35 + Math.random() * 0.4, max: 0.75, color, sz: 1.5 + Math.random() * 3 });
    }
  }

  // ---------- update ----------
  function update(dt) {
    S.t += dt; S.cool -= dt; S.shake = Math.max(0, S.shake - dt * 30); S.flash = Math.max(0, S.flash - dt); S.lockSpin += dt * 4;

    S.spawnT -= dt;
    if (S.spawnT <= 0) {
      spawn(); if (wave() >= 2 && Math.random() < 0.5) spawn(); if (wave() >= 4 && Math.random() < 0.5) spawn();
      S.spawnT = Math.max(0.15, 0.7 - wave() * 0.07) * (0.7 + Math.random() * 0.6);
    }

    const cx = W / 2, cy = H / 2;
    for (const e of S.enemies) {
      const dx = cx - e.x, dy = cy - e.y, d = Math.hypot(dx, dy) || 1;
      const ux = dx / d, uy = dy / d;
      const lat = Math.cos(S.t * e.freq + e.phase) * e.amp * Math.min(1, d / 160);
      [e.vx, e.vy] = enemyVel(e, e.x, e.y, S.t);
      e.x += e.vx * dt; e.y += e.vy * dt; e.flash = Math.max(0, e.flash - dt); e.rot += dt * (e.type === 'gale' ? 6 : 1.2);
      if (d < PLAYER_R + e.r) {
        e.dead = true; S.hp -= TYPES[e.type].dmg; S.shake = reduceMotion ? 0 : 10;
        burst(e.x, e.y, COL.lock, 18); blip(140, 0.25, 'sawtooth', 0.06);
      }
    }

    // aim
    S.target = pickTarget();
    const k = (rate) => 1 - Math.exp(-rate * dt);
    if (mode === 'off') { S.cross.x = pointer.x; S.cross.y = pointer.y; }
    else if (mode === 'assist') {
      const goal = S.target ? leadPoint(S.target) : pointer;
      const f = k(S.target ? 9 : 30);
      S.cross.x += (goal.x - S.cross.x) * f; S.cross.y += (goal.y - S.cross.y) * f;
    } else {
      if (S.target) { const p = leadPoint(S.target); S.cross.x = p.x; S.cross.y = p.y; }
      else { const f = k(12); S.cross.x += (pointer.x - S.cross.x) * f; S.cross.y += (pointer.y - S.cross.y) * f; }
    }

    // shoot
    const auto = mode === 'rage' && S.target;
    if ((pointer.down || auto) && S.cool <= 0) { fire(); S.cool = mode === 'rage' ? 1 / 16 : 1 / 7; }

    for (const b of S.bullets) {
      b.x += b.vx * dt; b.y += b.vy * dt; b.life -= dt;
      if (b.life <= 0 || b.x < -20 || b.x > W + 20 || b.y < -20 || b.y > H + 20) { b.dead = true; if (b.tgt) b.tgt.pending--; continue; }
      for (const e of S.enemies) {
        if (e.dead) continue;
        if (Math.hypot(e.x - b.x, e.y - b.y) < e.r + 3) {
          b.dead = true; S.hits++; e.hp--; e.flash = 0.08; if (b.tgt) b.tgt.pending--;
          burst(b.x, b.y, COL.esp, 3);
          if (e.hp <= 0) {
            e.dead = true; S.kills++; S.score += TYPES[e.type].pts;
            burst(e.x, e.y, COL.enemy, e.type === 'heavy' ? 40 : 22);
            blip(e.type === 'heavy' ? 220 : 340, 0.12, 'triangle', 0.05);
          }
          break;
        }
      }
    }
    for (const p of S.parts) { p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 0.92; p.vy *= 0.92; p.life -= dt; }
    S.enemies = S.enemies.filter(e => !e.dead);
    S.bullets = S.bullets.filter(b => !b.dead);
    S.parts = S.parts.filter(p => p.life > 0);

    if (S.hp <= 0) gameOver();
  }

  // ---------- draw ----------
  function poly(x, y, r, n, rot) {
    ctx.beginPath();
    for (let i = 0; i < n; i++) { const a = rot + i * Math.PI * 2 / n; ctx[i ? 'lineTo' : 'moveTo'](x + Math.cos(a) * r, y + Math.sin(a) * r); }
    ctx.closePath();
  }
  function brackets(x, y, r, color, w = 1.5) {
    const s = r + 6, l = Math.max(5, r * 0.5);
    ctx.strokeStyle = color; ctx.lineWidth = w; ctx.beginPath();
    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      ctx.moveTo(x + sx * s, y + sy * (s - l)); ctx.lineTo(x + sx * s, y + sy * s); ctx.lineTo(x + sx * (s - l), y + sy * s);
    }
    ctx.stroke();
  }

  function draw() {
    ctx.save();
    ctx.clearRect(0, 0, W, H);
    if (S.shake) ctx.translate((Math.random() - 0.5) * S.shake, (Math.random() - 0.5) * S.shake);
    const cx = W / 2, cy = H / 2;

    // radar grid
    ctx.strokeStyle = COL.grid; ctx.lineWidth = 1;
    for (let r = 80; r < Math.hypot(W, H) / 2; r += 80) { ctx.beginPath(); ctx.arc(cx, cy, r, 0, 6.29); ctx.stroke(); }
    ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, H); ctx.moveTo(0, cy); ctx.lineTo(W, cy); ctx.stroke();

    // ESP: snap lines + boxes + labels
    if (esp) {
      ctx.font = '600 10px "JetBrains Mono", monospace'; ctx.textAlign = 'center';
      for (const e of S.enemies) {
        if (!onScreen(e)) continue;
        ctx.strokeStyle = 'rgba(255, 201, 74, 0.22)'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(e.x, e.y); ctx.stroke();
        brackets(e.x, e.y, e.r, COL.esp, 1);
        const m = Math.round(Math.hypot(e.x - cx, e.y - cy) / 10);
        ctx.fillStyle = COL.esp;
        ctx.fillText(`${TYPES[e.type].name} ${m}m`, e.x, e.y - e.r - 12);
        if (e.maxHp > 1) {
          const w = e.r * 2; ctx.fillStyle = 'rgba(255,255,255,0.15)'; ctx.fillRect(e.x - w / 2, e.y + e.r + 9, w, 3);
          ctx.fillStyle = COL.esp; ctx.fillRect(e.x - w / 2, e.y + e.r + 9, w * e.hp / e.maxHp, 3);
        }
      }
    }

    // enemies
    for (const e of S.enemies) {
      const c = e.flash > 0 ? '#ffffff' : COL.enemy;
      ctx.fillStyle = c; ctx.strokeStyle = c; ctx.lineWidth = 2;
      if (e.type === 'heavy') { poly(e.x, e.y, e.r, 6, e.rot); ctx.globalAlpha = 0.25; ctx.fill(); ctx.globalAlpha = 1; ctx.stroke(); poly(e.x, e.y, e.r * 0.45, 6, -e.rot); ctx.fill(); }
      else if (e.type === 'gale') { poly(e.x, e.y, e.r, 4, e.rot); ctx.fill(); }
      else { poly(e.x, e.y, e.r, 3, Math.atan2(e.vy, e.vx)); ctx.globalAlpha = 0.3; ctx.fill(); ctx.globalAlpha = 1; ctx.stroke(); ctx.beginPath(); ctx.arc(e.x, e.y, 3, 0, 6.29); ctx.fill(); }
    }

    // lock-on
    if (S.target) {
      const e = S.target, s = e.r + 12;
      ctx.save(); ctx.translate(e.x, e.y); ctx.rotate(mode === 'rage' ? S.lockSpin : 0);
      ctx.strokeStyle = mode === 'rage' ? COL.lock : COL.player; ctx.lineWidth = 2;
      for (let i = 0; i < 4; i++) { ctx.rotate(Math.PI / 2); ctx.beginPath(); ctx.arc(0, 0, s, -0.35, 0.35); ctx.stroke(); }
      ctx.restore();
      if (mode === 'rage') {
        ctx.strokeStyle = 'rgba(255, 46, 85, 0.55)'; ctx.setLineDash([4, 6]); ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(e.x, e.y); ctx.lineTo(S.cross.x, S.cross.y); ctx.stroke(); ctx.setLineDash([]);
      }
    }

    // bullets
    ctx.strokeStyle = mode === 'rage' ? COL.lock : COL.player; ctx.lineWidth = 2.5; ctx.lineCap = 'round';
    for (const b of S.bullets) { ctx.beginPath(); ctx.moveTo(b.x, b.y); ctx.lineTo(b.x - b.vx * 0.018, b.y - b.vy * 0.018); ctx.stroke(); }

    // particles
    for (const p of S.parts) { ctx.globalAlpha = Math.max(0, p.life / p.max); ctx.fillStyle = p.color; ctx.fillRect(p.x - p.sz / 2, p.y - p.sz / 2, p.sz, p.sz); }
    ctx.globalAlpha = 1;

    // turret
    const a = Math.atan2(S.cross.y - cy, S.cross.x - cx);
    ctx.save(); ctx.translate(cx, cy); ctx.rotate(a);
    if (S.flash > 0) { ctx.fillStyle = 'rgba(255, 220, 140, 0.9)'; ctx.beginPath(); ctx.arc(30, 0, 7, 0, 6.29); ctx.fill(); }
    ctx.fillStyle = COL.player; ctx.fillRect(4, -4, 24, 8);
    ctx.restore();
    ctx.strokeStyle = COL.player; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.arc(cx, cy, PLAYER_R, 0, 6.29); ctx.stroke();
    ctx.fillStyle = 'rgba(61, 224, 196, 0.15)'; ctx.fill();
    // hp ring
    ctx.strokeStyle = S.hp > 30 ? COL.player : COL.lock; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(cx, cy, PLAYER_R + 7, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.max(0, S.hp) / 100); ctx.stroke();

    // FOV circle (assist) / rage banner
    if (mode === 'assist' && pointer.seen) {
      ctx.strokeStyle = 'rgba(61, 224, 196, 0.35)'; ctx.setLineDash([3, 5]); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(pointer.x, pointer.y, FOV, 0, 6.29); ctx.stroke(); ctx.setLineDash([]);
    }
    if (mode === 'rage') {
      ctx.font = '400 13px "Russo One", sans-serif'; ctx.textAlign = 'left'; ctx.fillStyle = COL.lock;
      ctx.fillText(S.target ? 'RAGE · 全屏锁定 · 自动开火' : 'RAGE · 搜索目标…', 14, 24);
    }

    // crosshair
    const xc = S.cross.x, yc = S.cross.y, col = mode === 'rage' ? COL.lock : COL.fg;
    ctx.strokeStyle = col; ctx.lineWidth = 1.5; ctx.beginPath();
    ctx.moveTo(xc - 12, yc); ctx.lineTo(xc - 4, yc); ctx.moveTo(xc + 4, yc); ctx.lineTo(xc + 12, yc);
    ctx.moveTo(xc, yc - 12); ctx.lineTo(xc, yc - 4); ctx.moveTo(xc, yc + 4); ctx.lineTo(xc, yc + 12); ctx.stroke();
    // real mouse position when the aim is being pulled away from it
    if (mode !== 'off' && pointer.seen && Math.hypot(pointer.x - xc, pointer.y - yc) > 6) {
      ctx.fillStyle = COL.muted; ctx.beginPath(); ctx.arc(pointer.x, pointer.y, 2.5, 0, 6.29); ctx.fill();
    }
    ctx.restore();
  }

  // ---------- HUD ----------
  const $ = id => document.getElementById(id);
  let hudT = 0;
  function hud() {
    $('s-hp').textContent = Math.max(0, Math.ceil(S.hp));
    $('s-hp-wrap').classList.toggle('low', S.hp <= 30);
    $('s-score').textContent = S.score;
    $('s-kills').textContent = S.kills;
    $('s-acc').textContent = S.shots ? Math.round(S.hits / S.shots * 100) + '%' : '—';
    $('s-kps').textContent = (S.kills / Math.max(1, S.t)).toFixed(1);
    $('s-wave').textContent = wave();
  }

  // ---------- flow ----------
  function setMode(m) {
    mode = m;
    for (const b of document.querySelectorAll('.seg button')) b.setAttribute('aria-pressed', String(b.dataset.mode === m));
    if (S && running) S.modesUsed.add(m);
  }
  function start() {
    newRun(); running = true; paused = false;
    $('ov-start').hidden = true; $('ov-over').hidden = true; $('ov-pause').hidden = true;
    blip(520, 0.15, 'triangle', 0.05);
  }
  function gameOver() {
    running = false;
    const used = [...S.modesUsed];
    const label = used.length > 1 ? '混合' : MODES[used[0]];
    records.unshift({ label, score: S.score, kills: S.kills, acc: S.shots ? Math.round(S.hits / S.shots * 100) : 0, t: S.t });
    $('over-score').textContent = S.score;
    $('over-line').textContent = `模式：${label} · 击杀 ${S.kills} · 命中率 ${records[0].acc}% · 坚持了 ${S.t.toFixed(0)} 秒`;
    $('records').innerHTML = records.slice(0, 8).map(r =>
      `<tr><td>${r.label}</td><td>${r.score}</td><td>${r.kills}</td><td>${r.acc}%</td><td>${r.t.toFixed(0)}s</td></tr>`).join('');
    $('ov-over').hidden = false;
    blip(110, 0.6, 'sawtooth', 0.07);
    hud();
  }
  function togglePause() {
    if (!running) return;
    paused = !paused; $('ov-pause').hidden = !paused;
  }

  // ---------- input ----------
  function toLocal(ev) { const r = cv.getBoundingClientRect(); pointer.x = ev.clientX - r.left; pointer.y = ev.clientY - r.top; pointer.seen = true; }
  cv.addEventListener('pointermove', toLocal);
  cv.addEventListener('pointerdown', ev => { toLocal(ev); pointer.down = true; try { cv.setPointerCapture(ev.pointerId); } catch (e) {} });
  const up = () => { pointer.down = false; };
  cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
  window.addEventListener('blur', () => { up(); if (running && !paused) togglePause(); });
  cv.addEventListener('contextmenu', ev => ev.preventDefault());

  for (const b of document.querySelectorAll('.seg button')) b.addEventListener('click', () => { setMode(b.dataset.mode); b.blur(); });
  $('t-esp').addEventListener('change', ev => { esp = ev.target.checked; });
  $('t-sound').addEventListener('change', ev => { sound = ev.target.checked; });
  $('btn-start').addEventListener('click', start);
  $('btn-again').addEventListener('click', start);
  $('btn-resume').addEventListener('click', togglePause);
  window.addEventListener('keydown', ev => {
    if (ev.key === '1') setMode('off');
    else if (ev.key === '2') setMode('assist');
    else if (ev.key === '3') setMode('rage');
    else if (ev.key === 'e' || ev.key === 'E') { esp = !esp; $('t-esp').checked = esp; }
    else if (ev.key === ' ') { ev.preventDefault(); if (running) togglePause(); else start(); }
  });

  // ---------- loop ----------
  newRun();
  pointer.x = W / 2 + 160; pointer.y = H / 2 - 60;
  // attract mode behind the start screen: a few drones circling so the first frame isn't empty
  for (let i = 0; i < 7; i++) spawn();
  for (const e of S.enemies) { const a = Math.random() * 6.28, r = 120 + Math.random() * Math.min(W, H) * 0.3; e.x = W / 2 + Math.cos(a) * r; e.y = H / 2 + Math.sin(a) * r; }

  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.033, (now - last) / 1000); last = now;
    if (running && !paused) {
      update(dt);
      hudT -= dt; if (hudT <= 0) { hud(); hudT = 0.1; }
    } else if (!running && $('ov-over').hidden) {
      // idle preview: keep picking a target so the lock-on shows
      S.target = pickTarget() || S.enemies[0]; if (S.target) { const p = leadPoint(S.target); S.cross.x = p.x; S.cross.y = p.y; } S.lockSpin += dt * 4;
    }
    draw();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();

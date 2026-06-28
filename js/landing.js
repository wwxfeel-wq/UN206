/**
 * 时墨之境 — 一级页 Canvas 2D 半色调点阵动画
 * 参考 halftone-animation 项目核心算法：
 *   Voronoi 核心板块 + 双层高斯环 + 高斯斑点 + SDF 形态渐变
 *   入场冲击波（纯净环 → 噪声爆炸 → 分层显现）
 *   高斯悬停涟漪 + 48 点轨迹
 * 7px 超细点阵，深空冷色调（青 → 靛 → 紫）
 */

(function () {
  'use strict';

  const canvas = document.getElementById('canvas');
  const ctx = canvas.getContext('2d');
  const overlay = document.getElementById('transitionOverlay');

  // 预渲染发光精灵（替代 shadowBlur，性能提升 100x+）
  const glowSprite = document.createElement('canvas');
  glowSprite.width = 64; glowSprite.height = 64;
  {
    const gctx = glowSprite.getContext('2d');
    const grad = gctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(34, 211, 238, 1)');
    grad.addColorStop(0.25, 'rgba(129, 140, 248, 0.6)');
    grad.addColorStop(0.6, 'rgba(167, 139, 250, 0.15)');
    grad.addColorStop(1, 'rgba(167, 139, 250, 0)');
    gctx.fillStyle = grad;
    gctx.fillRect(0, 0, 64, 64);
  }

  // ===== 配置常量（改编自 halftone-animation constants.ts） =====
  const SPACING = 7;
  const DOT_MIN = 0.25, DOT_MAX = 2.2;

  // 核心
  const R_INNER = 0.22;
  const CORE_FREQ = 14.0;
  const CORE_SPEED = 0.5;
  const CORE_CONTRAST = 1.3;
  const CORE_BREATHE = 0.04;
  const CORE_GLOBE_CELL_SCALE = 0.78;
  const CORE_GLOBE_STRENGTH = 0.7;
  const CORE_GLOBE_MICRO = 0.3;
  const CORE_DRIFT_X = 0.4;
  const CORE_DRIFT_Y = -0.28;

  // 同心环
  const R_RING1 = 0.30, R_RING1_W = 0.018;
  const R_RING2 = 0.44, R_RING2_W = 0.016;

  // 高斯斑点
  const CELL_COUNT = 9;
  const CELL_SIGMA = 0.024;
  const CELL_SPAN_R = 0.42;
  const HALO_CELL_COUNT = 14;
  const HALO_CELL_SIGMA = 0.007;

  // 形态场
  const SQ_COUNT = 3;
  const SHAPES = ['square', 'circle', 'triangle'];
  const SQ_EDGE_RATIO = 0.4;

  // 轨迹
  const TRAIL_MAX = 48;
  const TRAIL_LIFE_SEC = 1.2;
  const TRAIL_SIGMA = 0.022;

  // 悬停涟漪
  const HR_SIGMA = 0.022;
  const HR_SPEED = 0.25;
  const HR_GAIN = 0.55;
  const HR_FADE = 0.9;
  const HR_LAG = 0.072;
  const HR_MAX = 36;
  const HR_SPAWN_PX = 9;
  const HR_SPAWN_SEC = 0.048;
  const HR_SECONDARY = 0.36;

  // 入场动画
  const ENTRY_SEC = 3.3;
  const ENTRY_R_EXPAND = 0.3;
  const ENTRY_R_HOLD = 0.4;
  const ENTRY_R_CONTRACT = 0.5;
  const ENTRY_R_MAX = 0.85;
  const ENTRY_BAND = 0.09;
  const ENTRY_WAVE_ONLY = 0.55;
  const ENTRY_S2_SCALE = 0.85;
  const ENTRY_SIGMA_P = 0.032;
  const ENTRY_SIGMA_S = 0.055;
  const ENTRY_RIPPLE_LAG = 0.15;
  const ENTRY_WOBBLE = 0.35;
  const ENTRY_SHARD = 1;
  const ENTRY_PEAK_P = 1.3;
  const ENTRY_PEAK_S = 0.7;

  // ===== 全局状态 =====
  let W, H, dpr, minDim, cx, cy;
  let dots = [];
  let stars = [];
  let particles = [];
  let cells = [];
  let haloCells = [];
  let squares = [];
  let trail = [];          // { x, y, born }
  let hoverRipples = [];   // { x, y, born }
  let preparedRipples = [];
  let trailSamples = [];
  let trailTwoSig2 = 0;
  let trailCullSq = 0;
  let rippleSigPx = 0;
  let perPeak = 0;
  let lastRippleX = 0, lastRippleY = 0, lastRippleTime = 0;
  let entryStartTime = 0;
  let clickRipples = [];
  let clickBoost = 0;

  const mouse = {
    x: 0, y: 0, prevX: 0, prevY: 0,
    velX: 0, velY: 0, speed: 0,
    active: false, idleTime: 0,
  };

  let isTransitioning = false;
  let zoomProgress = 0;
  let transitionClickX = 0, transitionClickY = 0;

  // ===== 工具函数 =====
  function intHash01(n) {
    const s = Math.sin(n * 12.9898) * 43758.5453;
    return s - Math.floor(s);
  }

  function dotHash(c, r) {
    const s = Math.sin(c * 12.9898 + r * 78.233) * 43758.5453;
    return s - Math.floor(s);
  }

  function noiseVal(x, y, t) {
    const wx = x + 0.32 * Math.sin(y * 3.1 + t * 0.38);
    const wy = y + 0.32 * Math.cos(x * 2.7 - t * 0.3);
    return (
      Math.sin(wx * 6.8 + t * 0.75) * 0.28 +
      Math.sin(wy * 5.0 - t * 0.62) * 0.25 +
      Math.sin((wx + wy) * 3.8 + t * 0.52) * 0.22 +
      Math.sin(Math.sqrt(wx * wx + wy * wy) * 8.5 - t * 1.05) * 0.25
    );
  }

  function easeOutCubic(t) { return 1 - (1 - t) ** 3; }
  function easeIn3(t) { return t * t * t; }
  function easeInOutCubic(t) { return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2; }
  function smoothstep(a, b, x) {
    const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  }
  function rampFn(t, w) { return t <= 0 ? 0 : Math.min(1, t / w); }

  // ===== Voronoi 板块 =====
  function coreVoronoiPlateAmp(px, py) {
    const ix = Math.floor(px);
    const iy = Math.floor(py);
    let minD = Infinity;
    let best = 0;
    for (let jy = -1; jy <= 1; jy++) {
      for (let jx = -1; jx <= 1; jx++) {
        const fcx = ix + jx;
        const fcy = iy + jy;
        const ox = (intHash01(fcx * 1271 + fcy * 311) - 0.5) * 0.92;
        const oy = (intHash01(fcx * 523 + fcy * 1009) - 0.5) * 0.92;
        const fx = fcx + 0.5 + ox;
        const fy = fcy + 0.5 + oy;
        const ddx = px - fx;
        const ddy = py - fy;
        const d = ddx * ddx + ddy * ddy;
        if (d < minD) { minD = d; best = intHash01(fcx * 719 + fcy * 997 + 13); }
      }
    }
    return best;
  }

  // ===== 入场有机扰动 =====
  function organicRadialOffset(angle, wobble) {
    return wobble * (
      0.038 * Math.sin(angle * 3 + 1.4) +
      0.024 * Math.sin(angle * 7 - 0.8) +
      0.014 * Math.sin(angle * 11 + 2.1)
    );
  }
  function organicBandScale(angle, v) {
    return 1 + v * (0.35 * Math.sin(angle * 4 + 1.7) + 0.15 * Math.sin(angle * 9 - 2.3));
  }
  function shardRadialOffset(angle, shard) {
    if (shard <= 0) return 0;
    const u = angle / (Math.PI * 2);
    const a = Math.floor(u * 19), b = Math.floor(u * 47), c = Math.floor(u * 11);
    const h = intHash01(a * 503 + b * 301 + 199) * 0.52 +
              intHash01(b * 709 + c * 977 + 51) * 0.33 +
              intHash01(a * 401 + c * 601 + 17) * 0.15;
    return shard * (h - 0.5) * 0.15;
  }
  function shardBandScale(angle, shard) {
    if (shard <= 0) return 1;
    const u = angle / (Math.PI * 2);
    const i = Math.floor(u * 17);
    return 1 + shard * 0.4 * (intHash01(i * 911 + 257) - 0.5);
  }
  function rippleBrightness(dist, revealR, sigma, peak) {
    const delta = Math.abs(dist - revealR);
    return Math.exp(-(delta * delta) / (2 * sigma * sigma)) * peak;
  }

  // ===== SDF =====
  function sdSquare(dx, dy, half) {
    const ax = Math.abs(dx), ay = Math.abs(dy);
    const qx = ax - half, qy = ay - half;
    return Math.sqrt(Math.max(qx, 0) ** 2 + Math.max(qy, 0) ** 2) + Math.min(Math.max(qx, qy), 0);
  }
  function sdCircle(dx, dy, half) { return Math.sqrt(dx * dx + dy * dy) - half; }
  function sdTriangle(px, py, half) {
    const k = Math.sqrt(3);
    let x = Math.abs(px) - half;
    let y = py + half / k;
    if (x + k * y > 0) {
      const ox = x, oy = y;
      x = (ox - k * oy) * 0.5; y = (-k * ox - oy) * 0.5;
    }
    x -= Math.max(Math.min(x, 0), -2 * half);
    return -Math.sqrt(x * x + y * y) * Math.sign(y);
  }
  function shapeSDF(shape, dx, dy, half) {
    if (shape === 'circle') return sdCircle(dx, dy, half);
    if (shape === 'triangle') return sdTriangle(dx, dy, half);
    return sdSquare(dx, dy, half);
  }

  // ===== 形态渐变阶段 =====
  function squarePhase(p, t1, t2, t3, t4) {
    if (p < t1) {
      const tt = p / t1;
      const raw = 1 + 0.28 * Math.sin(tt * Math.PI * 4) * (1 - tt) - (1 - tt) ** 3 * 1.28;
      return { scale: Math.max(0, raw), morphT: 0 };
    }
    if (p < t2) return { scale: 1, morphT: 0 };
    if (p < t3) {
      const tt = (p - t2) / (t3 - t2);
      const raw = 1 + 0.25 * Math.sin(tt * Math.PI * 3) * (1 - tt) - (1 - tt) ** 3 * 1.25;
      return { scale: 1, morphT: Math.max(0, Math.min(1, raw)) };
    }
    if (p < t4) return { scale: 1, morphT: 1 };
    const tt = (p - t4) / (1 - t4);
    return { scale: 1 - tt * tt, morphT: 1 };
  }

  // ===== 颜色函数（HSL 色阶：靛 → 青 → 白） =====
  function dotColor(amp) {
    const h = 250 - amp * 60;
    const s = 70 + amp * 30;
    const l = 12 + amp * 68;
    const a = Math.min(1, 0.05 + amp * 0.95);
    return `hsla(${h.toFixed(1)},${s.toFixed(0)}%,${l.toFixed(1)}%,${a.toFixed(3)})`;
  }
  // 预计算颜色查找表（避免每帧解析 HSL 字符串）
  const COLOR_LUT_SIZE = 24;
  const COLOR_LUT = new Array(COLOR_LUT_SIZE);
  const SIZE_LUT = new Array(COLOR_LUT_SIZE);
  for (let i = 0; i < COLOR_LUT_SIZE; i++) {
    const a = (i + 0.5) / COLOR_LUT_SIZE;
    COLOR_LUT[i] = dotColor(a);
    SIZE_LUT[i] = DOT_MIN + a * (DOT_MAX - DOT_MIN);
  }
  // 预分配渲染桶（避免每帧 GC）
  const _bucketX = new Array(COLOR_LUT_SIZE);
  const _bucketY = new Array(COLOR_LUT_SIZE);
  const _bucketLen = new Int32Array(COLOR_LUT_SIZE);
  for (let i = 0; i < COLOR_LUT_SIZE; i++) { _bucketX[i] = []; _bucketY[i] = []; }
  function trailDotColor(amp) {
    const h = 200 - amp * 20;
    const l = 45 + amp * 35;
    const a = Math.min(1, 0.15 + amp * 0.85);
    return `hsla(${h.toFixed(1)},85%,${l.toFixed(1)}%,${a.toFixed(3)})`;
  }

  // ===== Resize =====
  function resize() {
    W = window.innerWidth;
    H = window.innerHeight;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    minDim = Math.min(W, H);
    cx = W / 2; cy = H / 2;

    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);

    // 点阵
    dots = [];
    const cols = Math.ceil(W / SPACING) + 2;
    const rows = Math.ceil(H / SPACING) + 2;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        dots.push({
          x: c * SPACING - SPACING,
          y: r * SPACING - SPACING,
          hash: dotHash(c, r),
        });
      }
    }

    // 星点
    stars = [];
    const starCount = Math.floor((W * H) / 8000);
    for (let i = 0; i < starCount; i++) {
      stars.push({
        x: Math.random() * W, y: Math.random() * H,
        size: Math.random() * 1.0 + 0.3,
        twinkle: Math.random() * Math.PI * 2,
        speed: 0.3 + Math.random() * 1.0,
      });
    }

    // 漂浮粒子
    particles = [];
    const pCount = Math.floor((W * H) / 22000);
    for (let i = 0; i < pCount; i++) {
      particles.push({
        x: Math.random() * W, y: Math.random() * H,
        vx: (Math.random() - 0.5) * 0.25, vy: (Math.random() - 0.5) * 0.25,
        size: Math.random() * 1.5 + 0.4,
        alpha: Math.random() * 0.25 + 0.08,
        phase: Math.random() * Math.PI * 2,
        color: Math.random() < 0.35 ? '#22D3EE' : (Math.random() < 0.5 ? '#818CF8' : '#A78BFA'),
      });
    }

    // 高斯斑点（内层 9 个）
    const sigPxBase = CELL_SIGMA * W;
    cells = [];
    for (let i = 0; i < CELL_COUNT; i++) {
      const angle = (i / CELL_COUNT) * Math.PI * 2 + Math.random() * 0.5;
      const startR = CELL_SPAN_R * (0.35 + Math.random() * 0.5);
      const sigma = CELL_SIGMA * (0.7 + Math.random() * 0.4);
      const sigPx = sigma * W;
      cells.push({
        angle, startR, sigma, sigPx,
        progress: Math.random(),
        speed: 0.0018 + Math.random() * 0.0014,
        wobble: (Math.random() - 0.5) * 0.55,
        worldX: 0, worldY: 0, envelope: 0,
        screenX: 0, screenY: 0,
        cutoff: 6 * sigPx, cutoffSq: 0, twoSig2: 2 * sigPx * sigPx,
      });
    }

    // 外晕斑点（14 个）
    const haloSigPxBase = HALO_CELL_SIGMA * W;
    haloCells = [];
    for (let i = 0; i < HALO_CELL_COUNT; i++) {
      const angle = (i / HALO_CELL_COUNT) * Math.PI * 2 + Math.random() * 0.3;
      const sigma = HALO_CELL_SIGMA * (0.7 + Math.random() * 0.4);
      const sigPx = sigma * W;
      haloCells.push({
        angle, startR: 0.5 + Math.random() * 0.11,
        sigma, sigPx,
        progress: Math.random(),
        speed: 0.00085 + Math.random() * 0.00075,
        wobble: (Math.random() - 0.5) * 0.22,
        worldX: 0, worldY: 0, envelope: 0,
        screenX: 0, screenY: 0,
        cutoff: 6 * sigPx, cutoffSq: 0, twoSig2: 2 * sigPx * sigPx,
      });
    }

    // 形态场（黄金角分布）
    const goldenAngle = Math.PI * (3 - Math.sqrt(5));
    squares = [];
    for (let i = 0; i < SQ_COUNT; i++) {
      const a = i * goldenAngle + 0.7;
      const normR = Math.sqrt((i + 1) / (SQ_COUNT + 1));
      const r = 0.08 + 0.27 * normR;
      const shapeA = SHAPES[Math.floor(Math.random() * 3)];
      const shapeB = SHAPES.filter(s => s !== shapeA)[Math.floor(Math.random() * 2)];
      const t1 = 0.15 + Math.random() * 0.05;
      const t2 = t1 + 0.18 + Math.random() * 0.08;
      const t3 = t2 + 0.05 + Math.random() * 0.02;
      const t4 = t3 + 0.16 + Math.random() * 0.08;
      const sqHalf = minDim * 0.05;
      const sizeVar = 0.55 + Math.random() * 0.7;
      const rawSize = sqHalf * sizeVar;
      const minSize = minDim * 0.03, maxSize = minDim * 0.08;
      const targetSize = Math.max(minSize, Math.min(maxSize, rawSize));
      squares.push({
        x: 0.5 + r * Math.cos(a), y: 0.5 + r * Math.sin(a),
        shapeA, shapeB, sizeVar,
        progress: Math.random(),
        speed: 0.0015 + Math.random() * 0.001,
        targetSize,
        t1, t2, t3, t4,
        driftAmp: 0.04 + Math.random() * 0.05,
        driftFreqX: 0.18 + Math.random() * 0.2,
        driftFreqY: 0.14 + Math.random() * 0.18,
        driftPhaseX: Math.random() * Math.PI * 2,
        driftPhaseY: Math.random() * Math.PI * 2,
      });
    }

    // 悬停涟漪像素参数
    rippleSigPx = HR_SIGMA * W;
    perPeak = HR_GAIN * 0.38;

    if (!mouse.active) {
      mouse.x = cx; mouse.y = cy;
      mouse.prevX = mouse.x; mouse.prevY = mouse.y;
    }
  }

  // ===== 入场调制（per-dot，带快速裁剪） =====
  // 返回: { skip, wavefront, coreT, ring1T, ring2T, cellT, trailT, shapeT }
  function computeEntryMod(dist, angle, entry,
                            frameRingR, frameE, entryRingPhase, entryExplosionPhase) {
    if (entry >= 1) {
      return { skip: false, wavefront: 0, coreT: 1, ring1T: 1, ring2T: 1, cellT: 1, trailT: 1, shapeT: 1 };
    }

    if (entryRingPhase) {
      // 纯净环阶段
      const ringR = frameRingR;
      if (ringR <= 0) return { skip: true, wavefront: 0, coreT: 0, ring1T: 0, ring2T: 0, cellT: 0, trailT: 0, shapeT: 0 };
      const band = ENTRY_BAND;
      if (Math.abs(dist - ringR) > band) {
        return { skip: true, wavefront: 0, coreT: 0, ring1T: 0, ring2T: 0, cellT: 0, trailT: 0, shapeT: 0 };
      }
      const combined = rippleBrightness(dist, ringR, ENTRY_SIGMA_P, ENTRY_PEAK_P);
      return { skip: false, wavefront: combined, coreT: 0, ring1T: 0, ring2T: 0, cellT: 0, trailT: 0, shapeT: 0 };
    }

    // 爆炸阶段
    const e = frameE;
    // 快速裁剪：用无扰动半径预检
    const r1Base = e;
    const r2Base = Math.max(0, e - ENTRY_RIPPLE_LAG);
    const band2 = ENTRY_BAND * 1.5;
    const nearR1 = Math.abs(dist - r1Base) < band2;
    const secondaryActive = e > ENTRY_RIPPLE_LAG;
    const nearR2 = secondaryActive && Math.abs(dist - r2Base) < band2;

    if (!nearR1 && !nearR2) {
      if (e < ENTRY_WAVE_ONLY) {
        return { skip: true, wavefront: 0, coreT: 0, ring1T: 0, ring2T: 0, cellT: 0, trailT: 0, shapeT: 0 };
      }
      // 阶段 B：结构层渐入，波前外也有结构可见
      const waveFade = 1 - (e - ENTRY_WAVE_ONLY) / (1 - ENTRY_WAVE_ONLY);
      return {
        skip: false,
        wavefront: 0,
        coreT: smoothstep(0.55, 0.7, e),
        ring1T: smoothstep(0.68, 0.82, e),
        ring2T: smoothstep(0.78, 0.92, e),
        cellT: smoothstep(0.86, 1.0, e),
        trailT: smoothstep(0.8, 0.95, e),
        shapeT: smoothstep(0.9, 1.0, e),
      };
    }

    // 完整计算（带有机扰动）
    const organic = organicRadialOffset(angle, ENTRY_WOBBLE);
    const shardOff = shardRadialOffset(angle, ENTRY_SHARD);
    const radialWarp = organic + shardOff;
    const r1 = Math.max(0, e + radialWarp);
    const r2 = Math.max(0, e - ENTRY_RIPPLE_LAG + radialWarp);

    const wave1 = rippleBrightness(dist, r1, ENTRY_SIGMA_P, ENTRY_PEAK_P);
    const wave2 = secondaryActive
      ? rippleBrightness(dist, r2, ENTRY_SIGMA_S, ENTRY_PEAK_S) * rampFn(e - ENTRY_RIPPLE_LAG, 0.05)
      : 0;
    const combined = Math.max(wave1, wave2);

    if (e < ENTRY_WAVE_ONLY) {
      return { skip: false, wavefront: combined, coreT: 0, ring1T: 0, ring2T: 0, cellT: 0, trailT: 0, shapeT: 0 };
    }

    const waveFade = 1 - (e - ENTRY_WAVE_ONLY) / (1 - ENTRY_WAVE_ONLY);
    return {
      skip: false,
      wavefront: combined * waveFade * ENTRY_S2_SCALE,
      coreT: smoothstep(0.55, 0.7, e),
      ring1T: smoothstep(0.68, 0.82, e),
      ring2T: smoothstep(0.78, 0.92, e),
      cellT: smoothstep(0.86, 1.0, e),
      trailT: smoothstep(0.8, 0.95, e),
      shapeT: smoothstep(0.9, 1.0, e),
    };
  }

  // ===== 渲染 =====
  function render(now) {
    const t = now / 1000;

    // --- 预计算每帧值 ---
    const breathe = 1 + CORE_BREATHE * Math.sin(t * 1.1) * Math.cos(t * 0.7);
    const rInnerB = R_INNER * breathe;

    // 入场进度
    const entry = Math.min(1, (now - entryStartTime) / (ENTRY_SEC * 1000));
    let frameRingR = 0, frameE = 0;
    let entryRingPhase = false, entryExplosionPhase = false;
    if (entry < 1) {
      if (entry < ENTRY_R_CONTRACT) {
        entryRingPhase = true;
        if (entry <= ENTRY_R_EXPAND) {
          frameRingR = easeOutCubic(entry / ENTRY_R_EXPAND) * ENTRY_R_MAX;
        } else if (entry <= ENTRY_R_HOLD) {
          frameRingR = ENTRY_R_MAX;
        } else {
          const u = (entry - ENTRY_R_HOLD) / (ENTRY_R_CONTRACT - ENTRY_R_HOLD);
          frameRingR = ENTRY_R_MAX * (1 - easeIn3(u));
        }
      } else {
        entryExplosionPhase = true;
        frameE = (entry - ENTRY_R_CONTRACT) / (1 - ENTRY_R_CONTRACT);
      }
    }

    // 更新斑点位置
    for (const cell of cells) {
      cell.progress += cell.speed;
      if (cell.progress > 1) cell.progress -= 1;
      const ct = cell.progress * Math.PI * 2;
      const cr = cell.startR + cell.wobble * 0.05 * Math.sin(ct * 3);
      cell.worldX = 0.5 + cr * Math.cos(cell.angle + ct);
      cell.worldY = 0.5 + cr * Math.sin(cell.angle + ct);
      cell.envelope = 0.4 + 0.6 * Math.sin(ct);
      cell.screenX = cell.worldX * W;
      cell.screenY = cell.worldY * H;
      cell.cutoffSq = cell.cutoff * cell.cutoff;
    }
    for (const hc of haloCells) {
      hc.progress += hc.speed;
      if (hc.progress > 1) hc.progress -= 1;
      const ct = hc.progress * Math.PI * 2;
      const cr = hc.startR + hc.wobble * 0.05 * Math.sin(ct * 3);
      hc.worldX = 0.5 + cr * Math.cos(hc.angle + ct);
      hc.worldY = 0.5 + cr * Math.sin(hc.angle + ct);
      hc.envelope = 0.3 + 0.4 * Math.sin(ct);
      hc.screenX = hc.worldX * W;
      hc.screenY = hc.worldY * H;
      hc.cutoffSq = hc.cutoff * hc.cutoff;
    }
    for (const sq of squares) {
      sq.progress += sq.speed;
      if (sq.progress > 1) sq.progress -= 1;
    }

    // 准备悬停涟漪
    const wallNow = t;
    const speedPx = HR_SPEED * W;
    const maxRippleR = 1.25 * Math.hypot(W, H);
    preparedRipples = [];
    for (const rip of hoverRipples) {
      const age = wallNow - rip.born;
      if (age < 0) continue;
      const fade = Math.exp(-age * HR_FADE);
      if (fade < 0.002) continue;
      const r1 = Math.min(age * speedPx, maxRippleR);
      const r2 = Math.min(Math.max(0, age - HR_LAG) * speedPx, maxRippleR);
      const cullR = Math.max(r1, r2) + 6 * rippleSigPx;
      preparedRipples.push({ x: rip.x, y: rip.y, fade, r1, r2, cullSq: cullR * cullR });
    }
    // 清理过期涟漪
    hoverRipples = hoverRipples.filter(r => (wallNow - r.born) < 8);

    // 准备轨迹
    trailSamples = [];
    for (const p of trail) {
      const age = wallNow - p.born;
      if (age > TRAIL_LIFE_SEC) continue;
      const weight = 1 - age / TRAIL_LIFE_SEC;
      trailSamples.push({ x: p.x, y: p.y, weight });
    }
    const trailSigPx = TRAIL_SIGMA * W;
    trailTwoSig2 = 2 * trailSigPx * trailSigPx;
    trailCullSq = (6 * trailSigPx) ** 2;

    // --- 背景 ---
    const bgGrad = ctx.createRadialGradient(W * 0.3, H * 0.3, 0, W * 0.3, H * 0.3, Math.max(W, H) * 0.8);
    bgGrad.addColorStop(0, '#0d0d20');
    bgGrad.addColorStop(0.4, '#080814');
    bgGrad.addColorStop(1, '#040408');
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, W, H);

    const bgGrad2 = ctx.createRadialGradient(W * 0.8, H * 0.7, 0, W * 0.8, H * 0.7, Math.max(W, H) * 0.5);
    bgGrad2.addColorStop(0, 'rgba(99, 102, 241, 0.06)');
    bgGrad2.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = bgGrad2;
    ctx.fillRect(0, 0, W, H);

    // --- 星空 ---
    for (const s of stars) {
      const alpha = 0.2 + Math.sin(t * s.speed + s.twinkle) * 0.15;
      ctx.fillStyle = `rgba(180, 200, 255, ${Math.max(0.05, alpha)})`;
      ctx.fillRect(s.x, s.y, s.size, s.size);
    }

    // --- 漂浮粒子 ---
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const p of particles) {
      p.x += p.vx; p.y += p.vy;
      if (p.x < 0) p.x = W; if (p.x > W) p.x = 0;
      if (p.y < 0) p.y = H; if (p.y > H) p.y = 0;
      if (mouse.active && !isTransitioning) {
        const dx = p.x - mouse.x, dy = p.y - mouse.y;
        const dist = Math.hypot(dx, dy);
        if (dist < 100 && dist > 0.1) {
          const force = (1 - dist / 100) * 1.5;
          p.x += (dx / dist) * force; p.y += (dy / dist) * force;
        }
      }
      const breatheP = 0.5 + 0.5 * Math.sin(t + p.phase);
      ctx.globalAlpha = p.alpha * breatheP;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.restore();

    // --- 过渡阶段（不再对点阵做位移，由 CSS overlay 处理） ---
    // const transPhase = isTransitioning ? zoomProgress : 0;

    // --- 点阵渲染（fillRect 分桶，最快 Canvas 2D 策略） ---
    for (let i = 0; i < COLOR_LUT_SIZE; i++) _bucketLen[i] = 0;
    const glowingDots = [];

    for (const dot of dots) {
      let drawX = dot.x, drawY = dot.y;

      // 过渡期间不修改点阵位置（避免卡顿）

      // 归一化坐标
      const nx = (drawX - cx) / minDim;
      const ny = (drawY - cy) / minDim;
      const distNorm = Math.sqrt(nx * nx + ny * ny);
      const angle = Math.atan2(ny, nx);

      // 入场调制
      const entryMod = computeEntryMod(distNorm, angle, entry, frameRingR, frameE, entryRingPhase, entryExplosionPhase);
      if (entryMod.skip) continue;

      let amp = entryMod.wavefront;
      const coreGate = entryMod.coreT;
      const ring1Gate = entryMod.ring1T;
      const ring2Gate = entryMod.ring2T;
      const cellGate = entryMod.cellT;
      const shapeGate = entryMod.shapeT;
      const trailGate = entryMod.trailT;

      // --- 核心区域（Voronoi 板块） ---
      if (distNorm < rInnerB && coreGate > 0) {
        const sx = nx * CORE_FREQ + t * CORE_DRIFT_X;
        const sy = ny * CORE_FREQ + t * CORE_DRIFT_Y;
        const v = noiseVal(sx, sy, t * CORE_SPEED);
        const legacy01 = v * 0.5 + 0.5;
        const plate = coreVoronoiPlateAmp(sx * CORE_GLOBE_CELL_SCALE, sy * CORE_GLOBE_CELL_SCALE);
        const plateTextured = plate * (1 - CORE_GLOBE_MICRO + CORE_GLOBE_MICRO * legacy01);
        const raw = plateTextured * CORE_GLOBE_STRENGTH + legacy01 * (1 - CORE_GLOBE_STRENGTH);
        const s = raw * raw * (3 - 2 * raw);
        const contrasted = CORE_GLOBE_STRENGTH > 0.5 ? s : s * s * (3 - 2 * s);
        const edgeBreath = Math.pow(1 - distNorm / rInnerB, 0.35);
        amp += Math.min(1, Math.max(0.08, contrasted) * edgeBreath * CORE_CONTRAST) * coreGate;
      }

      // --- 环 1 ---
      if (ring1Gate > 0 && distNorm > R_RING1 - R_RING1_W && distNorm < R_RING1) {
        const p = (distNorm - (R_RING1 - R_RING1_W)) / R_RING1_W;
        const fade = Math.sin(p * Math.PI);
        const wave = Math.sin(angle * 6 + t * 1.4) * 0.3 +
                     Math.sin(angle * 10 - t * 0.9) * 0.25 +
                     Math.sin(angle * 3 + t * 0.7) * 0.25 + 0.5;
        const runnerDiff = Math.abs(((angle - t * 1.8 + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
        const runner = Math.exp(-(runnerDiff * runnerDiff) / (2 * 0.12 * 0.12));
        amp += Math.max(0, (wave + runner * 0.7) * fade) * 0.9 * ring1Gate;
      }

      // --- 环 2 ---
      if (ring2Gate > 0 && distNorm > R_RING2 - R_RING2_W && distNorm < R_RING2) {
        const p = (distNorm - (R_RING2 - R_RING2_W)) / R_RING2_W;
        const fade = Math.sin(p * Math.PI);
        const wave = Math.sin(angle * 8 - t * 1.1) * 0.28 +
                     Math.sin(angle * 14 + t * 0.8) * 0.22 +
                     Math.sin(angle * 4 - t * 0.5) * 0.25 + 0.5;
        const d2a = Math.abs(((angle - t * 1.2 + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
        const d2b = Math.abs(((angle - (-t * 0.9 + Math.PI) + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
        const runner = Math.exp(-(d2a * d2a) / (2 * 0.14 * 0.14)) * 0.6 +
                       Math.exp(-(d2b * d2b) / (2 * 0.18 * 0.18)) * 0.4;
        amp += Math.max(0, (wave + runner) * fade) * 0.8 * ring2Gate;
      }

      // --- 高斯斑点 ---
      if (cellGate > 0) {
        for (const cell of cells) {
          if (cell.envelope < 0.01) continue;
          const ddx = drawX - cell.screenX;
          const ddy = drawY - cell.screenY;
          if (Math.abs(ddx) > cell.cutoff || Math.abs(ddy) > cell.cutoff) continue;
          const d2 = ddx * ddx + ddy * ddy;
          if (d2 > cell.cutoffSq) continue;
          amp += Math.exp(-d2 / cell.twoSig2) * cell.envelope * cellGate;
        }
        // 外晕斑点
        for (const hc of haloCells) {
          if (hc.envelope < 0.01) continue;
          const ddx = drawX - hc.screenX;
          const ddy = drawY - hc.screenY;
          if (Math.abs(ddx) > hc.cutoff || Math.abs(ddy) > hc.cutoff) continue;
          const d2 = ddx * ddx + ddy * ddy;
          if (d2 > hc.cutoffSq) continue;
          amp += Math.exp(-d2 / hc.twoSig2) * hc.envelope * 0.3 * cellGate;
        }
      }

      // --- 形态场 ---
      if (shapeGate > 0) {
        for (const sq of squares) {
          const phase = squarePhase(sq.progress, sq.t1, sq.t2, sq.t3, sq.t4);
          if (phase.scale <= 0.01) continue;
          const driftX = sq.driftAmp * Math.sin(t * sq.driftFreqX + sq.driftPhaseX);
          const driftY = sq.driftAmp * Math.sin(t * sq.driftFreqY + sq.driftPhaseY);
          const sx = (sq.x + driftX) * W;
          const sy = (sq.y + driftY) * H;
          const half = sq.targetSize;
          const relX = drawX - sx, relY = drawY - sy;
          const edgeW = half * SQ_EDGE_RATIO;
          if (Math.abs(relX) > half + edgeW || Math.abs(relY) > half + edgeW) continue;
          const sdfA = shapeSDF(sq.shapeA, relX, relY, half);
          const sdfB = shapeSDF(sq.shapeB, relX, relY, half);
          const blended = sdfA * (1 - phase.morphT) + sdfB * phase.morphT;
          amp += Math.max(0, 1 - Math.abs(blended) / edgeW) * phase.scale * shapeGate * 0.7;
        }
      }

      // --- 轨迹 ---
      if (trailGate > 0 && trailSamples.length > 0) {
        for (const ts of trailSamples) {
          const tdx = drawX - ts.x, tdy = drawY - ts.y;
          const d2 = tdx * tdx + tdy * tdy;
          if (d2 > trailCullSq) continue;
          amp += Math.exp(-d2 / trailTwoSig2) * ts.weight * trailGate;
          if (amp >= 1) break;
        }
      }

      // --- 悬停涟漪 ---
      if (trailGate > 0 && preparedRipples.length > 0) {
        for (const pr of preparedRipples) {
          const ddx = drawX - pr.x, ddy = drawY - pr.y;
          const distSq = ddx * ddx + ddy * ddy;
          if (distSq > pr.cullSq) continue;
          const distPx = Math.sqrt(distSq);
          const term1 = rippleBrightness(distPx, pr.r1, rippleSigPx, perPeak);
          const term2 = rippleBrightness(distPx, pr.r2, rippleSigPx * 1.12, perPeak * HR_SECONDARY);
          amp += (term1 + term2) * pr.fade * trailGate;
          if (amp >= 1) break;
        }
      }

      // --- 基础噪声（微妙背景纹理） ---
      amp += 0.02 + 0.015 * noiseVal(dot.hash * 10, dot.hash * 10, t * 0.1);

      // 过渡期间渐隐（由 CSS overlay 处理，这里不修改）
      // amp *= (1 - transPhase);

      if (amp < 0.02) continue;
      amp = Math.min(1, amp);

      // 分桶（用 fillRect 替代 arc，大幅减少路径开销）
      const levelIdx = Math.min(COLOR_LUT_SIZE - 1, (amp * COLOR_LUT_SIZE) | 0);
      const bx = _bucketX[levelIdx], by = _bucketY[levelIdx];
      const idx = _bucketLen[levelIdx]++;
      bx[idx] = drawX; by[idx] = drawY;

      if (amp > 0.75 && glowingDots.length < 150) {
        glowingDots.push({ x: drawX, y: drawY, amp });
      }
    }

    // --- 批量渲染：每组一次 fillStyle + fillRect ---
    for (let i = 0; i < COLOR_LUT_SIZE; i++) {
      const len = _bucketLen[i];
      if (len === 0) continue;
      ctx.fillStyle = COLOR_LUT[i];
      const size = SIZE_LUT[i];
      const half = size * 0.5;
      const bx = _bucketX[i], by = _bucketY[i];
      for (let j = 0; j < len; j++) {
        ctx.fillRect(bx[j] - half, by[j] - half, size, size);
      }
    }

    // --- 发光层（预渲染精灵，替代 shadowBlur 性能杀手） ---
    if (!isTransitioning && glowingDots.length > 0) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (const d of glowingDots) {
        const size = DOT_MIN + d.amp * (DOT_MAX - DOT_MIN);
        const glowR = size * 4;
        ctx.globalAlpha = d.amp * 0.3;
        ctx.drawImage(glowSprite, d.x - glowR, d.y - glowR, glowR * 2, glowR * 2);
      }
      ctx.globalAlpha = 1;
      ctx.restore();
    }

    // --- 鼠标光晕 ---
    if (!isTransitioning && mouse.active) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const speedBoost = Math.min(1, mouse.speed / 15);
      const haloR = 140 + clickBoost * 60 + speedBoost * 40;
      const haloGrad = ctx.createRadialGradient(mouse.x, mouse.y, 0, mouse.x, mouse.y, haloR);
      haloGrad.addColorStop(0, `rgba(34, 211, 238, ${0.12 + speedBoost * 0.12})`);
      haloGrad.addColorStop(0.3, `rgba(129, 140, 248, ${0.06 + speedBoost * 0.06})`);
      haloGrad.addColorStop(0.7, `rgba(167, 139, 250, 0.03)`);
      haloGrad.addColorStop(1, 'rgba(167, 139, 250, 0)');
      ctx.fillStyle = haloGrad;
      ctx.fillRect(mouse.x - haloR, mouse.y - haloR, haloR * 2, haloR * 2);
      const coreR = 30 + speedBoost * 20;
      const coreGrad = ctx.createRadialGradient(mouse.x, mouse.y, 0, mouse.x, mouse.y, coreR);
      coreGrad.addColorStop(0, `rgba(255, 255, 255, ${0.15 + speedBoost * 0.1})`);
      coreGrad.addColorStop(1, 'rgba(34, 211, 238, 0)');
      ctx.fillStyle = coreGrad;
      ctx.fillRect(mouse.x - coreR, mouse.y - coreR, coreR * 2, coreR * 2);
      ctx.restore();

      // 方向光条纹
      if (mouse.speed > 8) {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        const dirAngle = Math.atan2(mouse.velY, mouse.velX);
        const streakLen = Math.min(300, mouse.speed * 20);
        const grad = ctx.createLinearGradient(mouse.x, mouse.y,
          mouse.x - Math.cos(dirAngle) * streakLen, mouse.y - Math.sin(dirAngle) * streakLen);
        grad.addColorStop(0, 'rgba(34, 211, 238, 0.1)');
        grad.addColorStop(1, 'rgba(34, 211, 238, 0)');
        ctx.fillStyle = grad;
        const w = 35;
        ctx.beginPath();
        ctx.moveTo(mouse.x, mouse.y - w);
        ctx.lineTo(mouse.x - Math.cos(dirAngle) * streakLen, mouse.y - w - Math.sin(dirAngle) * streakLen);
        ctx.lineTo(mouse.x - Math.cos(dirAngle) * streakLen, mouse.y + w - Math.sin(dirAngle) * streakLen);
        ctx.lineTo(mouse.x, mouse.y + w);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
    }

    // --- 悬停涟漪可视化（微妙环线） ---
    if (!isTransitioning && preparedRipples.length > 0) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (const pr of preparedRipples) {
        if (pr.fade < 0.01) continue;
        ctx.strokeStyle = `rgba(34, 211, 238, ${pr.fade * 0.06})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(pr.x, pr.y, pr.r1, 0, Math.PI * 2);
        ctx.stroke();
        if (pr.r2 > 0) {
          ctx.strokeStyle = `rgba(129, 140, 248, ${pr.fade * 0.04})`;
          ctx.beginPath();
          ctx.arc(pr.x, pr.y, pr.r2, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
      ctx.restore();
    }

    // --- 点击涟漪 ---
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let i = clickRipples.length - 1; i >= 0; i--) {
      const r = clickRipples[i];
      r.radius += 4; r.alpha *= 0.96;
      if (r.alpha < 0.01) { clickRipples.splice(i, 1); continue; }
      ctx.strokeStyle = `rgba(34, 211, 238, ${r.alpha})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(r.x, r.y, r.radius, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  // ===== 动画循环 =====
  function animate(now) {
    // 鼠标速度
    const ivx = mouse.x - mouse.prevX;
    const ivy = mouse.y - mouse.prevY;
    mouse.velX = mouse.velX * 0.85 + ivx * 0.15;
    mouse.velY = mouse.velY * 0.85 + ivy * 0.15;
    mouse.speed = Math.sqrt(mouse.velX * mouse.velX + mouse.velY * mouse.velY);
    mouse.prevX = mouse.x; mouse.prevY = mouse.y;
    mouse.idleTime = mouse.speed < 0.5 ? mouse.idleTime + 16 : 0;
    clickBoost *= 0.92;

    // 悬停涟漪生成
    if (mouse.active && !isTransitioning) {
      const dx = mouse.x - lastRippleX;
      const dy = mouse.y - lastRippleY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const dt = (now - lastRippleTime) / 1000;
      if (dist >= HR_SPAWN_PX || dt >= HR_SPAWN_SEC) {
        hoverRipples.push({ x: mouse.x, y: mouse.y, born: now / 1000 });
        if (hoverRipples.length > HR_MAX) hoverRipples.shift();
        lastRippleX = mouse.x; lastRippleY = mouse.y; lastRippleTime = now;
      }

      // 轨迹
      trail.push({ x: mouse.x, y: mouse.y, born: now / 1000 });
      while (trail.length > TRAIL_MAX) trail.shift();
      while (trail.length > 0 && (now / 1000 - trail[0].born) > TRAIL_LIFE_SEC) trail.shift();
    }

    render(now);
    requestAnimationFrame(animate);
  }

  // ===== 事件 =====
  window.addEventListener('mousemove', (e) => {
    mouse.x = e.clientX; mouse.y = e.clientY; mouse.active = true;
  });
  window.addEventListener('touchmove', (e) => {
    if (e.touches.length > 0) {
      mouse.x = e.touches[0].clientX; mouse.y = e.touches[0].clientY; mouse.active = true;
    }
  }, { passive: true });

  // 过渡（简洁版：点击 → 涟漪 → CSS 渐变覆盖 → 跳转）
  function triggerTransition(clickX, clickY) {
    if (isTransitioning) return;
    isTransitioning = true;
    // 直接激活 CSS overlay，0.8s 柔和渐变覆盖
    if (overlay) overlay.classList.add('active');
    // 1.2s 后跳转（overlay 动画 0.8s + 0.4s 停留）
    setTimeout(() => { window.location.href = 'chat.html'; }, 1200);
  }

  let clickTimer = null;
  window.addEventListener('click', (e) => {
    if (isTransitioning) return;
    clickRipples.push({ x: e.clientX, y: e.clientY, radius: 0, alpha: 0.6 });
    clickBoost = 1;
    if (clickTimer) clearTimeout(clickTimer);
    clickTimer = setTimeout(() => triggerTransition(e.clientX, e.clientY), 150);
  });
  window.addEventListener('touchend', (e) => {
    if (isTransitioning) return;
    if (e.changedTouches.length > 0) {
      const tx = e.changedTouches[0].clientX, ty = e.changedTouches[0].clientY;
      clickRipples.push({ x: tx, y: ty, radius: 0, alpha: 0.6 });
      clickBoost = 1;
      if (clickTimer) clearTimeout(clickTimer);
      clickTimer = setTimeout(() => triggerTransition(tx, ty), 300);
    }
  });

  // ===== 启动 =====
  window.addEventListener('resize', resize);
  resize();
  entryStartTime = performance.now();
  requestAnimationFrame(animate);

  window.addEventListener('load', () => {
    setTimeout(() => {
      const loader = document.getElementById('loader');
      if (loader) { loader.classList.add('hidden'); setTimeout(() => loader.remove(), 800); }
    }, 600);
  });

})();

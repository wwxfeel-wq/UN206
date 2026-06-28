/**
 * 时墨像素化动态头像
 * 12x12 像素肖像，不缩放（保持像素整齐）
 * 动画：眨眼 + 微笑 + 眼睛跟随鼠标
 */

(function () {
  'use strict';

  const C = { _: 0, HAIR: 1, SKIN: 2, EYE: 3, MOUTH: 4, COLLAR: 5 };

  const PALETTE = {
    1: '#1A1A2E', 2: '#E8D5C4', 3: '#1D1D1F', 4: '#C97B63', 5: '#2C2C2E',
  };

  // 12x12 基础肖像
  const BASE = [
    [0,0,1,1,1,1,1,1,1,1,0,0],
    [0,1,1,1,1,1,1,1,1,1,1,0],
    [1,1,2,2,2,2,2,2,2,2,1,1],
    [1,2,2,2,2,2,2,2,2,2,2,1],
    [1,2,3,3,2,2,2,2,3,3,2,1],
    [1,2,3,3,2,2,2,2,3,3,2,1],
    [1,2,2,2,2,2,2,2,2,2,2,1],
    [1,2,2,2,2,4,4,2,2,2,2,1],
    [0,1,2,2,2,2,2,2,2,2,1,0],
    [0,0,1,5,5,5,5,5,5,1,0,0],
    [0,0,0,5,5,5,5,5,5,0,0,0],
    [0,0,0,0,0,0,0,0,0,0,0,0],
  ];

  // 眼睛像素坐标（左眼 + 右眼）
  const EYE_COORDS = [
    [4,2],[4,3],[5,2],[5,3],  // 左眼
    [4,8],[4,9],[5,8],[5,9],  // 右眼
  ];

  // 嘴巴坐标
  const MOUTH_COORDS = [[7,5],[7,6]];

  // 眨眼图案
  const BLINK = BASE.map((row, i) =>
    (i === 4 || i === 5) ? row.map(c => c === C.EYE ? C.SKIN : c) : row
  );

  // ---- 核心函数：根据偏移量生成眼睛位置变化的图案 ----
  // dx, dy ∈ {-1, 0, 1}：眼睛移动方向
  function makeLookPattern(base, dx, dy) {
    if (dx === 0 && dy === 0) return base;
    // 深拷贝
    const p = base.map(r => [...r]);
    // 先清除原眼睛位置
    for (const [y, x] of EYE_COORDS) {
      if (p[y] && p[y][x] === C.EYE) p[y][x] = C.SKIN;
    }
    // 在新位置画眼睛
    for (const [y, x] of EYE_COORDS) {
      const ny = y + dy;
      const nx = x + dx;
      if (p[ny] && p[ny][nx] !== undefined && p[ny][nx] !== 0) {
        p[ny][nx] = C.EYE;
      }
    }
    return p;
  }

  // 预生成 9 个方向的图案（中心 + 8 方向）
  const lookPatterns = {};
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      lookPatterns[`${dx},${dy}`] = makeLookPattern(BASE, dx, dy);
    }
  }

  // 微笑图案（在 BASE 上加宽嘴巴）
  const SMILE = BASE.map(r => [...r]);
  SMILE[7][4] = C.MOUTH; SMILE[7][7] = C.MOUTH;

  // ---- 绘制函数 ----
  function draw(canvas, pattern, pix) {
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const rows = pattern.length;
    const cols = pattern[0].length;
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const c = pattern[y][x];
        if (c === 0) continue;
        ctx.fillStyle = PALETTE[c] || '#000';
        ctx.fillRect(x * pix, y * pix, pix, pix);
      }
    }
  }

  // ---- 鼠标追踪 ----
  let mouseX = window.innerWidth / 2;
  let mouseY = window.innerHeight / 2;
  let lookDx = 0, lookDy = 0;  // 当前方向
  let targetDx = 0, targetDy = 0;  // 目标方向（平滑过渡用）

  window.addEventListener('mousemove', (e) => {
    mouseX = e.clientX;
    mouseY = e.clientY;
  });

  // 根据鼠标位置计算眼睛方向
  function updateLookDirection() {
    const mainCanvas = document.getElementById('pixelAvatar');
    if (!mainCanvas) return;
    const rect = mainCanvas.getBoundingClientRect();
    // 头像中心点
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const dx = mouseX - cx;
    const dy = mouseY - cy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 30) {
      targetDx = 0; targetDy = 0;
      return;
    }
    // 归一化到 -1, 0, 1
    const angle = Math.atan2(dy, dx);
    targetDx = Math.round(Math.cos(angle));
    targetDy = Math.round(Math.sin(angle));
  }

  // ---- 动画状态 ----
  let frame = 0;
  let blinkStart = -1;
  let smileStart = -1;
  let nextBlink = 120 + Math.random() * 180;
  let nextSmile = 300 + Math.random() * 300;

  function getPattern() {
    // 平滑过渡眼睛方向
    lookDx += (targetDx - lookDx) * 0.15;
    lookDy += (targetDy - lookDy) * 0.15;
    const idx = Math.round(lookDx);
    const idy = Math.round(lookDy);
    const lookKey = `${idx},${idy}`;
    let base = lookPatterns[lookKey] || BASE;

    // 眨眼优先
    if (blinkStart >= 0 && frame - blinkStart < 6) {
      // 眨眼时清除眼睛
      base = base.map((row, i) =>
        (i === 4 || i === 5) ? row.map(c => c === C.EYE ? C.SKIN : c) : row
      );
    } else if (blinkStart >= 0) {
      blinkStart = -1;
      nextBlink = frame + 120 + Math.random() * 180;
    } else if (frame >= nextBlink) {
      blinkStart = frame;
    }

    // 微笑
    if (smileStart >= 0 && frame - smileStart < 60) {
      base = base.map(r => [...r]);
      // 在嘴巴位置加宽
      if (base[7]) { base[7][4] = C.MOUTH; base[7][7] = C.MOUTH; }
    } else if (smileStart >= 0) {
      smileStart = -1;
      nextSmile = frame + 300 + Math.random() * 300;
    } else if (frame >= nextSmile) {
      smileStart = frame;
    }

    return base;
  }

  // ---- Canvas 设置 ----
  const PIX = 3;
  const CANVAS_SIZE = 12 * PIX;  // 36
  const animatedCanvases = [];

  const mainCanvas = document.getElementById('pixelAvatar');
  if (mainCanvas) {
    mainCanvas.width = CANVAS_SIZE;
    mainCanvas.height = CANVAS_SIZE;
    animatedCanvases.push(mainCanvas);
  }

  window.paintPixelAvatarSmall = function (canvasEl) {
    if (!canvasEl) return;
    canvasEl.width = CANVAS_SIZE;
    canvasEl.height = CANVAS_SIZE;
    if (animatedCanvases.indexOf(canvasEl) === -1) {
      animatedCanvases.push(canvasEl);
    }
  };

  // ---- 动画循环 ----
  function loop() {
    updateLookDirection();
    const pattern = getPattern();
    for (let i = 0; i < animatedCanvases.length; i++) {
      draw(animatedCanvases[i], pattern, PIX);
    }
    frame++;
    requestAnimationFrame(loop);
  }
  loop();

})();

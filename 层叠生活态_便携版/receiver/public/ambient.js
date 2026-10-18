// 层叠生活态 · 展厅氛围层：点阵光场、点阵标题、光标、滚动显现、时钟、展厅导航。
// 纯前端视觉，不发任何请求；两张页面（/ 与 /receive）共用。
(() => {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const finePointer = matchMedia('(pointer: fine)').matches;
  const pointer = { x: -1e4, y: -1e4, active: false };
  addEventListener('pointermove', event => { pointer.x = event.clientX; pointer.y = event.clientY; pointer.active = true; }, { passive: true });
  document.addEventListener('pointerleave', () => { pointer.active = false; pointer.x = pointer.y = -1e4; });

  const SIGNAL = [229, 53, 43];
  const AMBER = [232, 196, 134];
  const PAPER = [236, 229, 214];
  const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

  // 情绪色：沿用情绪轮盘的色相走向（右黄、上橙、左粉红、下蓝、右下绿）。angle 为 0–360°，0° 指向“愉悦”。
  const HUE_STOPS = [[0, 72], [90, 36], [180, -18], [270, -148], [315, -205], [360, -288]];
  function emotionHue(angle) {
    const a = ((Number(angle) % 360) + 360) % 360;
    for (let i = 1; i < HUE_STOPS.length; i += 1) {
      const [a0, h0] = HUE_STOPS[i - 1], [a1, h1] = HUE_STOPS[i];
      if (a <= a1) return (((h0 + (h1 - h0) * (a - a0) / (a1 - a0)) % 360) + 360) % 360;
    }
    return 72;
  }
  function emotionColor(selection, alpha = 1) {
    if (!selection) return `rgba(236,229,214,${alpha})`;
    const strength = Math.min(1, Math.max(0.15, Number(selection.radius) || 0.5));
    return `hsla(${emotionHue(selection.angle).toFixed(1)}, ${Math.round(52 + strength * 34)}%, ${Math.round(70 - strength * 12)}%, ${alpha})`;
  }

  // 背景光场：方形点阵，靠近光标的点会被“照亮”，一道慢速扫描光周期性掠过。
  function startField(canvas) {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const gap = 26;
    let width = 0, height = 0, dpr = 1, running = true;
    const glow = { x: -1e4, y: -1e4 };
    function resize() {
      dpr = Math.min(2, devicePixelRatio || 1);
      width = innerWidth; height = innerHeight;
      canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (reduced) draw(0);
    }
    function draw(time) {
      ctx.clearRect(0, 0, width, height);
      glow.x += ((pointer.active ? pointer.x : width * 0.72) - glow.x) * 0.08;
      glow.y += ((pointer.active ? pointer.y : height * 0.3) - glow.y) * 0.08;
      const sweep = ((time / 14000) % 1.4 - 0.2) * (width + 400) - 200;
      const offsetY = (scrollY * 0.12) % gap;
      for (let y = gap / 2 - offsetY; y < height + gap; y += gap) {
        for (let x = gap / 2; x < width; x += gap) {
          const dx = x - glow.x, dy = y - glow.y;
          const near = Math.max(0, 1 - Math.sqrt(dx * dx + dy * dy) / 240);
          const band = Math.max(0, 1 - Math.abs(x - sweep - (y - height / 2) * 0.35) / 90);
          const wave = 0.5 + 0.5 * Math.sin(x * 0.012 + y * 0.018 + time * 0.0004);
          const level = 0.05 + wave * 0.05 + near * near * 0.75 + band * 0.18;
          const size = 1 + near * 2.2 + band * 0.6;
          ctx.fillStyle = near > 0.55 && ((x * 7 + y * 13) / gap) % 11 < 1 ? rgba(SIGNAL, level) : rgba(AMBER, level);
          ctx.fillRect(x - size / 2, y - size / 2, size, size);
        }
      }
    }
    function frame(time) { if (!running) return; draw(time); requestAnimationFrame(frame); }
    addEventListener('resize', resize);
    document.addEventListener('visibilitychange', () => {
      const visible = document.visibilityState === 'visible';
      if (visible && !running && !reduced) { running = true; requestAnimationFrame(frame); } else if (!visible) running = false;
    });
    resize();
    if (!reduced) requestAnimationFrame(frame);
  }

  // 点阵标题：把文字采样成圆点，粒子从散落状态聚合成字，光标靠近时被推开。致敬海报里的点阵字。
  function dotTitle(canvas, { text, narrowLines = null, signalChars = 2, font = '"Microsoft YaHei","PingFang SC","Noto Sans SC","Source Han Sans SC",sans-serif' } = {}) {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    let particles = [], width = 0, height = 0, step = 8, visible = true, running = false, born = performance.now();
    function build() {
      const rect = canvas.getBoundingClientRect();
      width = Math.max(1, Math.round(rect.width)); height = Math.max(1, Math.round(rect.height));
      const dpr = Math.min(2, devicePixelRatio || 1);
      canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      step = width < 520 ? 6 : width < 900 ? 6.5 : 8.5;
      const scratch = document.createElement('canvas');
      scratch.width = width; scratch.height = height;
      const sctx = scratch.getContext('2d', { willReadFrequently: true });
      // 窄屏上把标题拆成多行，字才能保持足够大。
      const lines = width < 640 && narrowLines ? narrowLines : [text];
      const longest = lines.reduce((a, b) => (b.length > a.length ? b : a), '');
      let size = Math.min(height * 0.86 / (lines.length * (lines.length > 1 ? 1.1 : 1)), width / ([...longest].length * 1.04));
      sctx.font = `900 ${size}px ${font}`;
      const total = sctx.measureText(longest).width;
      if (total > width * 0.98) { size *= width * 0.98 / total; sctx.font = `900 ${size}px ${font}`; }
      sctx.textBaseline = 'middle';
      let charIndex = 0;
      lines.forEach((line, row) => {
        let x = (width - sctx.measureText(line).width) / 2;
        const y = height / 2 + (row - (lines.length - 1) / 2) * size * 1.14 + height * 0.03 / lines.length;
        [...line].forEach(char => { sctx.fillStyle = charIndex < signalChars ? '#f00' : '#0f0'; sctx.fillText(char, x, y); x += sctx.measureText(char).width; charIndex += 1; });
      });
      const data = sctx.getImageData(0, 0, width, height).data;
      const previous = particles;
      particles = [];
      for (let py = step / 2; py < height; py += step) {
        for (let px = step / 2; px < width; px += step) {
          const i = (Math.floor(py) * width + Math.floor(px)) * 4;
          const red = data[i], green = data[i + 1];
          if (red < 110 && green < 110) continue;
          const old = previous[particles.length];
          const angle = Math.random() * Math.PI * 2, far = Math.max(width, height) * (0.4 + Math.random() * 0.6);
          particles.push({ tx: px, ty: py, x: old ? old.x : width / 2 + Math.cos(angle) * far, y: old ? old.y : height / 2 + Math.sin(angle) * far,
            vx: 0, vy: 0, signal: red > green, seed: Math.random() * 1000, delay: Math.random() * 900 });
        }
      }
      if (reduced) { particles.forEach(p => { p.x = p.tx; p.y = p.ty; }); draw(performance.now()); }
    }
    function draw(time) {
      ctx.clearRect(0, 0, width, height);
      const rect = canvas.getBoundingClientRect();
      const mx = pointer.x - rect.left, my = pointer.y - rect.top;
      const radius = 110, elapsed = time - born;
      const groups = [new Path2D(), new Path2D(), new Path2D()];
      for (const p of particles) {
        if (!reduced && elapsed > p.delay) {
          const dx = p.x - mx, dy = p.y - my, distance = Math.sqrt(dx * dx + dy * dy);
          if (distance < radius) { const force = (1 - distance / radius) * 2.4; p.vx += dx / (distance || 1) * force; p.vy += dy / (distance || 1) * force; }
          p.vx += (p.tx - p.x) * 0.045; p.vy += (p.ty - p.y) * 0.045;
          p.vx *= 0.82; p.vy *= 0.82; p.x += p.vx; p.y += p.vy;
        }
        const twinkle = reduced ? 1 : 0.78 + 0.22 * Math.sin(time * 0.002 + p.seed);
        const r = step * 0.36 * twinkle;
        const path = p.signal ? groups[0] : twinkle > 0.97 ? groups[2] : groups[1];
        path.moveTo(p.x + r, p.y); path.arc(p.x, p.y, r, 0, Math.PI * 2);
      }
      ctx.fillStyle = rgba(SIGNAL, 0.95); ctx.fill(groups[0]);
      ctx.fillStyle = rgba(AMBER, 0.9); ctx.fill(groups[1]);
      ctx.fillStyle = rgba(PAPER, 1); ctx.fill(groups[2]);
    }
    function frame(time) { if (!visible || reduced) { running = false; return; } draw(time); requestAnimationFrame(frame); }
    function wake() { if (!running && visible && !reduced) { running = true; requestAnimationFrame(frame); } }
    new IntersectionObserver(entries => { visible = entries[0].isIntersecting; wake(); }).observe(canvas);
    let timer = null;
    new ResizeObserver(() => { clearTimeout(timer); timer = setTimeout(() => { build(); wake(); }, 120); }).observe(canvas);
    const ready = document.fonts?.ready ?? Promise.resolve();
    ready.then(() => { build(); born = performance.now(); wake(); });
  }

  // 光标：一个实心点 + 一个延迟跟随的圆环；移到可交互元素上圆环放大。触屏设备不启用。
  function startCursor() {
    if (!finePointer || reduced) return;
    const cursor = document.createElement('div');
    cursor.className = 'cursor';
    cursor.innerHTML = '<i></i><b></b>';
    document.body.append(cursor);
    document.documentElement.classList.add('has-cursor');
    const [dot, ring] = cursor.children;
    const eased = { x: innerWidth / 2, y: innerHeight / 2 };
    const interactive = 'a, button, label, summary, select, [data-cursor], .frag';
    document.addEventListener('pointerover', event => {
      const target = event.target instanceof Element ? event.target : null;
      cursor.classList.toggle('is-hover', Boolean(target?.closest(interactive)));
      cursor.classList.toggle('is-frame', target?.tagName === 'IFRAME');
    });
    document.addEventListener('pointerdown', () => cursor.classList.add('is-down'));
    document.addEventListener('pointerup', () => cursor.classList.remove('is-down'));
    (function loop() {
      eased.x += (pointer.x - eased.x) * 0.18; eased.y += (pointer.y - eased.y) * 0.18;
      dot.style.transform = `translate3d(${pointer.x}px, ${pointer.y}px, 0)`;
      ring.style.transform = `translate3d(${eased.x}px, ${eased.y}px, 0)`;
      cursor.classList.toggle('is-away', !pointer.active);
      requestAnimationFrame(loop);
    })();
  }

  function startReveal() {
    const observer = new IntersectionObserver(entries => entries.forEach(entry => {
      if (entry.isIntersecting) { entry.target.classList.add('is-in'); observer.unobserve(entry.target); }
    }), { rootMargin: '0px 0px -8% 0px' });
    const watch = root => root.querySelectorAll('[data-reveal]:not(.is-in)').forEach(element => observer.observe(element));
    watch(document);
    return watch;
  }

  function startClock(element) {
    if (!element) return;
    const tick = () => { element.textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false }); };
    tick(); setInterval(tick, 1000);
  }

  // 左侧展厅导航：高亮当前所在的展厅。
  function startRail(rail) {
    if (!rail) return;
    const links = [...rail.querySelectorAll('a[href^="#"]')];
    const observer = new IntersectionObserver(entries => entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      links.forEach(link => link.classList.toggle('is-current', link.getAttribute('href') === `#${entry.target.id}`));
    }), { rootMargin: '-45% 0px -50% 0px' });
    const observe = () => links.forEach(link => { const room = document.querySelector(link.getAttribute('href')); if (room) observer.observe(room); });
    observe();
    return observe;
  }

  window.Ambient = { emotionColor, emotionHue, startField, dotTitle, startCursor, startReveal, startClock, startRail, reduced };
})();

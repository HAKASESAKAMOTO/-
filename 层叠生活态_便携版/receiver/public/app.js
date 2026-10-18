(() => {
  const state = { session: null, qrDataUrl: null, draggedId: null, ws: null, wsTimer: null, keys: {} };
  const $ = id => document.getElementById(id);
  const A = window.Ambient;
  const pad = value => String(value).padStart(2, '0');
  const statusLabels = {
    IDLE: '尚未开始', INITIALIZING: '正在启动接收器', WAITING_FOR_SCAN: '等待手机扫码', COLLECTING: '正在接收照片', DOWNLOADING: '正在下载照片', IMPORTING: '正在整理照片', IMAGES_READY: '6 张照片已就绪', ANNOTATING: '进入标注阶段', ERROR: '接收出现错误', MANUAL_FALLBACK: '人工下载模式', SESSION_CLOSED: '会话已结束'
  };
  // 只有内容真正变化时才重绘，避免轮询打断拖拽和悬停。
  const changed = (name, value) => { const key = JSON.stringify(value); if (state.keys[name] === key) return false; state.keys[name] = key; return true; };

  async function request(url, options) {
    const response = await fetch(url, { headers: { 'Content-Type': 'application/json', ...(options && options.headers) }, ...options });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error?.message || `请求失败 (${response.status})`);
    return payload.data;
  }
  function intake(session) {
    return { ...session, imageCount: session.photoCount, status: session.intakeStatus, mode: session.intakeMode,
      images: session.photos.map(photo => ({ ...photo, imageId: photo.photoId, index: photo.order + 1, originalName: photo.name })) };
  }
  const sessionUrl = () => `/api/v1/sessions/${encodeURIComponent(state.session.sessionId)}`;

  function renderQr() {
    const image = $('qrImage');
    const placeholder = $('qrPlaceholder');
    if (state.qrDataUrl) {
      image.src = state.qrDataUrl;
      image.hidden = false;
      placeholder.hidden = true;
      $('qrState').textContent = '实时二维码';
    } else {
      image.hidden = true;
      placeholder.hidden = false;
      $('qrState').textContent = state.session?.status === 'WAITING_FOR_SCAN' ? '正在准备' : '手机已连接';
    }
  }

  function render() {
    const session = state.session;
    if (!session) return;
    const images = [...(session.images || [])].sort((a, b) => a.index - b.index);
    $('progressCount').textContent = session.imageCount;
    $('progressTarget').textContent = `/${session.targetCount}`;
    $('progressHint').textContent = session.status === 'IMAGES_READY' ? '可以确认顺序并开始探索' : statusLabels[session.status] || session.status;
    $('statusText').textContent = statusLabels[session.status] || session.status;
    $('statusCode').textContent = session.status === 'MANUAL_FALLBACK' ? 'MANUAL' : session.status;
    $('statusDot').className = `status-dot ${session.status === 'ERROR' ? 'error' : session.status === 'IMAGES_READY' ? 'ready' : ''}`;
    $('connection').className = `conn ${session.status === 'ERROR' ? 'error' : 'ready'}`;
    $('connection').querySelector('span').textContent = session.mode === 'MANUAL_FALLBACK' ? '人工回退已启用' : '本地接收器在线';
    $('sessionTag').innerHTML = `Session <b>${escapeHtml(session.sessionId.slice(-6).toUpperCase())}</b>`;
    $('actionTitle').textContent = session.status === 'IMAGES_READY' ? '照片已经抵达。' : session.mode === 'MANUAL_FALLBACK' ? '请打开草船窗口下载，或从电脑导入。' : '照片会在收到后自动处理。';
    $('actionDetail').textContent = session.status === 'IMAGES_READY' ? '你可以拖动照片调整顺序，删除后再补充。' : '只有经过内容解码、去重并成功保存的照片才会计入进度。';
    $('explore').disabled = session.imageCount !== session.targetCount;
    $('folderPath').textContent = session.mode === 'MANUAL_FALLBACK' ? 'receiver/data/incoming' : 'receiver/data/downloads';
    const steps = [...$('steps').children];
    steps.forEach((step, index) => {
      const done = index === 0 || (index === 1 && session.imageCount > 0 && session.imageCount >= session.targetCount);
      const current = index === 1 && session.imageCount < session.targetCount || index === 2 && session.imageCount >= session.targetCount;
      step.className = done ? 'done' : current ? 'current' : '';
      step.querySelector('i').textContent = done ? 'DONE' : current ? 'NOW' : '—';
    });
    renderStrata(session, images);
    renderSlots(session, images);
    renderTicker(session);
    if (session.errors?.length) { $('errorLog').hidden = false; $('errorLog').textContent = session.errors.slice(0, 8).map(error => `[${error.at}] ${error.code}: ${error.message}`).join('\n'); }
    renderQr();
  }

  function renderStrata(session, images) {
    const floors = Array.from({ length: session.targetCount }, (_, index) => images[index] ? images[index].annotation?.userLabel || `片段 ${pad(index + 1)}` : null);
    if (!changed('strata', floors)) return;
    $('strata').innerHTML = floors.map((label, index) => `<div class="slab ${label ? 'is-filled' : ''}"><b>F${pad(index + 1)}</b><span>${label ? escapeHtml(label) : '空置楼层'}</span><em>${label ? 'RECEIVED' : 'VACANT'}</em></div>`).join('');
  }

  function renderSlots(session, images) {
    if (!changed('slots', [session.targetCount, images.map(image => [image.imageId, image.thumbnailUrl, image.originalName])])) return;
    const slots = $('slots'); slots.innerHTML = '';
    for (let index = 0; index < session.targetCount; index += 1) {
      const image = images[index];
      const slot = document.createElement('figure');
      slot.className = `frag ${image ? '' : 'is-empty'}`; slot.draggable = Boolean(image); slot.dataset.id = image?.imageId || '';
      slot.style.setProperty('--i', index); slot.setAttribute('data-reveal', ''); if (state.keys.slotsShown) slot.classList.add('is-in');
      slot.addEventListener('dragstart', () => { state.draggedId = image?.imageId || null; slot.classList.add('dragging'); });
      slot.addEventListener('dragend', () => { slot.classList.remove('dragging'); document.querySelectorAll('.drop-target').forEach(item => item.classList.remove('drop-target')); });
      slot.addEventListener('dragover', event => { if (state.draggedId) { event.preventDefault(); slot.classList.add('drop-target'); } });
      slot.addEventListener('dragleave', () => slot.classList.remove('drop-target'));
      slot.addEventListener('drop', async event => {
        event.preventDefault();
        slot.classList.remove('drop-target');
        if (!state.draggedId || !image || state.draggedId === image.imageId) return;
        const ids = images.map(item => item.imageId);
        const from = ids.indexOf(state.draggedId); const to = ids.indexOf(image.imageId);
        ids.splice(to, 0, ids.splice(from, 1)[0]);
        state.session = intake(await request(sessionUrl() + '/photos/order', { method: 'PUT', body: JSON.stringify({ photoIds: ids }) }));
        render();
      });
      slot.innerHTML = image
        ? `<div class="frag-media"><span class="frag-index">${pad(index + 1)}</span><span class="frag-state">READY</span><img src="${image.thumbnailUrl}" alt="${escapeHtml(image.originalName)}" draggable="false" /><button class="frag-remove" type="button" title="删除这张照片" aria-label="删除 ${escapeHtml(image.originalName)}">×</button></div><figcaption><span class="frag-label">${escapeHtml(image.annotation?.userLabel || `片段 ${pad(index + 1)}`)}</span><span class="frag-ai" title="${escapeHtml(image.originalName)}">${escapeHtml(image.originalName.slice(-28))}</span></figcaption>`
        : `<div class="frag-media"><span class="frag-index">${pad(index + 1)}</span><span class="frag-wait">等待照片<br>WAITING</span></div><figcaption><span class="frag-label" style="color:var(--faint)">尚未接收</span><span class="frag-ai">FRAGMENT ${pad(index + 1)} / ${pad(session.targetCount)}</span></figcaption>`;
      const remove = slot.querySelector('.frag-remove');
      if (remove) remove.addEventListener('click', async () => { state.session = intake(await request(sessionUrl() + `/photos/${encodeURIComponent(image.imageId)}`, { method: 'DELETE' })); render(); });
      slots.appendChild(slot);
    }
    state.keys.slotsShown = true;
    A.startReveal();
  }

  function renderTicker(session) {
    const items = [`Session <b>${escapeHtml(session.sessionId.slice(-6).toUpperCase())}</b>`, `<b>${session.imageCount}</b>/${session.targetCount} Fragments received`,
      `Mode <em>${session.mode === 'MANUAL_FALLBACK' ? 'manual' : 'auto'}</em>`, `Status ${escapeHtml(session.status)}`, '层叠生活态 · Photo intake'];
    if (!changed('ticker', items)) return;
    const run = items.map(item => `<span>${item}</span>`).join('');
    $('ticker').innerHTML = run + run;
  }

  function escapeHtml(value) { return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])); }
  async function load() { state.session = intake(await request('/api/v1/session')); render(); }
  function connect() {
    clearTimeout(state.wsTimer);
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    state.ws = new WebSocket(`${scheme}://${location.host}/api/v1/events`);
    state.ws.onmessage = event => {
      const message = JSON.parse(event.data).data;
      if (message.type === 'receiver.qr') { state.qrDataUrl = message.data?.qrDataUrl || null; renderQr(); return; }
      void load().catch(error => $('statusText').textContent = error.message);
      render();
    };
    state.ws.onclose = () => { state.wsTimer = setTimeout(connect, 1800); };
    state.ws.onerror = () => state.ws?.close();
  }

  $('explore').addEventListener('click', () => { if (state.session?.nextUrl) window.location.href = state.session.nextUrl; });
  $('focusBrowser').addEventListener('click', async () => { await request('/api/v1/intake/browser/focus', { method: 'POST' }); });
  $('restartBrowser').addEventListener('click', async () => { $('statusText').textContent = '正在打开草船网页'; await request('/api/v1/intake/browser/restart', { method: 'POST' }); await load(); });
  $('toggleMode').addEventListener('click', async () => { const mode = state.session?.mode === 'MANUAL_FALLBACK' ? 'AUTO' : 'MANUAL_FALLBACK'; state.session = intake(await request('/api/v1/intake/mode', { method: 'POST', body: JSON.stringify({ mode }) })); render(); });
  $('rescan').addEventListener('click', async () => { state.session = intake((await request(sessionUrl() + '/photos', { method: 'POST' })).session); render(); });
  $('newSession').addEventListener('click', async () => { state.session = intake(await request('/api/v1/session', { method: 'POST', body: JSON.stringify({ mode: state.session?.mode || 'AUTO' }) })); state.qrDataUrl = null; render(); });
  $('fileInput').addEventListener('change', async event => { const files = event.target.files; if (!files?.length) return; const form = new FormData(); [...files].forEach(file => form.append('files', file)); try { const response = await fetch(sessionUrl() + '/photos', { method: 'POST', body: form }); const payload = await response.json(); if (!response.ok) throw Error(payload.error?.message || '导入失败'); state.session = intake(payload.data.session); render(); } catch (error) { $('statusText').textContent = error.message; } finally { event.target.value = ''; } });

  A.startField($('field'));
  A.dotTitle($('dotTitle'), { text: '图片接收', narrowLines: ['图片', '接收'], signalChars: 2 });
  A.startCursor();
  A.startReveal();
  A.startClock($('clock'));
  A.startRail(document.querySelector('.rail'));
  void load().then(connect).catch(error => { $('statusText').textContent = error.message; });
})();

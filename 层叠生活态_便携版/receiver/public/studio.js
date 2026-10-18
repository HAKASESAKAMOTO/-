(() => {
  const $ = id => document.getElementById(id);
  const A = window.Ambient;
  const state = { session: null, production: null, own: true, scene: null, exampleIndex: -1, buildingId: null, qr: null, stream: null, timer: null, downloadUrl: null, keys: {} };
  const SVG = 'http://www.w3.org/2000/svg';
  const pad = value => String(value).padStart(2, '0');
  const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  // 只有内容真正变化时才重绘某一块，避免每 1.8 秒的轮询打断悬停和动画。
  const changed = (name, value) => { const key = JSON.stringify(value); if (state.keys[name] === key) return false; state.keys[name] = key; return true; };

  async function api(url, options = {}) {
    const response = await fetch('/api/v1' + url, options);
    const payload = await response.json();
    if (!response.ok) throw Error(payload.error?.message || '请求失败');
    return payload.data;
  }

  const selectionOf = photo => photo?.annotation?.emotion?.selection ?? null;
  const emotionWordOf = photo => photo?.annotation?.emotion?.label || selectionOf(photo)?.emotion || null;
  const aiNameOf = photo => state.production?.photos?.find(item => item.photoId === photo.photoId)?.aiName || photo?.analysis?.result?.ai_object?.name || null;
  const aiNoteOf = photo => {
    const name = aiNameOf(photo);
    if (name) return `AI 补位 <b>↳ ${escapeHtml(name)}</b>`;
    const analysed = state.production?.photos?.find(item => item.photoId === photo.photoId)?.analysis === 'ready' || photo?.analysis?.result?.status === 'no_reliable_object';
    return analysed ? 'AI 补位 · 没有找到可靠的新物体' : photo?.annotation ? 'AI 补位 · 等待识别' : '尚未标注';
  };
  const labelOf = (photo, index) => photo?.annotation?.userLabel || `片段 ${pad(index + 1)}`;
  const moodOf = photo => selectionOf(photo) ? A.emotionColor(selectionOf(photo)) : '';

  function setConnection(online, text) {
    $('connection').className = `conn ${online ? 'ready' : 'error'}`;
    $('connectionText').textContent = text;
  }

  function renderQr(data) {
    state.qr = data; syncQr();
    if (data) { $('qrImage').src = data; $('qrImage').hidden = false; $('qrPlaceholder').hidden = true; $('qrState').textContent = '实时二维码'; }
    else { $('qrImage').hidden = true; $('qrPlaceholder').hidden = false; $('qrState').textContent = '等待二维码'; }
  }

  function render() {
    const s = state.session; if (!s) return;
    syncOwnViewer();
    const revision=JSON.stringify(s.photos.map(p=>[p.photoId,p.order,p.annotation?.inputVersion]));
    if(changed('emotions',revision)&&state.own)$('buildingViewer').contentWindow?.postMessage({type:'layered-life:refresh-emotions',sessionId:s.sessionId},location.origin);
    const ready = s.annotationCount === 6 && state.production?.status === 'ready';
    $('progressCount').textContent = s.photoCount;
    $('statusCode').textContent = s.annotationCount === 6 ? (ready ? 'READY' : 'BUILDING') : s.intakeStatus;
    $('statusText').textContent = s.annotationCount === 6 ? (ready ? '你的生活大楼已经完成。' : '六张照片已标注，正在生成生活大楼。') : s.photoCount === 6 ? '照片已收到，请在下方完成情绪轮盘标注。' : '等待手机扫码上传照片';
    $('progressHint').textContent = s.annotationCount === 6 ? (ready ? '已完成' : '生成中') : '扫码上传并整理照片';
    $('statusDot').className = `status-dot ${s.intakeStatus === 'ERROR' ? 'error' : ready ? 'ready' : ''}`;
    $('sessionTag').innerHTML = `Session <b>${escapeHtml(s.sessionId.slice(-6).toUpperCase())}</b>`;
    $('emotionState').textContent = s.photoCount < 6 ? '先试试情绪轮盘，上传六张照片后记录自己的感受。' : s.annotationCount < 6 ? `已标注 ${s.annotationCount} / 6。在轮盘上拖动，为每张照片记录这一刻的感受。` : '六个瞬间都已标注，情绪轨迹已经成形。';
    renderSteps(s, ready);
    renderStrata(s);
    renderSlots(s);
    renderChart(s);
    renderProduction(s);
    renderTicker(s);
    if (s.photoCount === 6) {
      $('emotionEmpty').hidden = true; $('emotionFrame').hidden = false;
      const wheelUrl = `/emotion-wheel?sessionId=${encodeURIComponent(s.sessionId)}&embedded=1`;
      if ($('emotionFrame').getAttribute('src') !== wheelUrl) $('emotionFrame').src = wheelUrl;
    } else {
      $('emotionEmpty').hidden = true; $('emotionFrame').hidden = false;
      if ($('emotionFrame').getAttribute('src') !== '/emotion-wheel?embedded=1') $('emotionFrame').src = '/emotion-wheel?embedded=1';
    }
  }

  function renderSteps(s, ready) {
    const items = [...$('steps').children];
    const annotated = s.annotationCount === 6;
    const marks = [['done', 'DONE'], annotated ? ['done', 'DONE'] : ['current', 'NOW'], ready ? ['done', 'DONE'] : annotated ? ['current', 'NOW'] : ['', '—']];
    items.forEach((item, index) => { item.className = marks[index][0]; item.querySelector('i').textContent = marks[index][1]; });
  }

  // 六层楼板：自下而上，照片抵达即点亮，标注后带上情绪色。
  function renderStrata(s) {
    const floors = Array.from({ length: 6 }, (_, index) => { const photo = s.photos[index]; return photo ? [labelOf(photo, index), emotionWordOf(photo), moodOf(photo)] : null; });
    if (!changed('strata', floors)) return;
    $('strata').innerHTML = floors.map((floor, index) => {
      const css = floor ? `is-filled${floor[1] ? ' is-felt' : ''}` : '';
      return `<div class="slab ${css}" style="${floor?.[2] ? `--mood:${floor[2]}` : ''}"><b>F${pad(index + 1)}</b><span>${floor ? escapeHtml(floor[0]) : '空置楼层'}</span><em>${floor ? escapeHtml(floor[1] || 'RECEIVED') : 'VACANT'}</em></div>`;
    }).join('');
  }

  function renderSlots(s) {
    const items = Array.from({ length: 6 }, (_, index) => { const p = s.photos[index]; return p ? [p.photoId, p.thumbnailUrl, p.name, labelOf(p, index), emotionWordOf(p), moodOf(p), aiNoteOf(p), Boolean(p.annotation)] : null; });
    if (!changed('slots', items)) return;
    const slots = $('slots'); slots.innerHTML = '';
    items.forEach((item, index) => {
      const el = document.createElement('figure');
      el.className = `frag ${item ? (item[4] ? 'is-felt' : '') : 'is-empty'}`;
      el.dataset.idx = index; el.style.setProperty('--i', index);
      if (item?.[5]) el.style.setProperty('--mood', item[5]);
      el.setAttribute('data-reveal', ''); if (state.keys.slotsShown) el.classList.add('is-in');
      el.innerHTML = item
        ? `<div class="frag-media"><span class="frag-index">${pad(index + 1)}</span><span class="frag-state">${item[7] ? '已标注' : '待标注'}</span><img src="${item[1]}" alt="${escapeHtml(item[3])}" title="${escapeHtml(item[2])}" loading="lazy">${item[4] ? `<span class="frag-mood"><i></i>${escapeHtml(item[4])}</span>` : ''}</div>
           <figcaption><span class="frag-label">${escapeHtml(item[3])}</span><span class="frag-ai">${item[6]}</span></figcaption>`
        : `<div class="frag-media"><span class="frag-index">${pad(index + 1)}</span><span class="frag-wait">等待照片<br>WAITING</span></div><figcaption><span class="frag-label" style="color:var(--faint)">尚未接收</span><span class="frag-ai">FRAGMENT ${pad(index + 1)} / 06</span></figcaption>`;
      if (item) { el.addEventListener('pointerenter', () => link(index, true)); el.addEventListener('pointerleave', () => link(index, false)); }
      slots.append(el);
    });
    state.keys.slotsShown = true;
    A.startReveal();
  }

  // 情绪轨迹：横轴愉悦度（valence），纵轴激活度（arousal），按照片顺序连线。
  function renderChart(s) {
    const R = 100;
    const points = s.photos.map((photo, index) => {
      const emotion = photo.annotation?.emotion, selection = selectionOf(photo);
      if (!emotion || !selection) return null;
      const valence = Number(emotion.valence ?? selection.x) || 0, arousal = Number(emotion.arousal ?? selection.y) || 0;
      return { index, x: valence * R, y: -arousal * R, color: A.emotionColor(selection), word: emotionWordOf(photo), label: labelOf(photo, index), intensity: selection.intensity || '' };
    });
    if (!changed('chart', points)) return;
    const placed = points.filter(Boolean);
    $('chartCount').textContent = `${placed.length} / 6`;
    const rings = [R / 3, R * 2 / 3, R].map((r, i) => `<circle class="ring${i === 2 ? ' outer' : ''}" r="${r}"/>`).join('');
    const axes = `<line class="axis" x1="${-R - 4}" x2="${R + 4}"/><line class="axis" y1="${-R - 4}" y2="${R + 4}"/>
      <text class="axis-zh" x="${R + 8}" y="4">愉悦</text><text class="axis-label" x="${R + 8}" y="18">PLEASANT</text>
      <text class="axis-zh" x="${-R - 8}" y="4" text-anchor="end">不悦</text><text class="axis-label" x="${-R - 8}" y="18" text-anchor="end">UNPLEASANT</text>
      <text class="axis-zh" y="${-R - 22}" text-anchor="middle">激活</text><text class="axis-label" y="${-R - 9}" text-anchor="middle">AROUSED</text>
      <text class="axis-zh" y="${R + 22}" text-anchor="middle">平静</text><text class="axis-label" y="${R + 35}" text-anchor="middle">CALM</text>`;
    const trail = placed.length > 1 ? `<path class="trail" d="M${placed.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' L')}"/>` : '';
    // 标签避让：落点靠得近时把文字上下错开，并用一根细线连回落点。
    const boxes = [];
    const stars = placed.map(p => {
      const side = p.x < -R * 0.35 ? -1 : 1, lx = side * 12;
      let ly = 4;
      const hit = y => boxes.some(b => Math.abs(b.x - (p.x + lx * 3)) < 44 && Math.abs(b.y - (p.y + y)) < 15);
      for (let step = 1; hit(ly) && step < 8; step += 1) ly = 4 + (step % 2 ? 1 : -1) * Math.ceil(step / 2) * 15;
      boxes.push({ x: p.x + lx * 3, y: p.y + ly });
      const anchor = side < 0 ? 'end' : 'start';
      const leader = ly !== 4 ? `<line class="axis" x1="0" y1="0" x2="${lx * 0.8}" y2="${ly - 4}"/>` : '';
      return `<g data-idx="${p.index}" transform="translate(${p.x.toFixed(1)},${p.y.toFixed(1)})" data-cursor>
      <circle class="halo" r="15" fill="${p.color}"/>${leader}<circle class="star" r="5.5" fill="${p.color}"/>
      <text x="${lx}" y="${ly}" text-anchor="${anchor}"><tspan class="star-no">${pad(p.index + 1)}</tspan><tspan class="star-word" dx="5">${escapeHtml(p.word || '')}</tspan></text></g>`;
    }).join('');
    $('constellation').innerHTML = `<defs><linearGradient id="trailGradient" x1="0" x2="1"><stop offset="0" stop-color="#e8c486"/><stop offset="1" stop-color="#e5352b"/></linearGradient></defs>${rings}${axes}${trail}${stars}`;
    $('constellation').querySelectorAll('g[data-idx]').forEach(group => {
      const index = Number(group.dataset.idx);
      group.addEventListener('pointerenter', () => link(index, true)); group.addEventListener('pointerleave', () => link(index, false));
    });
    $('legend').innerHTML = points.map((p, index) => {
      const photo = s.photos[index];
      if (!photo) return '';
      return `<li data-idx="${index}" style="${p ? `--mood:${p.color}` : ''}"><b>${pad(index + 1)}</b><i></i><span>${escapeHtml(labelOf(photo, index))}${p?.intensity ? ` · ${escapeHtml(p.intensity)}` : ''}</span><em>${p ? escapeHtml(p.word || '') : '待标注'}</em></li>`;
    }).join('') || '<li class="chart-empty">六张照片抵达后，每个瞬间的感受会在这里落点成一条轨迹。</li>';
    $('legend').querySelectorAll('li[data-idx]').forEach(item => {
      const index = Number(item.dataset.idx);
      item.addEventListener('pointerenter', () => link(index, true)); item.addEventListener('pointerleave', () => link(index, false));
    });
  }

  function link(index, on) {
    document.querySelectorAll(`.frag[data-idx="${index}"], #constellation g[data-idx="${index}"], #legend li[data-idx="${index}"]`).forEach(element => element.classList.toggle('is-linked', on));
  }

  // 单个物件失败后跳过，其余成功模型继续入楼展示。
  function renderProduction(s) {
    const p = state.production, done = s.annotationCount === 6 && p?.status === 'ready';
    $('ownBuilding').disabled = false;
    const photos = p?.photos || [], objects = (p?.objects || []).filter(o => o.status !== 'skipped');
    const analyzed = photos.filter(x => x.analysis === 'ready').length, built = objects.filter(o => o.status === 'ready').length;
    const skipped = (p?.objects || []).filter(o => o.status === 'skipped');
    const skippedText = skipped.length ? `已跳过 ${skipped.length} 个未生成物件：${skipped.map(o => o.label).join('、')}。` : '';
    renderMachine(s, p, analyzed, built, objects.length);
    if (s.annotationCount !== 6) { $('actionTitle').textContent = '等待六张照片完成标注'; $('actionDetail').textContent = '完成所有标注后，系统会自动识别新物体并生成你的生活大楼。'; return; }
    const words = photos.filter(x => x.aiName).map(x => x.aiName);
    const wordText = words.length ? `AI 发现的新物体：${words.join('、')}。` : '';
    if (done) { $('actionTitle').textContent = skipped.length ? '你的生活大楼已可展示。' : '你的生活大楼已经完成。'; $('actionDetail').textContent = `${built} 个生活物件已放进大楼。${skippedText}${wordText}`; return; }
    if (p?.status === 'failed') { $('actionTitle').textContent = '大楼生成遇到问题'; $('actionDetail').textContent = `${p.error || '请稍后重试。'} 已完成模型 ${built} / ${objects.length}。`; return; }
    if (!p || p.status === 'idle' || p.status === 'analyzing') { $('actionTitle').textContent = `AI 正在识别照片里的新物体（${analyzed} / 6）`; $('actionDetail').textContent = wordText || '识别完成后会开始生成 3D 模型，大楼完成前按钮保持不可用。'; return; }
    $('actionTitle').textContent = p.status === 'importing' ? '正在把物件放进大楼…' : `正在生成 3D 生活物件（${built} / ${objects.length}）`;
    $('actionDetail').textContent = `${wordText}${skippedText}每个模型约需几分钟，个别失败会自动跳过，其余模型继续入楼。`;
  }

  function renderMachine(s, p, analyzed, built, total) {
    const annotated = s.annotationCount === 6;
    const photos = p?.photos || [], objects = p?.objects || [];
    const phase = !annotated ? 0 : p?.status === 'failed'
      ? (photos.some(x => x.analysis === 'failed') ? 1 : objects.some(o => o.status === 'failed') ? 2 : 3)
      : ({ idle: 1, analyzing: 1, generating: 2, importing: 3, ready: 4 })[p?.status] ?? 1;
    const stages = [
      ['stageAnalysis', `${analyzed}<small>/6</small>`, analyzed / 6],
      ['stageBuild', total ? `${built}<small>/${total}</small>` : '—', total ? built / total : 0],
      ['stagePlace', phase === 4 ? `${built}<small> 件</small>` : '—', phase === 4 ? 1 : phase === 3 ? 0.5 : 0],
    ];
    const view = stages.map(([id, value, ratio], index) => {
      const step = index + 1;
      const mode = step < phase ? 'done' : step === phase ? (p?.status === 'failed' ? 'failed' : 'running') : 'standby';
      return [id, value, Math.round((mode === 'done' ? 1 : ratio) * 24), mode];
    });
    if (changed('machine', view)) {
      for (const [id, value, lit, mode] of view) {
        const stage = $(id);
        stage.className = `stage is-${mode}`;
        stage.querySelector('.stage-state').textContent = { done: 'COMPLETE', running: 'RUNNING', failed: 'FAULT', standby: 'STANDBY' }[mode];
        stage.querySelector('.stage-value').innerHTML = value;
        stage.querySelector('.cells').innerHTML = Array.from({ length: 24 }, (_, i) => `<i class="${i < lit ? 'on' : ''}${mode === 'running' && i === lit ? ' head' : ''}"></i>`).join('');
      }
    }
    const rows = annotated ? [...objects].sort((a, b) => a.floor - b.floor || (a.source === 'user' ? -1 : 1)).map(o => [o.floor, o.source, o.label, o.status]) : [];
    if (!changed('log', rows)) return;
    const status = { pending: 'QUEUED', running: 'MODELLING', ready: 'READY', failed: 'FAULT', skipped: '已跳过' };
    $('objectLog').innerHTML = rows.length
      ? rows.map(([floor, source, label, st]) => `<li><span>F${pad(Number(floor) + 1)}</span><span class="who ${source === 'ai' ? 'ai' : ''}">${source === 'ai' ? 'AI' : 'USER'}</span><span class="what">${escapeHtml(label || '')}</span><span class="how ${st}">${status[st] || String(st).toUpperCase()}</span></li>`).join('')
      : `<li class="log-empty">${annotated ? '正在准备物件清单 · PREPARING' : '等待六张照片完成标注 · AWAITING ANNOTATIONS'}</li>`;
  }

  function renderTicker(s) {
    const p = state.production;
    const words = s.photos.map(emotionWordOf).filter(Boolean);
    const items = [`Session <b>${s.sessionId.slice(-6).toUpperCase()}</b>`, `<b>${s.photoCount}</b>/6 Fragments received`, `<b>${s.annotationCount}</b>/6 Feelings marked`,
      `Building <em>${s.annotationCount === 6 ? (p?.status || 'idle') : 'standby'}</em>`, ...(words.length ? [`情绪 · ${words.map(escapeHtml).join(' / ')}`] : []), '层叠生活态 · Layered life state'];
    if (!changed('ticker', items)) return;
    const run = items.map(item => `<span>${item}</span>`).join('');
    $('ticker').innerHTML = run + run;
  }

  let loadRevision = 0, roundBusy = false;
  function resetRound() {
    state.own=true; state.production=null; state.scene=null; state.buildingId=null; state.keys={}; state.viewerKey=null;
    $('buildingViewer').src='about:blank'; $('download').hidden=true; $('download').removeAttribute('href');
    if(state.downloadUrl)URL.revokeObjectURL(state.downloadUrl); state.downloadUrl=null;
  }
  async function load() {
    if(roundBusy)return;
    const revision=++loadRevision;
    const session=await api('/session');
    const production=session.annotationCount===6 ? await api(`/sessions/${encodeURIComponent(session.sessionId)}/production`).catch(()=>null) : null;
    if(revision!==loadRevision)return;
    if(state.session?.sessionId!==session.sessionId)resetRound();
    state.session=session;state.production=production;render();
  }
  function syncOwnViewer() {
    if(!state.own || !state.session)return;
    const ready=state.production?.sessionId===state.session.sessionId && state.production.status==='ready';
    const key=JSON.stringify([state.session.sessionId,ready,ready?state.production.objects.map(o=>[o.objectId,o.inputVersion,o.status]):[]]);
    if(state.viewerKey===key)return;state.viewerKey=key;
    $('buildingTitle').textContent='本轮生活大楼';$('buildingSection').hidden=false;$('railViewing').hidden=false;
    $('buildingViewer').src='/buildings/ecology/?api=v1&session='+encodeURIComponent(state.session.sessionId);
    $('buildingStatus').textContent=ready?'本轮物件已入楼 · 拖动旋转或连接旋转轴':'空大楼 · 等待本轮照片和物件';
    $('download').hidden=true;state.scene=null;
  }
  function connect() {
    state.stream = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/v1/events`);
    state.stream.onopen = () => setConnection(true, '本地工作台在线');
    state.stream.onmessage = event => { const msg = JSON.parse(event.data).data; if (msg.type === 'receiver.qr') renderQr(msg.data?.qrDataUrl || null); void load().catch(() => {}); };
    state.stream.onclose = () => { setConnection(false, '正在重新连接'); setTimeout(connect, 1800); };
  }
  function startPolling() { clearInterval(state.timer); state.timer = setInterval(() => void load().catch(() => {}), 1800); }

  $('focusBrowser').onclick = () => api('/intake/browser/focus', { method: 'POST' }).catch(e => alert(e.message));
  $('fileInput').onchange = async e => {
    if (!e.target.files?.length) return;
    const form = new FormData(); [...e.target.files].forEach(file => form.append('files', file));
    try { const result = await api(`/sessions/${encodeURIComponent(state.session.sessionId)}/photos`, { method: 'POST', body: form }); state.session = result.session || result; render(); }
    catch (err) { alert(err.message); }
    e.target.value = '';
  };
  $('newSession').onclick = async () => {
    if (!confirm('开始新一轮？本轮记录会保留，新一轮从空大楼开始。')) return;
    const button=$('newSession');button.disabled=true;roundBusy=true;++loadRevision;
    try {
      const session=await api('/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode:'AUTO'})});
      resetRound();state.session=session;renderQr(null);render();
    } catch(error) { $('statusText').textContent=error.message; }
    finally {roundBusy=false;button.disabled=false;}
  };
  function openViewer() { $('buildingSection').hidden = false; $('railViewing').hidden = false; requestAnimationFrame(() => $('buildingSection').scrollIntoView({ behavior: 'smooth' })); }
  $('ownBuilding').onclick = () => { state.own=true;state.viewerKey=null;syncOwnViewer();openViewer(); };
  function syncQr() { $('buildingViewer').contentWindow?.postMessage({ type: 'layered-life:qr', dataUrl: state.qr }, location.origin); }
  $('buildingViewer').addEventListener('load', () => { syncQr(); dressViewer(); });

  // 嵌入时让大楼浏览器融入展厅：隐藏它自带的页眉页脚，背景与展厅一致。只改样式，不碰它的逻辑。
  function dressViewer() {
    try {
      const doc = $('buildingViewer').contentDocument;
      if (!doc || !doc.querySelector('#poster.poster') || doc.getElementById('studio-embed')) return;
      const style = doc.createElement('style'); style.id = 'studio-embed';
      style.textContent = ':root,body{background:#040507!important}.topbar,body>footer{display:none!important}.workspace{margin:clamp(16px,4vh,40px) auto!important}';
      doc.head.append(style);
    } catch { /* 跨域或尚未加载时保持原样 */ }
  }

  // 情绪轮盘跟随内容高度伸缩，避免内嵌页里出现第二条滚动条。
  let wheelObserver = null;
  $('emotionFrame').addEventListener('load', () => {
    wheelObserver?.disconnect();
    try {
      const frame = $('emotionFrame'), doc = frame.contentDocument;
      const fit = () => { const page = doc.querySelector('.session-page') || doc.getElementById('root'); if (!page) return; const height = Math.ceil(page.getBoundingClientRect().height + 24); if (height > 200 && Math.abs(height - frame.offsetHeight) > 6) frame.style.height = `${Math.max(640, height)}px`; };
      wheelObserver = new ResizeObserver(fit); wheelObserver.observe(doc.body); fit();
    } catch { wheelObserver = null; }
  });

  function showNextExample() {
    state.own = false; state.exampleIndex = (state.exampleIndex + 1) % 2;
    state.buildingId = ['classic', 'ecology'][state.exampleIndex];
    $('buildingTitle').textContent = ['这是我的生活 · 示例楼', '层叠生活 · 灯光示例楼'][state.exampleIndex];
    $('buildingViewer').src = state.buildingId === 'classic' ? '/buildings/classic/?api=v1' : '/buildings/ecology/?api=v1';
    $('buildingStatus').textContent = '按住鼠标拖动旋转，松手停止。再次点击可查看另一款生活大楼。';
    $('download').hidden = true;
    openViewer();
  }
  $('othersBuilding').onclick = showNextExample;
  $('viewOthers').onclick = showNextExample;
  $('export').onclick = async () => {
    const button = $('export'), label = button.innerHTML;
    button.disabled = true; button.innerHTML = '正在生成海报 <span class="arrow">···</span>';
    try {
      if (state.own && state.production?.status==='ready' && !state.scene) state.scene = await api(`/sessions/${encodeURIComponent(state.session.sessionId)}/scene`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'proxy' }) });
      const own = state.own || state.buildingId === 'ecology';
      const view = $('buildingViewer').contentWindow.layeredLifeViewer?.getState();
      if (own) {
        const viewer = $('buildingViewer').contentWindow.layeredLifeViewer;
        await viewer.setQr(state.qr);
        const blob = await viewer.renderPosterBlob();
        if (state.downloadUrl) URL.revokeObjectURL(state.downloadUrl);
        state.downloadUrl = URL.createObjectURL(blob);
        $('download').href = state.downloadUrl; $('download').download = '层叠生活_当前视角.png'; $('download').hidden = false;
        return;
      }
      const job = await api('/posters', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...(state.own ? { sessionId: state.session.sessionId } : {}), buildingId: own ? 'ecology' : 'classic', generatorId: own ? 'ecology-poster' : 'classic-poster', theme: own ? 'original' : 'blue', face: 'front', view: { angleDegrees: view?.angleDegrees || 0, zoom: view?.zoom || 1 } }) });
      let result;
      do { await new Promise(r => setTimeout(r, 900)); result = await api('/posters/' + job.jobId); } while (!['ready', 'failed'].includes(result.status));
      if (result.status === 'failed') throw Error(result.error?.message || '海报生成失败');
      $('download').href = result.downloadUrl; $('download').hidden = false;
    } catch (e) { $('buildingStatus').textContent = e.message; }
    finally { button.disabled = false; button.innerHTML = label; }
  };

  A.startField($('field'));
  A.dotTitle($('dotTitle'), { text: '层叠生活态', narrowLines: ['层叠', '生活态'], signalChars: 2 });
  A.startCursor();
  A.startReveal();
  A.startClock($('clock'));
  const refreshRail = A.startRail(document.querySelector('.rail'));
  new MutationObserver(() => refreshRail?.()).observe($('buildingSection'), { attributes: true, attributeFilter: ['hidden'] });

  load().then(() => { connect(); startPolling(); }).catch(e => { $('statusText').textContent = e.message; setConnection(false, '本地工作台未响应'); });
})();

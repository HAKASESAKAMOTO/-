// Match the compact, non-modal emotion card in 建筑旋转海报.html.
export function createEmotionDialog({ onClose, onOpen }) {
  const dialog = document.createElement('dialog');
  dialog.id = 'emotion-dialog';
  dialog.setAttribute('aria-modal', 'false');
  dialog.setAttribute('aria-labelledby', 'emotion-dialog-title');
  dialog.innerHTML = `<button type="button" class="card-close" aria-label="关闭情绪信息">×</button>
    <p class="card-object"></p><h2 class="card-emotion" id="emotion-dialog-title"></h2>
    <div class="card-separator" aria-hidden="true"></div><p class="card-feature-label">照片中的客观特征</p>
    <ul class="card-features"></ul><p class="card-note"></p>`;
  document.body.append(dialog);
  let selected = null, anchor = null;
  const query = selector => dialog.querySelector(selector);
  function close(restoreFocus = true) {
    if (!dialog.open) return;
    const id = selected; selected = null; dialog.close();
    onClose?.(id, restoreFocus);
  }
  query('.card-close').onclick = () => close();
  document.addEventListener('keydown', event => {
    if (dialog.open && event.key === 'Escape') { event.preventDefault(); close(); }
  });
  document.addEventListener('pointerdown', event => {
    if (dialog.open && !dialog.contains(event.target) && !event.target.closest('.emotion-hit')) close(false);
  });
  function position(point = anchor) {
    if (!dialog.open || !point) return;
    anchor = point;
    const rect = dialog.getBoundingClientRect();
    let left = point.x + 32;
    if (left + rect.width > innerWidth - 14) left = point.x - rect.width - 32;
    dialog.style.left = Math.max(14, Math.min(left, innerWidth - rect.width - 14)) + 'px';
    dialog.style.top = Math.max(14, Math.min(point.y - rect.height * .42, innerHeight - rect.height - 70)) + 'px';
  }
  function render(record) {
    dialog.dataset.photoId = record.photoId || '';
    dialog.dataset.objectId = record.objectId || '';
    dialog.dataset.inputVersion = String(record.inputVersion ?? '');
    dialog.dataset.source = record.source;
    dialog.style.setProperty('--emotion-color', record.color);
    dialog.style.setProperty('--emotion-rgb', record.color.match(/[a-f\d]{2}/gi).map(n => parseInt(n, 16)).join(','));
    query('.card-object').textContent = record.objectName + (record.source === 'example' ? ' · 情绪示例' : '');
    query('.card-emotion').textContent = record.label;
    const list = query('.card-features'); list.replaceChildren();
    for (const feature of record.features) {
      const li = document.createElement('li'); li.textContent = feature.label; list.append(li);
    }
    const note = query('.card-note');
    note.textContent = record.source === 'example' ? '示例情绪' : record.features.length ? '' : '暂无照片特征';
    note.hidden = !note.textContent;
    query('.card-feature-label').hidden = record.source === 'example';
  }
  return {
    show(record, point) {
      selected = record.id; anchor = point; render(record);
      if (!dialog.open) { onOpen?.(); dialog.show(); }
      position(); query('.card-close').focus({ preventScroll: true });
    },
    update(records) { if (!dialog.open) return; const record = records.find(r => r.id === selected); if (record) { render(record); position(); } else close(); },
    position,
    close,
    get selectedId() { return dialog.open ? selected : null; },
  };
}


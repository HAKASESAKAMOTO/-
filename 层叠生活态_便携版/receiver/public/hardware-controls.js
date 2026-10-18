import { RotationLink } from '/buildings/ecology/rotation-link.js';

const $ = id => document.getElementById(id);
const link = new RotationLink();
let following = false, stream = null, visual = 0, viewer = null, latest = null, receivedAt = 0, valid = false;
const followKey = 'layeredLife.rotationFollowing';
try { following = sessionStorage.getItem(followKey) === '1'; } catch { /* Storage is optional. */ }
let connectionBusy = false;
const frame = $('buildingViewer');
async function api(path, body) {
  const response = await fetch('/api/v1/hardware/' + path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const payload = await response.json();
  if (!response.ok) throw Error(payload.error?.message || '串口请求失败');
  return payload.data;
}
function status(message) { $('serialStatus').textContent = message; }
function showFollowing() {
  $('serialConnect').textContent = following ? '断开同步' : '连接并同步';
  $('serialConnect').setAttribute('aria-pressed', String(following));
}
function releaseViewer() { viewer?.setExternalRotation?.(null); viewer = null; link.rebase(); }
function currentViewer() {
  const candidate = frame.contentWindow?.layeredLifeViewer;
  if (!candidate?.getState().ready) return null;
  if (candidate !== viewer) {
    releaseViewer(); viewer = candidate; visual = candidate.getState().angleDegrees || 0; link.rebase();
  }
  return candidate;
}
function pause(message) {
  valid = false; link.rebase(); $('serialZero').disabled = true;
  status(message);
}
function receive(state) {
  latest = state; receivedAt = performance.now();
  const rotation = state.rotation;
  if (!following) return;
  const target = currentViewer();
  const angle = link.update({ connected: state.connected, age_ms: state.ageMs,
    latest: { boot_id: state.packet?.bootId, ms: state.packet?.uptimeMs },
    angle: rotation ? { available: rotation.available, steps: rotation.steps, steps_per_turn: rotation.stepsPerTurn, sign: rotation.directionSign } : null }, visual);
  if (angle === null) {
    const noData = state.connected && !state.packet && (!state.error || state.error === '等待纯输入固件数据');
    pause(noData ? `${state.port || '串口'} 已打开，但未收到旋转数据；请检查数据线是否接在 UART／USB-UART 接口。` :
      state.error || (state.connected ? '串口已连接，等待有效旋转数据' : '等待设备连接'));
    return;
  }
  valid = true; $('serialZero').disabled = !target;
  if (!target) { link.rebase(); status('串口已连接，等待大楼载入'); return; }
  visual = angle;
  target.setExternalRotation?.(visual);
  $('serialAngle').textContent = visual.toFixed(1) + '°';
  status(`已同步 · ${state.port || 'COM'} · ${rotation.stepsPerTurn} 步/圈`);
}
function subscribe() {
  stream?.close(); link.rebase(); receivedAt = performance.now();
  stream = new EventSource('/api/v1/hardware/events');
  stream.onmessage = event => { try { receive(JSON.parse(event.data).data); } catch { pause('串口数据无效，保持当前视角'); } };
  stream.onerror = () => pause('信号中断，保持当前视角');
}
async function refresh() {
  const button = $('serialRefresh'); button.disabled = true;
  try {
    const previous = $('serialPort').value;
    const ports = await api('ports');
    $('serialPort').replaceChildren(new Option('自动识别', 'auto'));
    for (const port of ports) $('serialPort').add(new Option(`${port.port} · ${port.description || '串口设备'}`, port.port));
    if ([...$('serialPort').options].some(o => o.value === previous)) $('serialPort').value = previous;
    const state = await api('state');
    if (state.rotation?.stepsPerTurn) $('serialSteps').value = state.rotation.stepsPerTurn;
    if (following) { subscribe(); receive(state); }
    else status(ports.length ? `发现 ${ports.length} 个串口，选择后连接` : '未检测到 COM 端口');
  } catch (error) { status(error.message); }
  finally { button.disabled = false; }
}
async function toggle() {
  if (connectionBusy) return;
  connectionBusy = true; $('serialConnect').disabled = true;
  try {
    if (following) {
      await api('connection', { enabled: false });
      following = false; stream?.close(); stream = null; releaseViewer(); valid = false;
      $('serialZero').disabled = true; status('已断开，可手动旋转');
    } else {
      await api('connection', { enabled: true, port: $('serialPort').value });
      following = true; releaseViewer(); subscribe(); status('正在连接，等待旋转数据');
    }
    try { sessionStorage.setItem(followKey, following ? '1' : '0'); } catch { /* Storage is optional. */ }
    showFollowing();
  } catch (error) { status(error.message); }
  finally { connectionBusy = false; $('serialConnect').disabled = false; }
}
$('serialRefresh').onclick = refresh;
$('serialConnect').onclick = toggle;
$('serialZero').onclick = () => {
  if (!valid || !currentViewer()) return;
  // The physical position now corresponds to the building's front. Do not reset device counters.
  visual = 0; link.rebase(); if (latest) receive(latest);
};
$('serialReverse').onchange = () => {
  link.setDirection($('serialReverse').checked ? -1 : 1);
  if (valid && latest) receive(latest);
};
$('serialApply').onclick = async () => {
  const steps = Number($('serialSteps').value);
  if (!Number.isFinite(steps) || steps <= 0 || steps > 1000000) { status('每圈步数需在 0–1000000 之间'); return; }
  $('serialApply').disabled = true;
  try { await api('settings', { stepsPerTurn: steps }); link.rebase(); status('每圈步数已更新'); }
  catch (error) { status(error.message); }
  finally { $('serialApply').disabled = false; }
};
frame.addEventListener('load', () => { releaseViewer(); });
const watchdog = setInterval(() => { if (following && performance.now() - receivedAt > 1200) pause('信号中断，保持当前视角'); }, 300);
window.addEventListener('pagehide', () => { clearInterval(watchdog); stream?.close(); releaseViewer(); }, { once: true });
window.rotationController = { refresh, getState: () => ({ following, valid, visual, port: latest?.port ?? null }) };
showFollowing();
void refresh();

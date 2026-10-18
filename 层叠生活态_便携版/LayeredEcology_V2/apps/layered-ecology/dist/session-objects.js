import * as THREE from 'three';

// 六层楼面（来自 building.glb 实测的楼板顶面高度）与每层两个面向镜头的空位：user 在 +Z 面，ai 在 +X 面。
const FLOORS = [4.1, 7.3, 10.5, 13.7, 16.9, 20.1];
const SLOTS = [
  { user: [-1.75, 3.7], ai: [5.7, -1.3] },
  { user: [-3.25, 2.7], ai: [4.2, -2.3] },
  { user: [-1.8, 2.2], ai: [3.3, -1.75] },
  { user: [-3.05, 3.7], ai: [3.7, -1.3] },
  { user: [-1.75, 2.7], ai: [5.7, -2.8] },
  { user: [-1.8, 2.7], ai: [3.2, -1.25] },
];
const MAX_SIZE = 1.7;

/** Loads this session's generated GLBs and places them on the building floors. */
export async function placeSessionObjects({ sessionId, scene, building, loader, camera }) {
  const response = await fetch(`/api/v1/sessions/${encodeURIComponent(sessionId)}/production`);
  if (!response.ok) throw Error('读取大楼生产状态失败');
  const production = (await response.json()).data;
  if (production.sessionId !== sessionId) throw Error('大楼会话不一致');
  if (production.status !== 'ready') return { count: 0, objects: [], status: production.status };
  const snapshotResponse = await fetch(`/api/v1/sessions/${encodeURIComponent(sessionId)}`, { cache: 'no-store' });
  if (!snapshotResponse.ok) throw Error('读取本轮照片失败');
  const snapshot = (await snapshotResponse.json()).data;
  if (snapshot.sessionId !== sessionId) throw Error('照片会话不一致');
  const photos = new Map(snapshot.photos.map(photo => [photo.photoId, photo]));
  const objects = production.objects.filter(object => object.status === 'ready' && object.assetUrl);
  const ids = new Set();
  for (const object of objects) {
    const photo = photos.get(object.photoId);
    if (!photo || photo.order !== object.floor || photo.annotation?.inputVersion !== object.inputVersion || !['user','ai'].includes(object.source) || object.objectId !== `${photo.photoId}:${object.source}` || ids.has(object.objectId)) throw Error('大楼物件与本轮标注不一致');
    const expectedPath = `/api/v1/sessions/${encodeURIComponent(sessionId)}/production/objects/${encodeURIComponent(object.objectId)}/file`;
    if (object.assetUrl !== expectedPath) throw Error('物件不是本轮生成的模型');
    ids.add(object.objectId);
  }
  const floorMeshes = [];
  building.traverse(node => { if (node.isMesh && node.name.startsWith('Building')) floorMeshes.push(node); });
  building.updateMatrixWorld(true);
  const raycaster = new THREE.Raycaster();
  const yaw = Math.atan2(camera.position.x, camera.position.z);
  const group = new THREE.Group(); group.name = 'Session objects'; scene.add(group);
  const placed = [];
  await Promise.all(objects.map(async object => {
    const gltf = await loader.loadAsync(object.assetUrl);
    const model = gltf.scene;
    const box = new THREE.Box3().setFromObject(model), size = box.getSize(new THREE.Vector3());
    const scale = MAX_SIZE / Math.max(size.x, size.y, size.z, 1e-6);
    const pivot = new THREE.Group();
    model.scale.setScalar(scale);
    const center = box.getCenter(new THREE.Vector3()).multiplyScalar(scale);
    model.position.set(-center.x, -box.min.y * scale, -center.z); // bottom-center at the pivot
    pivot.add(model);
    const [x, z] = SLOTS[object.floor][object.source];
    raycaster.set(new THREE.Vector3(x, FLOORS[object.floor] + 2.4, z), new THREE.Vector3(0, -1, 0));
    const hit = raycaster.intersectObjects(floorMeshes, false).find(h => h.point.y > FLOORS[object.floor] - 0.4);
    pivot.position.set(x, hit ? hit.point.y : FLOORS[object.floor], z);
    pivot.rotation.y = yaw; // Rodin models face +Z; turn them toward the poster camera.
    pivot.name = `${object.objectId} | ${object.label}`;
    pivot.userData = { objectId: object.objectId, label: object.label, source: object.source, floor: object.floor };
    model.traverse(node => { if (node.isMesh) { node.frustumCulled = true; node.castShadow = false; } });
    group.add(pivot); placed.push(pivot.userData);
  }));
  return { count: placed.length, objects: placed };
}

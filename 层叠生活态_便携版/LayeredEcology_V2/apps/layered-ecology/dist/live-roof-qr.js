import * as THREE from 'three';

// Replace the original mesh's texture: geometry, UVs, depth and transforms stay identical.
// 草船二维码会持续刷新：复用同一张 CanvasTexture，每次只重绘画布并标记 needsUpdate。
export function createLiveRoofQr(building) {
  const targets = [];
  building.traverse(node => {
    if (!node.isMesh || !node.name.startsWith('Roof_QR') && !node.name.startsWith('Roof QR')) return;
    for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
      if (material.emissiveMap) targets.push({ material, original: material.emissiveMap, map: material.map, color: material.color?.clone(), emissive: material.emissive?.clone() });
    }
  });
  if (!targets.length) throw Error('Roof QR mesh not found');
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  let texture = null, revision = 0, lastUrl = null, updates = 0;

  function ensureTexture(width, height) {
    if (texture && canvas.width === width && canvas.height === height) return false;
    canvas.width = width; canvas.height = height;
    texture?.dispose();
    texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.flipY = false;
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    return true;
  }

  async function update(dataUrl) {
    if (dataUrl === lastUrl) return;
    const token = ++revision;
    if (!dataUrl) {
      targets.forEach(t => { t.material.emissiveMap = t.original; t.material.map = t.map; if (t.color) t.material.color.copy(t.color); if (t.emissive) t.material.emissive.copy(t.emissive); t.material.needsUpdate = true; });
      lastUrl = null; return;
    }
    if (typeof dataUrl !== 'string' || !/^data:image\/(png|jpeg|webp);base64,/.test(dataUrl)) return;
    const image = new Image(); image.src = dataUrl; await image.decode();
    if (token !== revision) return;
    const rebuilt = ensureTexture(image.naturalWidth, image.naturalHeight);
    ctx.imageSmoothingEnabled = false;
    // Receiver QR PNGs have a transparent background; as an emissive texture that reads as black.
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.drawImage(image, 0, 0);
    texture.needsUpdate = true;
    targets.forEach(({ material }) => {
      const attach = material.map !== texture || material.emissiveMap !== texture;
      material.color?.set(0xffffff);
      material.emissive?.set(0xffffff);
      material.map = texture;
      material.emissiveMap = texture;
      material.emissiveIntensity = 1;
      material.toneMapped = false;
      if (attach || rebuilt) material.needsUpdate = true;
    });
    lastUrl = dataUrl; updates++;
  }
  return { update, getState: () => ({ live: lastUrl !== null, meshes: targets.length, updates }) };
}
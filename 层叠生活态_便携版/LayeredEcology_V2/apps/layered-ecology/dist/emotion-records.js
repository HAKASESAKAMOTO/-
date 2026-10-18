// Pure mapping: a saved photo annotation is the sole source of a personal bubble.
// Array position, animation count and AI objects never determine the emotion.
export function sessionEmotionRecords(snapshot, palette) {
  if (!snapshot || !Array.isArray(snapshot.photos)) throw Error('照片标注数据不完整');
  const ids = new Set(), floors = new Set();
  return [...snapshot.photos].sort((a, b) => a.order - b.order).map(photo => {
    if (!photo.photoId || ids.has(photo.photoId)) throw Error('照片标识重复或缺失');
    if (!Number.isInteger(photo.order) || photo.order < 0 || photo.order > 5 || floors.has(photo.order)) throw Error('照片楼层无效');
    ids.add(photo.photoId); floors.add(photo.order);
    const annotation = photo.annotation;
    if (annotation && (annotation.photoId !== photo.photoId || annotation.objectId !== `${photo.photoId}:user`)) {
      throw Error('物件与照片标注不一致');
    }
    const emotion = annotation?.emotion, selection = emotion?.selection;
    const center = selection?.sector === null && selection?.ring === 0;
    const cell = Number.isInteger(selection?.sector) && selection.sector >= 0 && selection.sector < 8 && Number.isInteger(selection?.ring) && selection.ring >= 1 && selection.ring <= 4;
    const expected = center ? '复杂' : cell ? palette.words[selection.sector][selection.ring - 1] : null;
    const confirmed = emotion?.status === 'selected' && selection?.phase === 'confirmed' && expected && emotion.label === expected && selection.emotion === expected;
    const unsure = emotion?.status === 'unsure';
    const currentAnalysis = photo.analysis?.inputVersion === annotation?.inputVersion ? photo.analysis : null;
    const analysis = currentAnalysis?.status === 'ready' ? currentAnalysis.result : null;
    const label = confirmed ? expected : unsure ? '不太确定' : '尚未确认';
    return {
      id: photo.photoId, photoId: photo.photoId, objectId: `${photo.photoId}:user`,
      sessionId: snapshot.sessionId, source: 'user', floor: photo.order,
      inputVersion: annotation?.inputVersion ?? null,
      objectName: annotation?.userLabel || `照片 ${photo.order + 1}`,
      label, sector: confirmed ? selection.sector : null, ring: confirmed ? selection.ring : null,
      color: confirmed && !center ? palette.colors[selection.sector] : '#c7c9ca',
      description: confirmed ? selection.description || '这是你为这张照片保存的感受。' : unsure ? '你为这张照片选择了“不太确定”，没有指定情绪。' : '这张照片还没有有效的已确认情绪，请返回轮盘确认。',
      direction: confirmed ? selection.direction || '' : '', intensity: confirmed ? selection.intensity || '' : '',
      referenceTime: annotation?.referenceTime === 'review' ? '现在回看' : '拍摄当时',
      thumbnailUrl: photo.thumbnailUrl || photo.url || null,
      features: Array.isArray(analysis?.scene_features) ? analysis.scene_features.map(f => ({ label: String(f.label || ''), evidence: String(f.evidence || '') })).filter(f => f.label) : [],
      aiObject: analysis?.ai_object?.name || null,
      status: confirmed ? 'confirmed' : unsure ? 'unsure' : 'unconfirmed',
    };
  });
}

export function exampleEmotionRecords(palette) {
  return [7, 6, 2, 3, 4, 0].map((sector, floor) => ({
    id: `example-${floor}`, photoId: null, objectId: null, sessionId: null,
    source: 'example', floor, inputVersion: null, objectName: `第 ${floor + 1} 层`,
    label: palette.words[sector][1], sector, ring: 2, color: palette.colors[sector],
    description: '这是示例情绪，用于体验气泡交互。你的已保存选择显示在“我的生活大楼”中。',
    direction: '', intensity: '', referenceTime: '', thumbnailUrl: null,
    features: [], aiObject: null, status: 'example',
  }));
}

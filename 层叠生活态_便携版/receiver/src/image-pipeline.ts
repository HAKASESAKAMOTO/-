import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const MIME_BY_FORMAT: Record<string, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

export interface ValidatedImage {
  sha256: string;
  mimeType: string;
  format: 'jpeg' | 'png' | 'webp';
  width: number;
  height: number;
  fileSize: number;
}

export async function validateImage(filePath: string, maxBytes: number): Promise<ValidatedImage> {
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) throw new Error('不是普通文件');
  if (stat.size > maxBytes) throw new Error(`图片超过 ${Math.round(maxBytes / 1024 / 1024)} MB 限制`);
  const metadata = await sharp(filePath, { failOn: 'error' }).metadata();
  if (!metadata.format || !(metadata.format in MIME_BY_FORMAT)) {
    throw new Error('仅支持 JPG、PNG 或 WebP 图片');
  }
  if (!metadata.width || !metadata.height) throw new Error('图片缺少有效尺寸');
  const hash = crypto.createHash('sha256');
  const bytes = await fs.readFile(filePath);
  hash.update(bytes);
  return {
    sha256: hash.digest('hex'),
    mimeType: MIME_BY_FORMAT[metadata.format],
    format: metadata.format as ValidatedImage['format'],
    width: metadata.width,
    height: metadata.height,
    fileSize: stat.size,
  };
}

export async function createDerivatives(inputPath: string, processedPath: string, thumbnailPath: string): Promise<void> {
  await fs.mkdir(path.dirname(processedPath), { recursive: true });
  await fs.mkdir(path.dirname(thumbnailPath), { recursive: true });
  await sharp(inputPath, { failOn: 'error' })
    .rotate()
    .resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 90, mozjpeg: true })
    .toFile(processedPath);
  await sharp(inputPath, { failOn: 'error' })
    .rotate()
    .resize({ width: 480, height: 480, fit: 'cover', position: 'attention' })
    .webp({ quality: 82 })
    .toFile(thumbnailPath);
}

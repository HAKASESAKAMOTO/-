export const TARGET_COUNT = 6;

export type ReceiverMode = 'AUTO' | 'MANUAL_FALLBACK';

export type SessionStatus =
  | 'IDLE'
  | 'INITIALIZING'
  | 'WAITING_FOR_SCAN'
  | 'COLLECTING'
  | 'DOWNLOADING'
  | 'IMPORTING'
  | 'IMAGES_READY'
  | 'ANNOTATING'
  | 'ERROR'
  | 'MANUAL_FALLBACK'
  | 'SESSION_CLOSED';

export type ImageStatus = 'READY' | 'FAILED';

export interface ImageRecord {
  imageId: string;
  index: number;
  originalName: string;
  originalPath: string;
  processedPath: string;
  thumbnailPath: string;
  mimeType: string;
  fileSize: number;
  width: number;
  height: number;
  sha256: string;
  importedAt: string;
  status: ImageStatus;
}

export interface OverflowRecord {
  originalName: string;
  path: string;
  reason: string;
  detectedAt: string;
}

export interface SessionError {
  code: string;
  message: string;
  at: string;
  source?: string;
}

export interface SessionManifest {
  sessionId: string;
  status: SessionStatus;
  mode: ReceiverMode;
  targetCount: number;
  imageCount: number;
  images: ImageRecord[];
  overflow: OverflowRecord[];
  errors: SessionError[];
  createdAt: string;
  updatedAt: string;
}

export interface ReceiverEvent<T = unknown> {
  sessionId: string;
  eventType: string;
  timestamp: string;
  data: T;
}

export interface ImportResult {
  imported: ImageRecord[];
  duplicate: string[];
  invalid: Array<{ name: string; message: string }>;
  overflow: string[];
}

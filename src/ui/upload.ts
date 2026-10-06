import { useCallback, useRef, useState } from 'react';
import { MAX_ATTACHMENTS_PER_TURN, MAX_ATTACHMENT_BYTES } from '../shared/protocol';
import type { UploadedAttachment } from './state';

/** The text of a turn sent with attachments only. */
export const ATTACHMENT_ONLY_TEXT = '첨부 파일을 확인해 주세요.';

export type UploadFn = (file: File) => Promise<UploadedAttachment>;

/** D7: raw body upload; the server sniffs the type and sanitizes the name. */
export async function uploadFile(file: File, fetchFn: typeof fetch = fetch): Promise<UploadedAttachment> {
  let res: Response;
  try {
    res = await fetchFn('/api/attachments', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': file.type || 'application/octet-stream', 'x-deck-filename': encodeURIComponent(file.name || 'file') },
      body: file,
    });
  } catch {
    // fetch itself rejected (offline, DNS, CORS, aborted, …) — never surface the raw browser error.
    throw new Error('업로드 실패: 네트워크 오류');
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `업로드 실패 (${res.status})`);
  }
  const j = (await res.json()) as { id: string; name: string; size: number; isImage: boolean };
  // ux-state: the composer previews the local file (blob: is allowed by the CSP img-src); the server's sniff decides.
  const previewUrl = j.isImage && typeof URL.createObjectURL === 'function' ? URL.createObjectURL(file) : undefined;
  return { id: j.id, name: j.name, size: j.size, isImage: j.isImage, ...(previewUrl ? { previewUrl } : {}) };
}

/** Files of a paste/drop; null-safe. */
export function filesFrom(dt: DataTransfer | null): File[] {
  if (!dt) return [];
  const out: File[] = [];
  if (dt.files) for (const f of Array.from(dt.files)) out.push(f);
  return out;
}

export function useUploads({ uploadFn, current, onUploaded }: { uploadFn: UploadFn; current: number; onUploaded: (a: UploadedAttachment) => void }) {
  const [uploading, setUploading] = useState(0);
  const [error, setError] = useState<string | null>(null);
  // Concurrent addFiles calls (paste + drop + picker, Task 12) each close over the same `current`
  // prop, so `current` alone can't see another call's in-flight uploads. pendingRef is reserved
  // synchronously — before this function's first await — so a second call made "back to back"
  // (e.g. via Promise.all) sees the first call's reservation and the combined cap still holds.
  const pendingRef = useRef(0);
  const addFiles = useCallback(async (files: File[]) => {
    setError(null);
    const room = Math.max(0, MAX_ATTACHMENTS_PER_TURN - current - pendingRef.current);
    const withinRoom = files.slice(0, room);
    if (files.length > room) setError(`첨부는 한 번에 최대 ${MAX_ATTACHMENTS_PER_TURN}개까지입니다`);
    // D7 / Task 6 security review: check size BEFORE uploading so an oversize file never hits the network.
    const accepted: File[] = [];
    for (const f of withinRoom) {
      if (f.size > MAX_ATTACHMENT_BYTES) {
        setError(`첨부가 너무 큽니다(최대 ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MiB)`);
      } else {
        accepted.push(f);
        pendingRef.current += 1; // reserved synchronously, before any await below
      }
    }
    for (const f of accepted) {
      setUploading((n) => n + 1);
      try {
        onUploaded(await uploadFn(f));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setUploading((n) => n - 1);
        pendingRef.current -= 1;
      }
    }
  }, [uploadFn, current, onUploaded]);
  return { addFiles, uploading, error };
}

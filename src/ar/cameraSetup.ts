/**
 * Camera tuning for image tracking.
 *
 * MindAR opens the camera with only `facingMode: 'environment'`. On many
 * Android phones that can land on a secondary rear camera (ultra-wide,
 * macro or depth) and leaves focus to the browser default, which makes
 * the mural slow to detect and fussy about angle. iPhones don't have this
 * problem because Safari always opens the main camera.
 *
 * installCameraTuning() wraps getUserMedia so that, for a rear-camera
 * request, it:
 *  - switches to the phone's main rear camera ("camera2 0" on Android)
 *    when the browser picked another one;
 *  - asks for continuous autofocus where the browser supports it.
 * It also records what camera ended up in use, for the ?debug overlay.
 */

export interface CameraInfo {
  label: string;
  width: number;
  height: number;
  focusMode: string;
  switched: boolean;
}

let lastInfo: CameraInfo | null = null;
let installed = false;

/** The camera most recently opened for tracking (null before the first one). */
export function getCameraInfo(): CameraInfo | null {
  return lastInfo;
}

/** Android Chrome labels cameras "camera2 <n>, facing back"; n = 0 is the main one. */
function cameraNumber(label: string): number {
  const m = /camera2?\s*(\d+)/i.exec(label);
  return m ? Number(m[1]) : Number.POSITIVE_INFINITY;
}

async function pickMainRearCamera(): Promise<MediaDeviceInfo | null> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const rear = devices.filter((d) => d.kind === 'videoinput' && /back|rear|environment/i.test(d.label));
  if (rear.length < 2) return null;
  rear.sort((a, b) => cameraNumber(a.label) - cameraNumber(b.label));
  return Number.isFinite(cameraNumber(rear[0].label)) ? rear[0] : null;
}

async function tuneFocus(track: MediaStreamTrack): Promise<void> {
  const caps = (track.getCapabilities?.() ?? {}) as { focusMode?: string[] };
  if (caps.focusMode?.includes('continuous')) {
    try {
      await track.applyConstraints({ advanced: [{ focusMode: 'continuous' } as MediaTrackConstraintSet] });
    } catch {
      // Not supported on this device; keep the default.
    }
  }
}

export function installCameraTuning(): void {
  if (installed || !navigator.mediaDevices?.getUserMedia) return;
  installed = true;
  const md = navigator.mediaDevices;
  const original = md.getUserMedia.bind(md);

  md.getUserMedia = async (constraints?: MediaStreamConstraints): Promise<MediaStream> => {
    let stream = await original(constraints);
    const video = constraints?.video;
    const wantsRear =
      typeof video === 'object' && video !== null && video.facingMode === 'environment' && !video.deviceId;
    let switched = false;

    if (wantsRear && /android/i.test(navigator.userAgent)) {
      try {
        const main = await pickMainRearCamera();
        const current = stream.getVideoTracks()[0]?.getSettings().deviceId;
        if (main && main.deviceId && main.deviceId !== current) {
          // Many phones can't open two cameras at once, so release this one first.
          stream.getTracks().forEach((t) => t.stop());
          const { facingMode: _ignored, ...rest } = video as MediaTrackConstraints;
          try {
            stream = await original({ ...constraints, video: { ...rest, deviceId: { exact: main.deviceId } } });
            switched = true;
          } catch (err) {
            console.warn('[Camera] Main rear camera failed to open, using the default:', err);
            stream = await original(constraints);
          }
        }
      } catch (err) {
        console.warn('[Camera] Could not switch to the main rear camera:', err);
      }
    }

    const track = stream.getVideoTracks()[0];
    if (track) {
      await tuneFocus(track);
      const s = track.getSettings() as MediaTrackSettings & { focusMode?: string };
      lastInfo = {
        label: track.label,
        width: s.width ?? 0,
        height: s.height ?? 0,
        focusMode: s.focusMode ?? 'n/a',
        switched,
      };
      console.log('[Camera]', lastInfo);
    }
    return stream;
  };
}

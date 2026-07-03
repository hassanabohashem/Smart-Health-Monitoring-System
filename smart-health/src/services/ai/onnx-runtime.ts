/**
 * Lightweight wrapper around `onnxruntime-react-native`.
 *
 * - Caches `InferenceSession` per model id so each adapter pays the load
 *   cost exactly once (warm calls are sub-millisecond setup).
 * - Centralises asset resolution via `expo-asset` so adapters only need
 *   to pass a `require(...)` reference for the bundled `.onnx`.
 * - Hides the (irritating) detail that `Asset.localUri` is `null` until
 *   `downloadAsync()` resolves.
 *
 * Adapters call `loadOnnxSession({ id, asset })` in their `initialize()`
 * and `runOnnxSession({ id, feeds })` in their `predict()`.
 */
import { Asset } from 'expo-asset';
import * as ort from 'onnxruntime-react-native';

const sessionCache = new Map<string, ort.InferenceSession>();

export interface LoadOnnxSessionParams {
  /** Unique adapter id — also used as the cache key. */
  id: string;
  /** Output of `require('@/assets/models/foo.onnx')`. */
  asset: number;
  /** Optional ORT session options (graphOptimizationLevel, executionProviders, etc). */
  sessionOptions?: ort.InferenceSession.SessionOptions;
}

export async function loadOnnxSession(
  params: LoadOnnxSessionParams
): Promise<ort.InferenceSession> {
  const cached = sessionCache.get(params.id);
  if (cached) return cached;

  // expo-asset materialises the bundled file into a localUri (and downloads
  // on first reference if it's an OTA-shipped asset).
  const asset = Asset.fromModule(params.asset);
  if (!asset.localUri) {
    await asset.downloadAsync();
  }
  const localUri = asset.localUri ?? asset.uri;
  if (!localUri) {
    throw new Error(`[onnx-runtime] could not resolve asset for "${params.id}"`);
  }

  // ORT-RN expects a raw file path (no `file://` scheme on Android).
  const path = localUri.startsWith('file://') ? localUri.slice(7) : localUri;
  const session = await ort.InferenceSession.create(
    path,
    params.sessionOptions ?? {
      graphOptimizationLevel: 'all',
      executionProviders: ['cpu'],
    }
  );
  sessionCache.set(params.id, session);
  return session;
}

export interface RunOnnxParams {
  id: string;
  feeds: Record<string, ort.Tensor>;
}

export async function runOnnxSession(
  params: RunOnnxParams
): Promise<ort.InferenceSession.ReturnType> {
  const session = sessionCache.get(params.id);
  if (!session) {
    throw new Error(`[onnx-runtime] session "${params.id}" not initialized; call loadOnnxSession first`);
  }
  return session.run(params.feeds);
}

export function disposeOnnxSession(id: string): void {
  const s = sessionCache.get(id);
  if (s) {
    // ORT-RN sessions don't expose a sync `release()`; let GC handle it.
    sessionCache.delete(id);
  }
}

export function disposeAllOnnxSessions(): void {
  sessionCache.clear();
}

// Re-export Tensor and InferenceSession types so adapters don't have to
// import them from `onnxruntime-react-native` directly.
export { ort };
export type Tensor = ort.Tensor;
export type InferenceSession = ort.InferenceSession;

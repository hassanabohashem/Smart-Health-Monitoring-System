export { aiRegistry, type AIModelAdapter, type ModelPrediction, type ModelType } from './ai-registry';
export { FallDetectionAdapter, FallDetectionSimulator, type FallDetectionInput } from './fall-detection.adapter';
export { HARAdapter, HARSimulator, type HARInput, type HARLabel } from './har.adapter';
export { CardiacAdapter, CardiacSimulator, type CardiacInput, type AAMILabel } from './cardiac.adapter';
export {
  initializeAI,
  disposeAI,
  processSensorWindow,
  processActivityWindow,
  processCardiacBeat,
  confirmFallAlert,
  onFallDetected,
  onActivityDetected,
  onCardiacAnomaly,
  setFallDetectionEnabled,
  setHAREnabled,
  setCardiacEnabled,
  getModelStatus,
} from './ai.service';

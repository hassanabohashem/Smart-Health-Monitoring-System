export interface AIModelConfig {
  id: string;
  name: string;
  version: string;
  type: 'on-device';
  status: 'active' | 'coming-soon' | 'disabled';
}

export interface AIInferenceRequest {
  modelId: string;
  input: Record<string, unknown>;
  context?: {
    userId?: string;
    currentActivity?: string;
    recentVitals?: unknown;
  };
}

export interface AIInferenceResult {
  modelId: string;
  prediction: unknown;
  confidence: number;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

export interface AIModelAdapter {
  config: AIModelConfig;
  initialize(): Promise<void>;
  predict(request: AIInferenceRequest): Promise<AIInferenceResult>;
  dispose(): Promise<void>;
}

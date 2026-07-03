/**
 * AI Model Registry
 *
 * Central registry for all AI models in the system.
 * Each model implements the AIModelAdapter interface.
 * New models are added by creating an adapter and registering it here.
 */

export type ModelType = 'fall_detection' | 'cardiac_anomaly' | 'activity_recognition' | 'health_assistant';
export type ModelStatus = 'active' | 'loading' | 'error' | 'unavailable';

export interface ModelPrediction {
  label: string;          // e.g., "fall", "no_fall", "afib", "walking"
  confidence: number;     // 0.0 - 1.0
  raw?: number[];         // raw model output logits
  metadata?: Record<string, unknown>;
}

export interface AIModelAdapter {
  /** Unique identifier for this model */
  id: string;
  /** Human-readable name */
  name: string;
  /** Model type category */
  type: ModelType;
  /** Current model version */
  version: string;
  /** Where the model runs (always on-device for the three ML models). */
  runtime: 'on-device';
  /** Current status */
  status: ModelStatus;

  /** Initialize the model (load weights, warm up, etc.) */
  initialize(): Promise<void>;

  /** Run inference on input data */
  predict(input: Record<string, unknown>): Promise<ModelPrediction>;

  /** Clean up resources */
  dispose(): Promise<void>;
}

class AIModelRegistry {
  private models: Map<string, AIModelAdapter> = new Map();

  /** Register a new model adapter */
  register(adapter: AIModelAdapter): void {
    this.models.set(adapter.id, adapter);
    // registered
  }

  /** Get a model by ID */
  get(id: string): AIModelAdapter | undefined {
    return this.models.get(id);
  }

  /** Get all models of a specific type */
  getByType(type: ModelType): AIModelAdapter[] {
    return Array.from(this.models.values()).filter((m) => m.type === type);
  }

  /** Get all registered models */
  getAll(): AIModelAdapter[] {
    return Array.from(this.models.values());
  }

  /** Initialize all registered models */
  async initializeAll(): Promise<void> {
    for (const model of this.models.values()) {
      try {
        await model.initialize();
      } catch (err) {
        // init failed
        model.status = 'error';
      }
    }
  }

  /** Dispose all models */
  async disposeAll(): Promise<void> {
    for (const model of this.models.values()) {
      try {
        await model.dispose();
      } catch {}
    }
    this.models.clear();
  }
}

// Singleton instance
export const aiRegistry = new AIModelRegistry();

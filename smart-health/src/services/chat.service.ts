import { useVitalsStore } from '@/stores/vitals.store';
import i18n from '@/i18n';

const t = (key: string, opts?: any): string => i18n.t(key, opts) as string;

function getVitalStatus(value: number, low: number, high: number): string {
  if (value < low) return 'low';
  if (value > high) return 'high';
  return 'normal';
}

export function generateResponse(questionKey: string): string {
  const vitals = useVitalsStore.getState();
  const hasData = vitals.heartRate != null;

  if (!hasData) {
    return t('assistant.noData');
  }

  switch (questionKey) {
    case 'heart_rate': {
      const hr = vitals.heartRate || 0;
      const status = getVitalStatus(hr, 60, 100);
      return t('assistant.heartRateResponse', { value: hr, status });
    }
    case 'spo2': {
      const spo2 = vitals.spo2 || 0;
      const status = spo2 >= 95 ? 'normal' : 'low';
      return t('assistant.spo2Response', { value: spo2, status });
    }
    case 'temperature': {
      const temp = vitals.temperature || 0;
      const status = getVitalStatus(temp, 36.1, 37.2);
      return t('assistant.temperatureResponse', { value: temp, status });
    }
    case 'steps': {
      const steps = vitals.steps || 0;
      const goal = 6000;
      const remaining = Math.max(0, goal - steps);
      return t('assistant.stepsResponse', { steps, goal, remaining });
    }
    case 'summary': {
      return t('assistant.weeklySummaryResponse', {
        heartRate: vitals.heartRate || '--',
        spo2: vitals.spo2 || '--',
        steps: vitals.steps || 0,
      });
    }
    default:
      return t('assistant.defaultResponse');
  }
}

export function matchQuestionKey(text: string): string {
  const lower = text.toLowerCase();
  if (lower.includes('heart') || lower.includes('pulse') || lower.includes('bpm') || lower.includes('قلب')) return 'heart_rate';
  if (lower.includes('spo2') || lower.includes('oxygen') || lower.includes('أكسجين')) return 'spo2';
  if (lower.includes('temp') || lower.includes('حرارة')) return 'temperature';
  if (lower.includes('step') || lower.includes('walk') || lower.includes('خطو')) return 'steps';
  if (lower.includes('summary') || lower.includes('ملخص') || lower.includes('status') || lower.includes('حالة')) return 'summary';
  return 'unknown';
}

import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { I18nManager, Alert, NativeModules } from 'react-native';
import en from './en';
import ar from './ar';

const LANGUAGE_KEY = '@app_language';

export async function getStoredLanguage(): Promise<string> {
  try {
    const stored = await AsyncStorage.getItem(LANGUAGE_KEY);
    if (stored) return stored;
  } catch {}
  return 'en';
}

export async function setLanguage(lang: string) {
  await AsyncStorage.setItem(LANGUAGE_KEY, lang);
  await i18n.changeLanguage(lang);

  // Handle RTL — requires app reload to take effect
  const isRTL = lang === 'ar';
  if (I18nManager.isRTL !== isRTL) {
    I18nManager.allowRTL(isRTL);
    I18nManager.forceRTL(isRTL);

    // Attempt to reload the app automatically
    const DevSettings = NativeModules.DevSettings;
    if (__DEV__ && DevSettings?.reload) {
      DevSettings.reload();
    } else {
      Alert.alert(
        isRTL ? 'أعد تشغيل التطبيق' : 'Restart Required',
        isRTL ? 'يرجى إعادة تشغيل التطبيق لتطبيق تغيير اللغة.' : 'Please restart the app to apply the language change.',
      );
    }
  }
}

// Initialize i18n
export async function initI18n() {
  const lng = await getStoredLanguage();

  await i18n.use(initReactI18next).init({
    resources: {
      en: { translation: en },
      ar: { translation: ar },
    },
    lng,
    fallbackLng: 'en',
    interpolation: {
      escapeValue: false,
    },
    react: {
      useSuspense: false,
    },
  });

  // Set RTL based on language
  const isRTL = lng === 'ar';
  I18nManager.allowRTL(isRTL);
  I18nManager.forceRTL(isRTL);
}

export default i18n;

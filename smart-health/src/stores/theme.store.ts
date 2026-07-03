import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';

interface ThemeState {
  isDarkMode: boolean;
  isLoaded: boolean;
  toggleDarkMode: () => void;
  loadTheme: () => Promise<void>;
}

export const useThemeStore = create<ThemeState>((set, get) => ({
  isDarkMode: false,
  isLoaded: false,

  toggleDarkMode: () => {
    const newValue = !get().isDarkMode;
    set({ isDarkMode: newValue });
    AsyncStorage.setItem('theme_dark_mode', JSON.stringify(newValue));
  },

  loadTheme: async () => {
    try {
      const stored = await AsyncStorage.getItem('theme_dark_mode');
      if (stored !== null) {
        set({ isDarkMode: JSON.parse(stored) });
      }
    } catch {
      // ignore
    }
    set({ isLoaded: true });
  },
}));

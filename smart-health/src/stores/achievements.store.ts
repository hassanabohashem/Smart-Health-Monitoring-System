import { create } from 'zustand';
import type { Achievement } from '@/types/achievement.types';

interface AchievementsState {
  achievements: Achievement[];
  totalPoints: number;
  newUnlock: Achievement | null;
  isLoading: boolean;

  setAchievements: (achievements: Achievement[]) => void;
  setTotalPoints: (points: number) => void;
  setNewUnlock: (achievement: Achievement | null) => void;
  addAchievements: (achievements: Achievement[]) => void;
  setLoading: (loading: boolean) => void;
  reset: () => void;
}

export const useAchievementsStore = create<AchievementsState>((set) => ({
  achievements: [],
  totalPoints: 0,
  newUnlock: null,
  isLoading: false,

  setAchievements: (achievements) => set({ achievements }),
  setTotalPoints: (totalPoints) => set({ totalPoints }),
  setNewUnlock: (newUnlock) => set({ newUnlock }),
  addAchievements: (newOnes) =>
    set((state) => ({
      achievements: [...newOnes, ...state.achievements],
      totalPoints: state.totalPoints + newOnes.reduce((s, a) => s + a.points, 0),
    })),
  setLoading: (isLoading) => set({ isLoading }),
  reset: () => set({ achievements: [], totalPoints: 0, newUnlock: null, isLoading: false }),
}));

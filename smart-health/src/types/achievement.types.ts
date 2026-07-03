export type AchievementType =
  | 'daily_steps_goal'
  | 'consistent_vitals'
  | 'weekly_streak'
  | 'first_link'
  | 'profile_complete';

export interface Achievement {
  id: string;
  user_id: string;
  type: AchievementType;
  points: number;
  unlocked_at: string;
}

export interface AchievementConfig {
  type: AchievementType;
  icon: string;
  points: number;
  titleKey: string;
  descKey: string;
}

export const ACHIEVEMENT_CONFIGS: AchievementConfig[] = [
  { type: 'daily_steps_goal', icon: 'shoe-print', points: 100, titleKey: 'achievements.dailySteps', descKey: 'achievements.dailyStepsDesc' },
  { type: 'consistent_vitals', icon: 'heart-pulse', points: 150, titleKey: 'achievements.consistentVitals', descKey: 'achievements.consistentVitalsDesc' },
  { type: 'weekly_streak', icon: 'fire', points: 200, titleKey: 'achievements.weeklyStreak', descKey: 'achievements.weeklyStreakDesc' },
  { type: 'first_link', icon: 'account-heart', points: 50, titleKey: 'achievements.firstLink', descKey: 'achievements.firstLinkDesc' },
  { type: 'profile_complete', icon: 'account-check', points: 50, titleKey: 'achievements.profileComplete', descKey: 'achievements.profileCompleteDesc' },
];

import { supabase } from './supabase';
import type { Achievement, AchievementType } from '@/types/achievement.types';

export async function getUserAchievements(userId: string): Promise<Achievement[]> {
  const { data, error } = await supabase
    .from('achievements')
    .select('*')
    .eq('user_id', userId)
    .order('unlocked_at', { ascending: false });

  if (error) throw error;
  return data || [];
}

export async function unlockAchievement(
  userId: string,
  type: AchievementType,
  points: number
): Promise<Achievement | null> {
  const { data, error } = await supabase
    .from('achievements')
    .upsert(
      { user_id: userId, type, points, unlocked_at: new Date().toISOString() },
      { onConflict: 'user_id,type', ignoreDuplicates: true }
    )
    .select()
    .single();

  if (error) {
    // If ignoreDuplicates caused no row returned, it was already unlocked
    if (error.code === 'PGRST116') return null;
    console.error('Failed to unlock achievement:', error);
    return null;
  }
  return data;
}

export async function checkAndUnlockAchievements(
  userId: string,
  context: {
    steps?: number;
    heartRate?: number | null;
    spo2?: number | null;
    temperature?: number | null;
    linkedCaregivers?: number;
    hasName?: boolean;
    hasPhone?: boolean;
    hasAvatar?: boolean;
    accountAgeDays?: number;
  },
  existingTypes: Set<AchievementType>
): Promise<Achievement[]> {
  const newAchievements: Achievement[] = [];

  // daily_steps_goal: 6000+ steps
  if (!existingTypes.has('daily_steps_goal') && (context.steps || 0) >= 6000) {
    const a = await unlockAchievement(userId, 'daily_steps_goal', 100);
    if (a) newAchievements.push(a);
  }

  // consistent_vitals: HR 60-100, SpO2 >= 95, Temp 36.0-37.5
  if (
    !existingTypes.has('consistent_vitals') &&
    context.heartRate != null &&
    context.spo2 != null &&
    context.temperature != null &&
    context.heartRate >= 60 && context.heartRate <= 100 &&
    context.spo2 >= 95 &&
    context.temperature >= 36.0 && context.temperature <= 37.5
  ) {
    const a = await unlockAchievement(userId, 'consistent_vitals', 150);
    if (a) newAchievements.push(a);
  }

  // first_link: at least 1 caregiver linked
  if (!existingTypes.has('first_link') && (context.linkedCaregivers || 0) >= 1) {
    const a = await unlockAchievement(userId, 'first_link', 50);
    if (a) newAchievements.push(a);
  }

  // profile_complete: name + phone + avatar
  if (!existingTypes.has('profile_complete') && context.hasName && context.hasPhone && context.hasAvatar) {
    const a = await unlockAchievement(userId, 'profile_complete', 50);
    if (a) newAchievements.push(a);
  }

  // weekly_streak: simplified — if daily_steps_goal exists and account is 7+ days old
  if (
    !existingTypes.has('weekly_streak') &&
    (existingTypes.has('daily_steps_goal') || newAchievements.some(a => a.type === 'daily_steps_goal')) &&
    (context.accountAgeDays || 0) >= 7
  ) {
    const a = await unlockAchievement(userId, 'weekly_streak', 200);
    if (a) newAchievements.push(a);
  }

  return newAchievements;
}

export async function getTotalPoints(userId: string): Promise<number> {
  const { data, error } = await supabase
    .from('achievements')
    .select('points')
    .eq('user_id', userId);

  if (error || !data) return 0;
  return data.reduce((sum, a) => sum + (a.points || 0), 0);
}

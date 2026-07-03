import { useEffect, useCallback } from 'react';
import { View, ScrollView, SafeAreaView, Text } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '@/stores/auth.store';
import { useAchievementsStore } from '@/stores/achievements.store';
import { getUserAchievements, getTotalPoints } from '@/services/achievement.service';
import { ACHIEVEMENT_CONFIGS } from '@/types/achievement.types';
import {
  useDesignTokens, Card, SectionTitle, IconDot,
} from '@/design';
import { fontFamily } from '@/design/tokens';

export default function AchievementsScreen() {
  const { palette } = useDesignTokens();
  const { t } = useTranslation();
  const profile = useAuthStore((s) => s.profile);
  const { achievements, totalPoints, setAchievements, setTotalPoints, setLoading } = useAchievementsStore();

  const loadAchievements = useCallback(async () => {
    if (!profile?.id) return;
    setLoading(true);
    try {
      const [data, points] = await Promise.all([
        getUserAchievements(profile.id),
        getTotalPoints(profile.id),
      ]);
      setAchievements(data);
      setTotalPoints(points);
    } catch (err) {
      console.error('Failed to load achievements:', err);
    } finally {
      setLoading(false);
    }
  }, [profile?.id, setAchievements, setTotalPoints, setLoading]);

  useEffect(() => { loadAchievements(); }, [loadAchievements]);

  const unlockedTypes = new Set(achievements.map((a) => a.type));
  const unlocked = ACHIEVEMENT_CONFIGS.filter((c) => unlockedTypes.has(c.type));
  const locked = ACHIEVEMENT_CONFIGS.filter((c) => !unlockedTypes.has(c.type));

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: palette.bg }}>
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 32, gap: 14 }}>
        {/* Points hero */}
        <Card tint="accent" padding={28} style={{ alignItems: 'center', borderColor: palette.accentSoft }}>
          <MaterialCommunityIcons name="trophy" size={32} color={palette.accentInk} />
          <Text style={{
            fontFamily: fontFamily.display, fontSize: 56, lineHeight: 60,
            color: palette.accentInk, marginTop: 8, letterSpacing: -1.5,
          }}>{totalPoints}</Text>
          <Text style={{
            fontFamily: fontFamily.mono, fontSize: 11, color: palette.accentInk,
            letterSpacing: 1.2, textTransform: 'uppercase', marginTop: 6,
          }}>{t('achievements.totalPoints')}</Text>
        </Card>

        {unlocked.length > 0 && (
          <>
            <SectionTitle style={{ marginTop: 8 }}>{t('achievements.unlocked')}</SectionTitle>
            {unlocked.map((config) => {
              const achievement = achievements.find((a) => a.type === config.type);
              return (
                <Card key={config.type} padding={14}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                    <IconDot icon={config.icon as keyof typeof MaterialCommunityIcons.glyphMap} variant="success" size={44} />
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontFamily: fontFamily.sansSemibold, fontSize: 14, fontWeight: '600', color: palette.text }}>
                        {t(config.titleKey)}
                      </Text>
                      <Text style={{ fontFamily: fontFamily.sans, fontSize: 12, color: palette.text2, marginTop: 2 }}>
                        {t(config.descKey)}
                      </Text>
                      {achievement && (
                        <Text style={{ fontFamily: fontFamily.mono, fontSize: 10.5, color: palette.successInk, marginTop: 4 }}>
                          {t('achievements.unlockedOn', { date: new Date(achievement.unlocked_at).toLocaleDateString() })} · {config.points} {t('achievements.pts')}
                        </Text>
                      )}
                    </View>
                    <MaterialCommunityIcons name="check-circle" size={22} color={palette.successInk} />
                  </View>
                </Card>
              );
            })}
          </>
        )}

        {locked.length > 0 && (
          <>
            <SectionTitle style={{ marginTop: 16 }}>{t('achievements.locked')}</SectionTitle>
            {locked.map((config) => (
              <Card key={config.type} padding={14} style={{ opacity: 0.65 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                  <IconDot icon={config.icon as keyof typeof MaterialCommunityIcons.glyphMap} variant="default" size={44} />
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontFamily: fontFamily.sansSemibold, fontSize: 14, fontWeight: '600', color: palette.text2 }}>
                      {t(config.titleKey)}
                    </Text>
                    <Text style={{ fontFamily: fontFamily.sans, fontSize: 12, color: palette.text2, marginTop: 2 }}>
                      {t(config.descKey)}
                    </Text>
                    <Text style={{ fontFamily: fontFamily.mono, fontSize: 10.5, color: palette.text3, marginTop: 4 }}>
                      {config.points} {t('achievements.pts')}
                    </Text>
                  </View>
                  <MaterialCommunityIcons name="lock-outline" size={20} color={palette.text3} />
                </View>
              </Card>
            ))}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

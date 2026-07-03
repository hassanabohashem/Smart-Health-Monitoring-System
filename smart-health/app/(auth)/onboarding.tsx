import { useState, useRef } from 'react';
import { View, Dimensions, FlatList, SafeAreaView, Text } from 'react-native';
import { Button } from 'react-native-paper';
import Svg, { Circle, G, Path, Rect } from 'react-native-svg';
import { useRouter } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '@/stores/auth.store';
import { useDesignTokens, Eyebrow } from '@/design';
import { fontFamily, radius } from '@/design/tokens';

type Tone = 'accent' | 'danger' | 'warning' | 'info';

interface Slide {
  /** Numbered label shown above the title — e.g. "01 · Vitals". */
  eyebrow: string;
  shape: (color: string) => React.ReactNode;
  title: string;
  description: string;
  tone: Tone;
  /** Optional per-slide override for the title font size. Defaults to 37. */
  titleSize?: number;
}

const { width } = Dimensions.get('window');

/* ──────────────────────────────────────────────────────────────────────────
 * OB shape SVGs — ported verbatim from the Claude Design source
 * (`screens/auth.jsx`), with `currentColor` swapped for the tone-ink color
 * passed in by the parent slide.
 * ────────────────────────────────────────────────────────────────────────── */

const ShapeVitals = (color: string) => (
  <Svg width={160} height={160} viewBox="0 0 160 160" fill="none">
    <Circle cx={80} cy={80} r={62} stroke={color} strokeWidth={2} opacity={0.18} />
    <Circle cx={80} cy={80} r={42} stroke={color} strokeWidth={2} opacity={0.32} />
    <Path
      d="M30 86 L60 86 L70 70 L82 100 L92 78 L102 86 L130 86"
      stroke={color}
      strokeWidth={3.5}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </Svg>
);

const ShapeSafety = (color: string) => (
  <Svg width={160} height={160} viewBox="0 0 160 160" fill="none">
    <Circle cx={80} cy={80} r={56} stroke={color} strokeWidth={2} opacity={0.18} />
    <Rect x={56} y={66} width={48} height={48} rx={10} stroke={color} strokeWidth={3} />
    <Path d="M64 90 L75 90 M85 90 L96 90" stroke={color} strokeWidth={3} strokeLinecap="round" />
    <Circle cx={80} cy={44} r={3.5} fill={color} />
    <Path d="M80 50 v8" stroke={color} strokeWidth={3} strokeLinecap="round" />
  </Svg>
);

const ShapeConnection = (color: string) => (
  <Svg width={180} height={160} viewBox="0 0 180 160" fill="none">
    <Circle cx={50} cy={80} r={22} stroke={color} strokeWidth={3} />
    <Circle cx={130} cy={80} r={22} stroke={color} strokeWidth={3} />
    <Path d="M72 80 H108" stroke={color} strokeWidth={3} strokeLinecap="round" strokeDasharray="3,6" />
    <Path d="M40 78 a10 8 0 0 1 20 0" stroke={color} strokeWidth={3} strokeLinecap="round" fill="none" />
    <Path d="M120 78 a10 8 0 0 1 20 0" stroke={color} strokeWidth={3} strokeLinecap="round" fill="none" />
  </Svg>
);

const ShapeCare = (color: string) => (
  <Svg width={160} height={160} viewBox="0 0 160 160" fill="none">
    <Circle cx={80} cy={80} r={54} stroke={color} strokeWidth={2} opacity={0.2} />
    {/* Clean closed-loop heart from the design HTML reference (no
        bottom-tail artifact). Wrapped in a <G translate> so we can
        nudge the silhouette into the visual center of the circle —
        the path's geometric center is at y≈88, but the heart's visual
        weight sits in the lobes, so we shift it ~6 down to balance. */}
    <G translateY={-2}>
      <Path
        d="M80 104 C 65 96, 56 86, 56 76 A 13 13 0 0 1 80 72 A 13 13 0 0 1 104 76 C 104 86, 95 96, 80 104 Z"
        stroke={color}
        strokeWidth={3}
        fill="none"
        strokeLinejoin="round"
      />
    </G>
  </Svg>
);

const ShapeZone = (color: string) => (
  <Svg width={160} height={160} viewBox="0 0 160 160" fill="none">
    <Circle cx={80} cy={92} r={44} stroke={color} strokeWidth={2.5} strokeDasharray="4,4" opacity={0.6} />
    <Path
      d="M80 28 c-14 0 -24 10 -24 24 c0 18 24 36 24 36 s24 -18 24 -36 c0 -14 -10 -24 -24 -24z"
      stroke={color}
      strokeWidth={3}
      fill="none"
      strokeLinejoin="round"
    />
    <Circle cx={80} cy={52} r={6} fill={color} />
  </Svg>
);

export default function OnboardingScreen() {
  const { palette } = useDesignTokens();
  const router = useRouter();
  const { t } = useTranslation();
  const setOnboardingDone = useAuthStore((s) => s.setOnboardingDone);

  const slides: Slide[] = [
    { eyebrow: t('onboarding.eyebrow1'), shape: ShapeVitals,     title: t('onboarding.title1'), description: t('onboarding.desc1'), tone: 'accent'  },
    { eyebrow: t('onboarding.eyebrow2'), shape: ShapeSafety,     title: t('onboarding.title2'), description: t('onboarding.desc2'), tone: 'danger'  },
    { eyebrow: t('onboarding.eyebrow3'), shape: ShapeConnection, title: t('onboarding.title3'), description: t('onboarding.desc3'), tone: 'accent'  },
    { eyebrow: t('onboarding.eyebrow4'), shape: ShapeCare,       title: t('onboarding.title4'), description: t('onboarding.desc4'), tone: 'warning' },
    { eyebrow: t('onboarding.eyebrow5'), shape: ShapeZone,       title: t('onboarding.title5'), description: t('onboarding.desc5'), tone: 'info'    },
  ];

  const [currentIndex, setCurrentIndex] = useState(0);
  const [navigating, setNavigating] = useState(false);
  const flatListRef = useRef<FlatList>(null);

  const handleNext = () => {
    if (currentIndex < slides.length - 1) {
      flatListRef.current?.scrollToIndex({ index: currentIndex + 1 });
      setCurrentIndex(currentIndex + 1);
    } else {
      completeOnboarding();
    }
  };

  const handleSkip = () => completeOnboarding();

  const completeOnboarding = async () => {
    if (navigating) return;
    setNavigating(true);
    await AsyncStorage.setItem('@onboarding_complete', 'true');
    setOnboardingDone(true);
    router.replace('/(auth)/login');
  };

  /** Tone-soft background + tone-ink stroke color, matching the design's
   *  `.ob-art .blob.<tone>` rules. */
  const toneColor = (tone: Tone): { bg: string; fg: string } => {
    switch (tone) {
      case 'danger':  return { bg: palette.dangerSoft,  fg: palette.dangerInk  };
      case 'warning': return { bg: palette.warningSoft, fg: palette.warningInk };
      case 'info':    return { bg: palette.infoSoft,    fg: palette.infoInk    };
      default:        return { bg: palette.accentSoft,  fg: palette.accentInk  };
    }
  };

  const renderSlide = ({ item }: { item: Slide }) => {
    const tc = toneColor(item.tone);
    return (
      <View style={{ width, flex: 1 }}>
        {/* Hero blob — 220px tone-soft circle holding the SVG shape */}
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
          <View style={{
            width: 220, height: 220, borderRadius: 999,
            backgroundColor: tc.bg,
            alignItems: 'center', justifyContent: 'center',
            overflow: 'hidden',
          }}>
            {item.shape(tc.fg)}
          </View>
        </View>

        {/* Copy block: eyebrow + Newsreader headline + grey body.
            minHeight pins the eyebrow at the same Y on every slide
            regardless of how many lines the title/description wrap to —
            slide 1's description is 3 lines, slide 2's is 2 lines, etc.
            Without this the shape blob (flex:1 above) would shrink/grow
            differently per slide and shift the copy. */}
        <View style={{
          paddingHorizontal: 28,
          paddingBottom: 8,
          minHeight: 280,
        }}>
          <Eyebrow style={{ marginBottom: 32 }}>{item.eyebrow}</Eyebrow>
          <Text style={{
            fontFamily: fontFamily.display,
            fontSize: item.titleSize ?? 37,
            lineHeight: (item.titleSize ?? 37) + 2,
            letterSpacing: -0.7,
            color: palette.text,
            marginBottom: 30,
            fontWeight: '400',
          }}>{item.title}</Text>
          <Text style={{
            fontFamily: fontFamily.sans,
            fontSize: 15,
            lineHeight: 22,
            color: palette.text2,
            marginBottom: 10,
          }}>{item.description}</Text>
        </View>
      </View>
    );
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: palette.bg }}>
      <FlatList
        ref={flatListRef}
        data={slides}
        renderItem={renderSlide}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        keyExtractor={(_, i) => i.toString()}
        onMomentumScrollEnd={(e) => {
          const index = Math.round(e.nativeEvent.contentOffset.x / width);
          setCurrentIndex(index);
        }}
      />

      {/* Page dots */}
      <View style={{ flexDirection: 'row', justifyContent: 'center', gap: 6, paddingVertical: 8 }}>
        {slides.map((_, i) => (
          <View
            key={i}
            style={{
              height: 6,
              width: i === currentIndex ? 18 : 6,
              borderRadius: 999,
              backgroundColor: i === currentIndex ? palette.accent : palette.surface3,
            }}
          />
        ))}
      </View>

      {/* Skip / Next or Begin */}
      <View style={{
        flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
        paddingHorizontal: 24, paddingBottom: 32, paddingTop: 8, gap: 12,
      }}>
        {currentIndex < slides.length - 1 ? (
          <>
            <Button mode="text" onPress={handleSkip} textColor="#000000"
              labelStyle={{ fontFamily: fontFamily.sansMedium }}>
              {t('onboarding.skip')}
            </Button>
            <Button
              mode="contained"
              onPress={handleNext}
              icon={({ color }) => (
                <Svg width={18} height={18} viewBox="0 0 24 24" fill="none">
                  <Path
                    d="M5 12h14M13 5l7 7-7 7"
                    stroke={color}
                    strokeWidth={2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </Svg>
              )}
              style={{ borderRadius: radius.md, minWidth: 110 }}
              // row-reverse so the arrow renders AFTER the label, matching
              // the design source's `Next {I.arrowR}` layout.
              contentStyle={{ height: 48, flexDirection: 'row-reverse' }}
              buttonColor={palette.accent2}
              textColor={palette.textOnAccent}
              labelStyle={{ fontFamily: fontFamily.sansSemibold, fontWeight: '600' }}
            >
              {t('common.next')}
            </Button>
          </>
        ) : (
          <Button
            mode="contained"
            onPress={handleNext}
            style={{ borderRadius: radius.md, flex: 1 }}
            contentStyle={{ height: 52 }}
            buttonColor={palette.accent2}
            textColor={palette.textOnAccent}
            labelStyle={{ fontFamily: fontFamily.sansSemibold, fontWeight: '600', fontSize: 15 }}
          >
            {t('onboarding.getStarted')}
          </Button>
        )}
      </View>
    </SafeAreaView>
  );
}

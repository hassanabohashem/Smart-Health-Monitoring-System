import { useState } from 'react';
import {
  View, KeyboardAvoidingView, Platform, SafeAreaView, Text, Pressable, ScrollView,
} from 'react-native';
import { Button, HelperText } from 'react-native-paper';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { supabase } from '@/services/supabase';
import { useDesignTokens, Banner } from '@/design';
import { fontFamily, radius } from '@/design/tokens';
import { AuthInput, AuthIcon, FieldLabel } from '@/components/AuthControls';

export default function ForgotPasswordScreen() {
  const { palette } = useDesignTokens();
  const router = useRouter();
  const { t } = useTranslation();
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);

  const handleReset = async () => {
    if (!email.trim()) {
      setError(t('auth.enterEmailRequired'));
      return;
    }
    setError('');
    setLoading(true);
    try {
      const { error: resetError } = await supabase.auth.resetPasswordForEmail(email.trim());
      if (resetError) throw resetError;
      setSent(true);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t('auth.resetEmailFailed');
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: palette.bg }}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        {/* Back button is pinned to the top — kept outside the ScrollView
            so it stays anchored even while the form is vertically centered
            below it. paddingTop matches the breathing room above the
            chevron in the design source HTML. */}
        <View style={{ paddingHorizontal: 24, paddingTop: 48 }}>
          <Pressable
            onPress={() => router.back()}
            style={({ pressed }) => ({
              alignSelf: 'flex-start',
              width: 40, height: 40, borderRadius: 999,
              alignItems: 'center', justifyContent: 'center',
              backgroundColor: palette.surface,
              borderWidth: 1,
              borderColor: palette.border,
              opacity: pressed ? 0.7 : 1,
            })}
          >
            <AuthIcon name="chevron-left" color={palette.text} size={22} />
          </Pressable>
        </View>

        <ScrollView
          contentContainerStyle={{
            flexGrow: 1,
            paddingHorizontal: 24,
            paddingTop: 0,
            paddingBottom: 24,
            gap: 20,
            justifyContent: 'center',
          }}
          keyboardShouldPersistTaps="handled"
        >
          {/* Greeting — no logo per design */}
          <View style={{ gap: 8 }}>
            <Text style={{
              fontFamily: fontFamily.display,
              fontSize: 38, lineHeight: 40,
              letterSpacing: -0.8,
              color: palette.text,
            }}>{t('auth.resetPassword')}</Text>
            <Text style={{ fontFamily: fontFamily.sans, color: palette.text2, fontSize: 14 }}>
              {t('auth.enterEmail')}
            </Text>
          </View>

          {/* Email field */}
          <View>
            <FieldLabel>{t('auth.email')}</FieldLabel>
            <AuthInput
              icon="mail"
              value={email}
              onChangeText={setEmail}
              placeholder="youssef@example.com"
              keyboardType="email-address"
              autoCapitalize="none"
              autoComplete="email"
              autoCorrect={false}
            />
          </View>

          {/* Inline success banner — sage-soft, shown after reset link sent */}
          {sent && (
            <Banner variant="success" icon="check">
              {t('auth.resetSentInline')}
            </Banner>
          )}

          {error ? <HelperText type="error" visible>{error}</HelperText> : null}

          <Button
            mode="contained"
            onPress={handleReset}
            loading={loading}
            disabled={loading}
            style={{ borderRadius: radius.pill }}
            contentStyle={{ height: 52 }}
            buttonColor={palette.accent2}
            textColor={palette.textOnAccent}
            labelStyle={{ fontFamily: fontFamily.sansSemibold, fontWeight: '600', fontSize: 15 }}
          >
            {t('auth.sendResetLink')}
          </Button>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

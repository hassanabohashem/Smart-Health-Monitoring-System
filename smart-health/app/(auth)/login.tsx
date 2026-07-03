import { useState } from 'react';
import {
  View, KeyboardAvoidingView, Platform, ScrollView, SafeAreaView, Text, Pressable,
} from 'react-native';
import { Button, HelperText } from 'react-native-paper';
import { Link } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { signIn } from '@/services/auth.service';
import { useDesignTokens } from '@/design';
import { fontFamily, radius } from '@/design/tokens';
import { AuthInput, FieldLabel } from '@/components/AuthControls';

export default function LoginScreen() {
  const { palette } = useDesignTokens();
  const { t } = useTranslation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleLogin = async () => {
    if (!email.trim() || !password.trim()) {
      setError(t('auth.fillAllFields'));
      return;
    }
    setError('');
    setLoading(true);
    try {
      await signIn(email.trim(), password);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t('auth.loginFailed');
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
        <ScrollView
          contentContainerStyle={{
            flexGrow: 1,
            paddingHorizontal: 24,
            paddingTop: 20,
            paddingBottom: 24,
            gap: 20,
            justifyContent: 'center',
          }}
          keyboardShouldPersistTaps="handled"
        >
          {/* Greeting — vertically centered with the form via the parent's
              justifyContent. Matches the no-logo treatment on Register. */}
          <View style={{ gap: 8 }}>
            <Text style={{
              fontFamily: fontFamily.display,
              fontSize: 38, lineHeight: 40,
              letterSpacing: -0.8,
              color: palette.text,
            }}>{t('auth.welcomeBack')}</Text>
            <Text style={{ fontFamily: fontFamily.sans, color: palette.text2, fontSize: 14 }}>
              {t('auth.signInToContinue')}
            </Text>
          </View>

          {/* Form — labeled fields with flat rounded inputs */}
          <View style={{ gap: 14 }}>
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
            <View>
              <FieldLabel>{t('auth.password')}</FieldLabel>
              <AuthInput
                icon="lock"
                value={password}
                onChangeText={setPassword}
                placeholder="••••••••••"
                secureToggle
                autoCapitalize="none"
                autoComplete="password"
                autoCorrect={false}
              />
              <Link href="/(auth)/forgot-password" asChild>
                <Pressable style={{ alignSelf: 'flex-end', padding: 4, marginTop: 4 }}>
                  <Text style={{
                    fontFamily: fontFamily.sansMedium,
                    color: palette.accentInk, fontSize: 12, fontWeight: '500',
                  }}>{t('auth.forgotPassword')}</Text>
                </Pressable>
              </Link>
            </View>

            {error ? <HelperText type="error" visible>{error}</HelperText> : null}
          </View>

          <Button
            mode="contained"
            onPress={handleLogin}
            loading={loading}
            disabled={loading}
            style={{ borderRadius: radius.pill }}
            contentStyle={{ height: 52 }}
            buttonColor={palette.accent2}
            textColor={palette.textOnAccent}
            labelStyle={{ fontFamily: fontFamily.sansSemibold, fontWeight: '600', fontSize: 15 }}
          >
            {t('auth.login')}
          </Button>

          {/* Footer — "New here? Create an account" */}
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
            <Text style={{ color: palette.text2, fontFamily: fontFamily.sans, fontSize: 13 }}>
              {t('auth.noAccount')}
            </Text>
            <Link href="/(auth)/register" asChild>
              <Pressable>
                <Text style={{
                  color: palette.accentInk, fontFamily: fontFamily.sansSemibold,
                  fontSize: 13, fontWeight: '600',
                }}>{t('auth.register')}</Text>
              </Pressable>
            </Link>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

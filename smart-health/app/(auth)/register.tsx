import { useState } from 'react';
import {
  View, KeyboardAvoidingView, Platform, ScrollView, SafeAreaView, Text, Pressable,
} from 'react-native';
import { Button, HelperText } from 'react-native-paper';
import { Link } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { DobCalendarDialog } from '@/components/DobCalendarDialog';
import { signUp, getProfile } from '@/services/auth.service';
import { useAuthStore } from '@/stores/auth.store';
import type { UserRole } from '@/types/user.types';
import { useDesignTokens } from '@/design';
import { fontFamily, radius } from '@/design/tokens';
import { AuthInput, AuthSegment, FieldLabel, AuthIcon } from '@/components/AuthControls';
import { PhoneInput } from '@/components/PhoneInput';
// `FieldLabel` is still used by the role pill above the form.

type Sex = 'M' | 'F';

/** Min/max bounds for the DOB picker — matches the DB CHECK
 *  constraint in 010_profile_date_of_birth.sql. */
const MIN_DOB = new Date(1900, 0, 1);
const MAX_DOB = new Date();

/** Convert a JS Date to YYYY-MM-DD (the format the profiles table expects). */
function dateToIso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

export default function RegisterScreen() {
  const { palette } = useDesignTokens();
  const { t } = useTranslation();
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [phoneValid, setPhoneValid] = useState(true);
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<UserRole>('wearer');
  const [dob, setDob] = useState<Date | null>(null);
  const [dobPickerOpen, setDobPickerOpen] = useState(false);
  const [sex, setSex] = useState<Sex>('M');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleRegister = async () => {
    if (!fullName.trim() || !email.trim() || !password.trim()) {
      setError(t('auth.fillAllFields'));
      return;
    }
    if (password.length < 6) {
      setError(t('auth.passwordMinLength'));
      return;
    }
    // Phone — required + libphonenumber-validated (same as Edit Profile).
    // PhoneInput emits "<code> <digits>"; the national part is after the space.
    const phoneDigits = phone.split(' ').slice(1).join('');
    if (!phoneDigits) {
      setError(t('auth.fillAllFields'));
      return;
    }
    if (!phoneValid) {
      setError(t('auth.phoneInvalid'));
      return;
    }
    if (!dob || dob > MAX_DOB || dob < MIN_DOB) {
      setError(t('auth.dobInvalid'));
      return;
    }
    const dobIso = dateToIso(dob);
    setError('');
    setLoading(true);
    try {
      const result = await signUp(email.trim(), password, fullName.trim(), role, dobIso, sex, phone.trim());
      if (result.user) {
        try {
          const profileData = await getProfile(result.user.id);
          useAuthStore.getState().setProfile(profileData);
        } catch {
          // Auth listener retry handles this
        }
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t('auth.registrationFailed');
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
          {/* Greeting — no logo per design source */}
          <View style={{ gap: 8 }}>
            <Text style={{
              fontFamily: fontFamily.display,
              fontSize: 38, lineHeight: 40,
              letterSpacing: -0.8,
              color: palette.text,
            }}>{t('auth.letsBegin')}</Text>
            <Text style={{ fontFamily: fontFamily.sans, color: palette.text2, fontSize: 14 }}>
              {t('auth.takeAMinute')}
            </Text>
          </View>

          {/* Role pill segmented */}
          <View>
            <FieldLabel>{t('auth.selectRole')}</FieldLabel>
            <AuthSegment<UserRole>
              value={role}
              onChange={setRole}
              options={[
                { value: 'wearer', label: t('auth.wearer'), icon: 'watch' },
                { value: 'caregiver', label: t('auth.caregiver'), icon: 'users' },
              ]}
            />
          </View>

          {/* Form — inline placeholders, no field labels per design */}
          <View style={{ gap: 12 }}>
            <AuthInput
              icon="user"
              value={fullName}
              onChangeText={setFullName}
              placeholder={t('auth.fullName')}
              autoCapitalize="words"
              autoComplete="name"
            />
            <PhoneInput
              value={phone}
              onChangeText={setPhone}
              onValidation={setPhoneValid}
              label={t('auth.phoneNumber')}
            />
            <AuthInput
              icon="mail"
              value={email}
              onChangeText={setEmail}
              placeholder={t('auth.emailAddress')}
              keyboardType="email-address"
              autoCapitalize="none"
              autoComplete="email"
              autoCorrect={false}
            />
            <AuthInput
              icon="lock"
              value={password}
              onChangeText={setPassword}
              placeholder={t('auth.password')}
              secureToggle
              autoCapitalize="none"
              autoComplete="password"
              autoCorrect={false}
            />

            <Pressable
              onPress={() => setDobPickerOpen(true)}
              style={({ pressed }) => ({
                flexDirection: 'row', alignItems: 'center', gap: 10,
                height: 52,
                backgroundColor: palette.surface,
                borderRadius: radius.md,
                borderWidth: 1, borderColor: palette.border,
                paddingHorizontal: 14,
                opacity: pressed ? 0.7 : 1,
              })}
            >
              <AuthIcon name="calendar" color={palette.text3} size={20} />
              <Text style={{
                flex: 1,
                fontFamily: fontFamily.sans, fontSize: 14,
                color: dob ? palette.text : palette.text3,
              }}>
                {dob ? dob.toLocaleDateString(undefined, { day: '2-digit', month: 'long', year: 'numeric' }) : t('auth.dobPlaceholder')}
              </Text>
            </Pressable>
            <DobCalendarDialog
              visible={dobPickerOpen}
              value={dob}
              minDate={MIN_DOB}
              maxDate={MAX_DOB}
              onPick={(d) => {
                setDob(d);
                setDobPickerOpen(false);
              }}
              onCancel={() => setDobPickerOpen(false)}
            />

            <AuthSegment<Sex>
              value={sex}
              onChange={setSex}
              options={[
                { value: 'M', label: t('auth.male'),   icon: 'male' },
                { value: 'F', label: t('auth.female'), icon: 'female' },
              ]}
            />

            {error ? <HelperText type="error" visible>{error}</HelperText> : null}
          </View>

          <Button
            mode="contained"
            onPress={handleRegister}
            loading={loading}
            disabled={loading}
            style={{ borderRadius: radius.pill }}
            contentStyle={{ height: 52 }}
            buttonColor={palette.accent2}
            textColor={palette.textOnAccent}
            labelStyle={{ fontFamily: fontFamily.sansSemibold, fontWeight: '600', fontSize: 15 }}
          >
            {t('auth.createAccount')}
          </Button>

          {/* Footer */}
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
            <Text style={{ color: palette.text2, fontFamily: fontFamily.sans, fontSize: 13 }}>
              {t('auth.hasAccount')}
            </Text>
            <Link href="/(auth)/login" asChild>
              <Pressable>
                <Text style={{
                  color: palette.accentInk, fontFamily: fontFamily.sansSemibold,
                  fontSize: 13, fontWeight: '600',
                }}>{t('auth.login')}</Text>
              </Pressable>
            </Link>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

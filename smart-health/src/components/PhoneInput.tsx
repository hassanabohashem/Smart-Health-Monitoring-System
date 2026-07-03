import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View, StyleSheet, FlatList, TouchableOpacity, Modal, TextInput as RNTextInput } from 'react-native';
import { Text, Surface, Searchbar, useTheme } from 'react-native-paper';
import { parsePhoneNumberFromString, getExampleNumber, type CountryCode } from 'libphonenumber-js/mobile';
import examples from 'libphonenumber-js/mobile/examples';
import { useDesignTokens } from '@/design';
import { fontFamily, radius } from '@/design/tokens';

interface Country {
  iso: CountryCode;
  code: string;
  flag: string;
  name: string;
}

const COUNTRIES: Country[] = [
  { iso: 'EG', code: '+20', flag: '🇪🇬', name: 'Egypt' },
  { iso: 'SA', code: '+966', flag: '🇸🇦', name: 'Saudi Arabia' },
  { iso: 'AE', code: '+971', flag: '🇦🇪', name: 'UAE' },
  { iso: 'JO', code: '+962', flag: '🇯🇴', name: 'Jordan' },
  { iso: 'LB', code: '+961', flag: '🇱🇧', name: 'Lebanon' },
  { iso: 'IQ', code: '+964', flag: '🇮🇶', name: 'Iraq' },
  { iso: 'KW', code: '+965', flag: '🇰🇼', name: 'Kuwait' },
  { iso: 'OM', code: '+968', flag: '🇴🇲', name: 'Oman' },
  { iso: 'BH', code: '+973', flag: '🇧🇭', name: 'Bahrain' },
  { iso: 'QA', code: '+974', flag: '🇶🇦', name: 'Qatar' },
  { iso: 'US', code: '+1', flag: '🇺🇸', name: 'United States' },
  { iso: 'GB', code: '+44', flag: '🇬🇧', name: 'United Kingdom' },
  { iso: 'FR', code: '+33', flag: '🇫🇷', name: 'France' },
  { iso: 'DE', code: '+49', flag: '🇩🇪', name: 'Germany' },
  { iso: 'IT', code: '+39', flag: '🇮🇹', name: 'Italy' },
  { iso: 'ES', code: '+34', flag: '🇪🇸', name: 'Spain' },
  { iso: 'IN', code: '+91', flag: '🇮🇳', name: 'India' },
  { iso: 'CN', code: '+86', flag: '🇨🇳', name: 'China' },
  { iso: 'JP', code: '+81', flag: '🇯🇵', name: 'Japan' },
  { iso: 'KR', code: '+82', flag: '🇰🇷', name: 'South Korea' },
  { iso: 'BR', code: '+55', flag: '🇧🇷', name: 'Brazil' },
  { iso: 'RU', code: '+7', flag: '🇷🇺', name: 'Russia' },
  { iso: 'AU', code: '+61', flag: '🇦🇺', name: 'Australia' },
  { iso: 'CA', code: '+1', flag: '🇨🇦', name: 'Canada' },
  { iso: 'TR', code: '+90', flag: '🇹🇷', name: 'Turkey' },
  { iso: 'NG', code: '+234', flag: '🇳🇬', name: 'Nigeria' },
  { iso: 'ZA', code: '+27', flag: '🇿🇦', name: 'South Africa' },
  { iso: 'KE', code: '+254', flag: '🇰🇪', name: 'Kenya' },
  { iso: 'MA', code: '+212', flag: '🇲🇦', name: 'Morocco' },
  { iso: 'TN', code: '+216', flag: '🇹🇳', name: 'Tunisia' },
  { iso: 'DZ', code: '+213', flag: '🇩🇿', name: 'Algeria' },
  { iso: 'SD', code: '+249', flag: '🇸🇩', name: 'Sudan' },
  { iso: 'LY', code: '+218', flag: '🇱🇾', name: 'Libya' },
];

function getPlaceholder(country: Country): string {
  try {
    const example = getExampleNumber(country.iso, examples);
    if (example) {
      return example.formatNational();
    }
  } catch {}
  return '';
}

// Get the trunk prefix for a country (e.g. '0' for Egypt/UK, '' for US)
function getTrunkPrefix(country: Country): string {
  try {
    const example = getExampleNumber(country.iso, examples);
    if (example) {
      const formatted = example.formatNational();
      const allDigits = formatted.replace(/\D/g, '');
      const trunkLen = allDigits.length - example.nationalNumber.length;
      if (trunkLen > 0) {
        return allDigits.slice(0, trunkLen);
      }
    }
  } catch {}
  return '';
}

// Get max digit length for a country (national number without trunk)
function getMaxDigits(country: Country): number {
  try {
    const example = getExampleNumber(country.iso, examples);
    if (example) {
      return example.nationalNumber.length;
    }
  } catch {}
  return 15; // fallback
}

interface PhoneInputProps {
  value: string;
  onChangeText: (fullNumber: string) => void;
  label?: string;
  onValidation?: (isValid: boolean) => void;
}

export function PhoneInput({ value, onChangeText, label, onValidation }: PhoneInputProps) {
  const theme = useTheme();
  const { palette } = useDesignTokens();
  const { t } = useTranslation();

  const getInitialCountry = () => {
    for (const country of COUNTRIES) {
      if (value.startsWith(country.code)) {
        return country;
      }
    }
    return COUNTRIES[0];
  };

  const getInitialNumber = () => {
    const country = getInitialCountry();
    return value.startsWith(country.code) ? value.slice(country.code.length).trim() : value.replace(/^\+?\d{1,3}\s?/, '');
  };

  const [selectedCountry, setSelectedCountry] = useState(getInitialCountry);
  const [rawDigits, setRawDigits] = useState(getInitialNumber);
  const [displayValue, setDisplayValue] = useState('');
  const [showPicker, setShowPicker] = useState(false);
  const [search, setSearch] = useState('');
  const [touched, setTouched] = useState(false);

  const validate = (digits: string, country: Country): boolean => {
    if (digits.length === 0) return true;
    const fullNumber = `${country.code}${digits}`;
    const parsed = parsePhoneNumberFromString(fullNumber, country.iso);
    return parsed ? parsed.isValid() : false;
  };

  const formatDigits = (digits: string, country: Country): string => {
    if (digits.length === 0) return '';

    try {
      const example = getExampleNumber(country.iso, examples);
      if (example) {
        const formatted = example.formatNational();
        const nationalDigits = example.nationalNumber;

        // Build a template: replace each digit in the national portion
        // with a placeholder, keeping all formatting chars.
        // First, figure out which digit positions are trunk vs national.
        const allFormattedDigits = formatted.replace(/\D/g, '');
        const trunkLen = allFormattedDigits.length - nationalDigits.length;

        // Build template: 'X' for national digit slots, keep formatting chars,
        // skip trunk prefix digits entirely.
        let template = '';
        let digitCount = 0;
        for (const ch of formatted) {
          if (/\d/.test(ch)) {
            digitCount++;
            if (digitCount > trunkLen) {
              template += 'X';
            }
            // skip trunk digits
          } else {
            if (digitCount >= trunkLen) {
              template += ch;
            }
            // skip formatting before/within trunk
          }
        }

        // (keep leading formatting chars like '(' for US numbers)

        // Fill user digits into template
        let result = '';
        let userIdx = 0;
        for (const ch of template) {
          if (ch === 'X') {
            if (userIdx < digits.length) {
              result += digits[userIdx++];
            } else {
              break;
            }
          } else {
            result += ch;
          }
        }

        // Trim trailing formatting chars
        return result.replace(/[\s\-\)]+$/, '');
      }
    } catch {}

    return digits;
  };

  // Update display whenever rawDigits or country changes
  useState(() => {
    setDisplayValue(formatDigits(rawDigits, selectedCountry));
  });

  const isCurrentValid = validate(rawDigits, selectedCountry);
  const showError = touched && rawDigits.length > 0 && !isCurrentValid;

  const handleNumberChange = (text: string) => {
    // Extract only digits from what the user typed
    let newDigits = text.replace(/\D/g, '');

    // Auto-strip trunk prefix if user types it (e.g. 010... → 10... for Egypt)
    const trunk = getTrunkPrefix(selectedCountry);
    if (trunk && newDigits.startsWith(trunk) && newDigits.length > trunk.length) {
      newDigits = newDigits.slice(trunk.length);
    }

    // Cap to max digits for this country
    const max = getMaxDigits(selectedCountry);
    if (newDigits.length > max) {
      newDigits = newDigits.slice(0, max);
    }

    setRawDigits(newDigits);
    const formatted = formatDigits(newDigits, selectedCountry);
    setDisplayValue(formatted);
    onChangeText(`${selectedCountry.code} ${newDigits}`);
    onValidation?.(validate(newDigits, selectedCountry));
  };

  const handleCountrySelect = (country: Country) => {
    setSelectedCountry(country);
    setShowPicker(false);
    setSearch('');
    const formatted = formatDigits(rawDigits, country);
    setDisplayValue(formatted);
    onChangeText(`${country.code} ${rawDigits}`);
    onValidation?.(validate(rawDigits, country));
  };

  const filteredCountries = search
    ? COUNTRIES.filter((c) =>
        t('phoneInput.country.' + c.iso).includes(search) ||
        c.name.toLowerCase().includes(search.toLowerCase()) ||
        c.code.includes(search)
      )
    : COUNTRIES;

  const placeholder = getPlaceholder(selectedCountry);

  // Border color matches AuthInput's palette.border by default; flips
  // to palette.danger when the parsed number fails validation.
  const fieldBorder = showError ? palette.danger : palette.border;

  return (
    <View>
      <View style={styles.row}>
        {/* Country selector — styled to match AuthInput height/border
            so the phone row visually slots between other AuthInputs. */}
        <TouchableOpacity
          style={{
            flexDirection: 'row', alignItems: 'center', gap: 4,
            height: 52,
            backgroundColor: palette.surface,
            borderWidth: 1, borderColor: fieldBorder,
            borderRadius: radius.md,
            paddingHorizontal: 12,
            minWidth: 92,
          }}
          onPress={() => setShowPicker(true)}
        >
          <Text style={styles.flag}>{selectedCountry.flag}</Text>
          <Text style={{
            color: palette.text, fontSize: 14, fontFamily: fontFamily.sans,
          }}>{selectedCountry.code}</Text>
          <Text style={{ color: palette.text3, fontSize: 10 }}>▼</Text>
        </TouchableOpacity>

        {/* Number field — RNTextInput rather than Paper's so the
            styling matches AuthInput exactly (52 px, same border,
            same font). */}
        <View style={{
          flex: 1, flexDirection: 'row', alignItems: 'center',
          height: 52,
          backgroundColor: palette.surface,
          borderWidth: 1, borderColor: fieldBorder,
          borderRadius: radius.md,
          paddingHorizontal: 16,
        }}>
          <RNTextInput
            value={displayValue}
            onChangeText={handleNumberChange}
            onBlur={() => setTouched(true)}
            keyboardType="phone-pad"
            placeholder={placeholder || label || t('phoneInput.numberPlaceholder')}
            placeholderTextColor={palette.text3}
            style={{
              flex: 1,
              fontFamily: fontFamily.sans,
              fontSize: 14,
              color: palette.text,
              padding: 0,
              paddingVertical: 0,
              textAlignVertical: 'center',
            }}
          />
        </View>
      </View>

      <Modal visible={showPicker} animationType="slide" transparent>
        <View style={styles.modalOverlay}>
          <Surface style={[styles.modalContent, { backgroundColor: theme.colors.surface }]} elevation={5}>
            <Text variant="titleMedium" style={{ fontWeight: '600', marginBottom: 12 }}>
              {t('phoneInput.selectCountry')}
            </Text>
            <Searchbar
              placeholder={t('phoneInput.searchPlaceholder')}
              value={search}
              onChangeText={setSearch}
              style={styles.searchBar}
            />
            <FlatList
              data={filteredCountries}
              keyExtractor={(item) => item.iso + item.name}
              renderItem={({ item }) => (
                <TouchableOpacity
                  style={[styles.countryRow, { borderBottomColor: theme.colors.outline + '30' }]}
                  onPress={() => handleCountrySelect(item)}
                >
                  <Text style={styles.countryFlag}>{item.flag}</Text>
                  <Text variant="bodyMedium" style={{ flex: 1, color: theme.colors.onSurface }}>{t('phoneInput.country.' + item.iso)}</Text>
                  <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant }}>{item.code}</Text>
                </TouchableOpacity>
              )}
              style={{ maxHeight: 400 }}
            />
            <TouchableOpacity
              onPress={() => { setShowPicker(false); setSearch(''); }}
              style={[styles.cancelBtn, { backgroundColor: theme.colors.surfaceVariant }]}
            >
              <Text variant="labelLarge" style={{ color: theme.colors.onSurfaceVariant, textAlign: 'center' }}>{t('common.cancel')}</Text>
            </TouchableOpacity>
          </Surface>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  countryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 16,
    borderWidth: 1,
    borderRadius: 4,
    minWidth: 90,
  },
  flag: { fontSize: 20 },
  numberInput: { flex: 1 },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-end',
  },
  modalContent: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 20,
    maxHeight: '80%',
  },
  searchBar: { marginBottom: 8 },
  countryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    paddingHorizontal: 4,
    borderBottomWidth: 1,
    gap: 12,
  },
  countryFlag: { fontSize: 24 },
  cancelBtn: {
    padding: 14,
    borderRadius: 12,
    marginTop: 12,
  },
});

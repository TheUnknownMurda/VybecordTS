/**
 * Multi-script romanization module.
 * Supports: Japanese, Korean, Chinese, Cyrillic, Greek, Thai,
 * Arabic, Devanagari (Hindi), Georgian, Armenian.
 */

import { pinyin } from 'pinyin-pro';
import { evictOldest } from './utils.js';

// ── Japanese: Hiragana & Katakana → Romaji ──

const HIRAGANA_MAP: Record<string, string> = {
  'あ': 'a', 'い': 'i', 'う': 'u', 'え': 'e', 'お': 'o',
  'か': 'ka', 'き': 'ki', 'く': 'ku', 'け': 'ke', 'こ': 'ko',
  'さ': 'sa', 'し': 'shi', 'す': 'su', 'せ': 'se', 'そ': 'so',
  'た': 'ta', 'ち': 'chi', 'つ': 'tsu', 'て': 'te', 'と': 'to',
  'な': 'na', 'に': 'ni', 'ぬ': 'nu', 'ね': 'ne', 'の': 'no',
  'は': 'ha', 'ひ': 'hi', 'ふ': 'fu', 'へ': 'he', 'ほ': 'ho',
  'ま': 'ma', 'み': 'mi', 'む': 'mu', 'め': 'me', 'も': 'mo',
  'や': 'ya', 'ゆ': 'yu', 'よ': 'yo',
  'ら': 'ra', 'り': 'ri', 'る': 'ru', 'れ': 're', 'ろ': 'ro',
  'わ': 'wa', 'ゐ': 'wi', 'ゑ': 'we', 'を': 'wo', 'ん': 'n',
  'が': 'ga', 'ぎ': 'gi', 'ぐ': 'gu', 'げ': 'ge', 'ご': 'go',
  'ざ': 'za', 'じ': 'ji', 'ず': 'zu', 'ぜ': 'ze', 'ぞ': 'zo',
  'だ': 'da', 'ぢ': 'di', 'づ': 'du', 'で': 'de', 'ど': 'do',
  'ば': 'ba', 'び': 'bi', 'ぶ': 'bu', 'べ': 'be', 'ぼ': 'bo',
  'ぱ': 'pa', 'ぴ': 'pi', 'ぷ': 'pu', 'ぺ': 'pe', 'ぽ': 'po',
  // Combo kana (yōon)
  'きゃ': 'kya', 'きゅ': 'kyu', 'きょ': 'kyo',
  'しゃ': 'sha', 'しゅ': 'shu', 'しょ': 'sho',
  'ちゃ': 'cha', 'ちゅ': 'chu', 'ちょ': 'cho',
  'にゃ': 'nya', 'にゅ': 'nyu', 'にょ': 'nyo',
  'ひゃ': 'hya', 'ひゅ': 'hyu', 'ひょ': 'hyo',
  'みゃ': 'mya', 'みゅ': 'myu', 'みょ': 'myo',
  'りゃ': 'rya', 'りゅ': 'ryu', 'りょ': 'ryo',
  'ぎゃ': 'gya', 'ぎゅ': 'gyu', 'ぎょ': 'gyo',
  'じゃ': 'ja', 'じゅ': 'ju', 'じょ': 'jo',
  'びゃ': 'bya', 'びゅ': 'byu', 'びょ': 'byo',
  'ぴゃ': 'pya', 'ぴゅ': 'pyu', 'ぴょ': 'pyo',
  // Small kana
  'ぁ': 'a', 'ぃ': 'i', 'ぅ': 'u', 'ぇ': 'e', 'ぉ': 'o',
  'っ': '', // handled specially (double consonant)
  'ゃ': 'ya', 'ゅ': 'yu', 'ょ': 'yo',
  // Long vowel mark
  'ー': '-',
};

/** Convert a Hiragana/Katakana character to its Hiragana equivalent. */
function katakanaToHiragana(ch: string): string {
  const code = ch.charCodeAt(0);
  // Katakana range: 0x30A0–0x30FF → Hiragana: 0x3040–0x309F (offset -0x60)
  if (code >= 0x30A1 && code <= 0x30F6) {
    return String.fromCharCode(code - 0x60);
  }
  // Katakana long vowel mark
  if (code === 0x30FC) return 'ー';
  return ch;
}

function romanizeJapanese(text: string): string {
  let result = '';
  // Convert all katakana to hiragana first
  const chars = [...text].map(c => katakanaToHiragana(c));
  let i = 0;
  while (i < chars.length) {
    // Try 2-char combo (yōon) first
    if (i + 1 < chars.length) {
      const pair = chars[i] + chars[i + 1];
      if (HIRAGANA_MAP[pair] !== undefined) {
        result += HIRAGANA_MAP[pair];
        i += 2;
        continue;
      }
    }

    const ch = chars[i];

    // っ (sokuon): double the next consonant
    if (ch === 'っ') {
      if (i + 1 < chars.length) {
        const nextRomaji = HIRAGANA_MAP[chars[i + 1]];
        if (nextRomaji && nextRomaji.length > 0) {
          result += nextRomaji[0]; // double the consonant
        }
      }
      i++;
      continue;
    }

    if (HIRAGANA_MAP[ch] !== undefined) {
      result += HIRAGANA_MAP[ch];
    } else {
      result += ch; // pass through non-kana (kanji, latin, etc.)
    }
    i++;
  }
  return result;
}

// ── Korean: Hangul → Revised Romanization ──

const KR_INITIALS = ['g', 'kk', 'n', 'd', 'tt', 'r', 'm', 'b', 'pp', 's', 'ss', '', 'j', 'jj', 'ch', 'k', 't', 'p', 'h'];
const KR_MEDIALS = ['a', 'ae', 'ya', 'yae', 'eo', 'e', 'yeo', 'ye', 'o', 'wa', 'wae', 'oe', 'yo', 'u', 'wo', 'we', 'wi', 'yu', 'eu', 'ui', 'i'];
const KR_FINALS = ['', 'k', 'k', 'k', 'n', 'n', 'n', 't', 'l', 'l', 'l', 'l', 'l', 'l', 'l', 'l', 'm', 'p', 'p', 't', 't', 'ng', 't', 't', 'k', 't', 'p', 't'];

function romanizeKorean(text: string): string {
  let result = '';
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    // Hangul syllable block range: 0xAC00–0xD7A3
    if (code >= 0xAC00 && code <= 0xD7A3) {
      const offset = code - 0xAC00;
      const initialIdx = Math.floor(offset / (21 * 28));
      const medialIdx = Math.floor((offset % (21 * 28)) / 28);
      const finalIdx = offset % 28;
      result += KR_INITIALS[initialIdx] + KR_MEDIALS[medialIdx] + KR_FINALS[finalIdx];
    } else {
      result += ch;
    }
  }
  return result;
}

// ── Chinese: Hanzi → Pinyin ──

const pinyinCache = new Map<string, string>();
const PINYIN_CACHE_LIMIT = 200;

function romanizeChinese(text: string): string {
  let cached = pinyinCache.get(text);
  if (cached === undefined) {
    cached = pinyin(text, { toneType: 'none', type: 'string', separator: ' ' });
    pinyinCache.set(text, cached);
    evictOldest(pinyinCache, PINYIN_CACHE_LIMIT);
  }
  return cached;
}

// ── Cyrillic → Latin (ISO 9 simplified) ──

const CYRILLIC_MAP: Record<string, string> = {
  'А': 'A', 'Б': 'B', 'В': 'V', 'Г': 'G', 'Д': 'D', 'Е': 'E', 'Ж': 'Zh', 'З': 'Z', 'И': 'I', 'Й': 'Y',
  'К': 'K', 'Л': 'L', 'М': 'M', 'Н': 'N', 'О': 'O', 'П': 'P', 'Р': 'R', 'С': 'S', 'Т': 'T', 'У': 'U',
  'Ф': 'F', 'Х': 'Kh', 'Ц': 'Ts', 'Ч': 'Ch', 'Ш': 'Sh', 'Щ': 'Shch', 'Ъ': '', 'Ы': 'Y', 'Ь': '', 'Э': 'E',
  'Ю': 'Yu', 'Я': 'Ya',
  'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'е': 'e', 'ж': 'zh', 'з': 'z', 'и': 'i', 'й': 'y',
  'к': 'k', 'л': 'l', 'м': 'm', 'н': 'n', 'о': 'o', 'п': 'p', 'р': 'r', 'с': 's', 'т': 't', 'у': 'u',
  'ф': 'f', 'х': 'kh', 'ц': 'ts', 'ч': 'ch', 'ш': 'sh', 'щ': 'shch', 'ъ': '', 'ы': 'y', 'ь': '', 'э': 'e',
  'ю': 'yu', 'я': 'ya',
  // Ukrainian extras
  'Є': 'Ye', 'є': 'ye', 'І': 'I', 'і': 'i', 'Ї': 'Yi', 'ї': 'yi', 'Ґ': 'G', 'ґ': 'g',
  // Serbian/Macedonian extras
  'Ђ': 'Dj', 'ђ': 'dj', 'Ј': 'J', 'ј': 'j', 'Љ': 'Lj', 'љ': 'lj', 'Њ': 'Nj', 'њ': 'nj',
  'Ћ': 'C', 'ћ': 'c', 'Џ': 'Dz', 'џ': 'dz',
  // Common
  'Ё': 'Yo', 'ё': 'yo',
};

function mapChars(text: string, map: Record<string, string>): string {
  const out: string[] = [];
  for (const ch of text) out.push(map[ch] ?? ch);
  return out.join('');
}

function romanizeCyrillic(text: string): string {
  return mapChars(text, CYRILLIC_MAP);
}

// ── Greek → Latin (simplified transliteration) ──

const GREEK_MAP: Record<string, string> = {
  'Α': 'A', 'Β': 'V', 'Γ': 'G', 'Δ': 'D', 'Ε': 'E', 'Ζ': 'Z', 'Η': 'I', 'Θ': 'Th', 'Ι': 'I', 'Κ': 'K',
  'Λ': 'L', 'Μ': 'M', 'Ν': 'N', 'Ξ': 'X', 'Ο': 'O', 'Π': 'P', 'Ρ': 'R', 'Σ': 'S', 'Τ': 'T', 'Υ': 'Y',
  'Φ': 'F', 'Χ': 'Ch', 'Ψ': 'Ps', 'Ω': 'O',
  'α': 'a', 'β': 'v', 'γ': 'g', 'δ': 'd', 'ε': 'e', 'ζ': 'z', 'η': 'i', 'θ': 'th', 'ι': 'i', 'κ': 'k',
  'λ': 'l', 'μ': 'm', 'ν': 'n', 'ξ': 'x', 'ο': 'o', 'π': 'p', 'ρ': 'r', 'σ': 's', 'ς': 's', 'τ': 't',
  'υ': 'y', 'φ': 'f', 'χ': 'ch', 'ψ': 'ps', 'ω': 'o',
  // Accented vowels
  'Ά': 'A', 'Έ': 'E', 'Ή': 'I', 'Ί': 'I', 'Ό': 'O', 'Ύ': 'Y', 'Ώ': 'O',
  'ά': 'a', 'έ': 'e', 'ή': 'i', 'ί': 'i', 'ό': 'o', 'ύ': 'y', 'ώ': 'o',
  'ϊ': 'i', 'ϋ': 'y', 'ΐ': 'i', 'ΰ': 'y',
};

function romanizeGreek(text: string): string {
  return mapChars(text, GREEK_MAP);
}

// ── Thai → Latin (RTGS-inspired approximation) ──

const THAI_CONSONANTS: Record<string, string> = {
  'ก': 'k', 'ข': 'kh', 'ฃ': 'kh', 'ค': 'kh', 'ฅ': 'kh', 'ฆ': 'kh', 'ง': 'ng', 'จ': 'ch', 'ฉ': 'ch', 'ช': 'ch',
  'ซ': 's', 'ฌ': 'ch', 'ญ': 'y', 'ฎ': 'd', 'ฏ': 't', 'ฐ': 'th', 'ฑ': 'th', 'ฒ': 'th', 'ณ': 'n', 'ด': 'd',
  'ต': 't', 'ถ': 'th', 'ท': 'th', 'ธ': 'th', 'น': 'n', 'บ': 'b', 'ป': 'p', 'ผ': 'ph', 'ฝ': 'f', 'พ': 'ph',
  'ฟ': 'f', 'ภ': 'ph', 'ม': 'm', 'ย': 'y', 'ร': 'r', 'ฤ': 'rue', 'ล': 'l', 'ฦ': 'lue', 'ว': 'w', 'ศ': 's',
  'ษ': 's', 'ส': 's', 'ห': 'h', 'ฬ': 'l', 'อ': 'o', 'ฮ': 'h',
};

const THAI_VOWELS: Record<string, string> = {
  'ะ': 'a', 'ั': 'a', 'า': 'a', 'ำ': 'am', 'ิ': 'i', 'ี': 'i', 'ึ': 'ue', 'ื': 'ue',
  'ุ': 'u', 'ู': 'u', 'เ': 'e', 'แ': 'ae', 'โ': 'o', 'ใ': 'ai', 'ไ': 'ai',
  'ๅ': 'a', '็': '', '่': '', '้': '', '๊': '', '๋': '', '์': '', 'ํ': '',
};

const THAI_DIGITS: Record<string, string> = {
  '๐': '0', '๑': '1', '๒': '2', '๓': '3', '๔': '4',
  '๕': '5', '๖': '6', '๗': '7', '๘': '8', '๙': '9',
};

const THAI_ALL: Record<string, string> = { ...THAI_CONSONANTS, ...THAI_VOWELS, ...THAI_DIGITS };

function romanizeThai(text: string): string {
  return mapChars(text, THAI_ALL);
}

// ── Arabic → Latin (simplified transliteration) ──

const ARABIC_MAP: Record<string, string> = {
  'ء': "'", 'آ': 'a', 'أ': 'a', 'ؤ': 'w', 'إ': 'i', 'ئ': 'y', 'ا': 'a', 'ب': 'b', 'ة': 'h', 'ت': 't',
  'ث': 'th', 'ج': 'j', 'ح': 'h', 'خ': 'kh', 'د': 'd', 'ذ': 'dh', 'ر': 'r', 'ز': 'z', 'س': 's', 'ش': 'sh',
  'ص': 's', 'ض': 'd', 'ط': 't', 'ظ': 'z', 'ع': "'", 'غ': 'gh', 'ـ': '', 'ف': 'f', 'ق': 'q', 'ك': 'k',
  'ل': 'l', 'م': 'm', 'ن': 'n', 'ه': 'h', 'و': 'w', 'ى': 'a', 'ي': 'y',
  // Diacritics (harakat)
  'ً': 'an', 'ٌ': 'un', 'ٍ': 'in', 'َ': 'a', 'ُ': 'u', 'ِ': 'i', 'ّ': '', 'ْ': '',
  // Lam-Alef
  'ﻼ': 'la', 'ﻻ': 'la',
  // Persian/Urdu extras
  'پ': 'p', 'چ': 'ch', 'ژ': 'zh', 'گ': 'g', 'ک': 'k',
};

function romanizeArabic(text: string): string {
  return mapChars(text, ARABIC_MAP);
}

// ── Devanagari (Hindi/Sanskrit) → IAST-inspired Latin ──

const DEVANAGARI_MAP: Record<string, string> = {
  // Vowels
  'अ': 'a', 'आ': 'aa', 'इ': 'i', 'ई': 'ii', 'उ': 'u', 'ऊ': 'uu', 'ऋ': 'ri', 'ए': 'e', 'ऐ': 'ai', 'ओ': 'o', 'औ': 'au',
  // Vowel signs (matras)
  'ा': 'aa', 'ि': 'i', 'ी': 'ii', 'ु': 'u', 'ू': 'uu', 'ृ': 'ri', 'े': 'e', 'ै': 'ai', 'ो': 'o', 'ौ': 'au',
  // Consonants (inherent 'a')
  'क': 'ka', 'ख': 'kha', 'ग': 'ga', 'घ': 'gha', 'ङ': 'nga',
  'च': 'cha', 'छ': 'chha', 'ज': 'ja', 'झ': 'jha', 'ञ': 'nya',
  'ट': 'ta', 'ठ': 'tha', 'ड': 'da', 'ढ': 'dha', 'ण': 'na',
  'त': 'ta', 'थ': 'tha', 'द': 'da', 'ध': 'dha', 'न': 'na',
  'प': 'pa', 'फ': 'pha', 'ब': 'ba', 'भ': 'bha', 'म': 'ma',
  'य': 'ya', 'र': 'ra', 'ल': 'la', 'व': 'va', 'श': 'sha', 'ष': 'sha', 'स': 'sa', 'ह': 'ha',
  // Virama (halant) — strips inherent vowel
  '्': '',
  // Anusvara, Visarga, Chandrabindu
  'ं': 'n', 'ः': 'h', 'ँ': 'n',
  // Nukta consonants
  'क़': 'qa', 'ख़': 'khha', 'ग़': 'ghha', 'ज़': 'za', 'ड़': 'dda', 'ढ़': 'rha', 'फ़': 'fa', 'य़': 'ya',
};

function romanizeDevanagari(text: string): string {
  let result = '';
  const chars = [...text];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const mapped = DEVANAGARI_MAP[ch];
    if (mapped !== undefined) {
      // If this is a consonant (ends with 'a') and next is a vowel sign or virama, strip the inherent 'a'
      if (mapped.length >= 2 && mapped.endsWith('a') && i + 1 < chars.length) {
        const next = chars[i + 1];
        const nextCode = next.charCodeAt(0);
        // Vowel signs: 0x093E-0x094C, Virama: 0x094D
        if (nextCode >= 0x093E && nextCode <= 0x094D) {
          result += mapped.slice(0, -1); // strip inherent 'a'
          continue;
        }
      }
      result += mapped;
    } else {
      result += ch;
    }
  }
  return result;
}

// ── Georgian → Latin (national transliteration) ──

const GEORGIAN_MAP: Record<string, string> = {
  'ა': 'a', 'ბ': 'b', 'გ': 'g', 'დ': 'd', 'ე': 'e', 'ვ': 'v', 'ზ': 'z', 'თ': 't', 'ი': 'i', 'კ': 'k',
  'ლ': 'l', 'მ': 'm', 'ნ': 'n', 'ო': 'o', 'პ': 'p', 'ჟ': 'zh', 'რ': 'r', 'ს': 's', 'ტ': 't', 'უ': 'u',
  'ფ': 'p', 'ქ': 'k', 'ღ': 'gh', 'ყ': 'q', 'შ': 'sh', 'ჩ': 'ch', 'ც': 'ts', 'ძ': 'dz', 'წ': 'ts', 'ჭ': 'ch',
  'ხ': 'kh', 'ჯ': 'j', 'ჰ': 'h',
};

function romanizeGeorgian(text: string): string {
  return mapChars(text, GEORGIAN_MAP);
}

// ── Armenian → Latin (simplified transliteration) ──

const ARMENIAN_MAP: Record<string, string> = {
  'Ա': 'A', 'Բ': 'B', 'Գ': 'G', 'Դ': 'D', 'Ե': 'E', 'Զ': 'Z', 'Է': 'E', 'Ը': 'Y', 'Թ': 'T', 'Ժ': 'Zh',
  'Ի': 'I', 'Լ': 'L', 'Խ': 'Kh', 'Ծ': 'Ts', 'Կ': 'K', 'Հ': 'H', 'Ձ': 'Dz', 'Ղ': 'Gh', 'Ճ': 'Ch', 'Մ': 'M',
  'Յ': 'Y', 'Ն': 'N', 'Շ': 'Sh', 'Ո': 'Vo', 'Չ': 'Ch', 'Պ': 'P', 'Ջ': 'J', 'Ռ': 'R', 'Ս': 'S', 'Վ': 'V',
  'Տ': 'T', 'Ր': 'R', 'Ց': 'Ts', 'Ւ': 'V', 'Փ': 'P', 'Ք': 'K', 'Օ': 'O', 'Ֆ': 'F',
  'ա': 'a', 'բ': 'b', 'գ': 'g', 'դ': 'd', 'ե': 'e', 'զ': 'z', 'է': 'e', 'ը': 'y', 'թ': 't', 'ժ': 'zh',
  'ի': 'i', 'լ': 'l', 'խ': 'kh', 'ծ': 'ts', 'կ': 'k', 'հ': 'h', 'ձ': 'dz', 'ղ': 'gh', 'ճ': 'ch', 'մ': 'm',
  'յ': 'y', 'ն': 'n', 'շ': 'sh', 'ո': 'vo', 'չ': 'ch', 'պ': 'p', 'ջ': 'j', 'ռ': 'r', 'ս': 's', 'վ': 'v',
  'տ': 't', 'ր': 'r', 'ց': 'ts', 'ւ': 'v', 'փ': 'p', 'ք': 'k', 'օ': 'o', 'ֆ': 'f',
  'և': 'ev', // և ligature
};

function romanizeArmenian(text: string): string {
  return mapChars(text, ARMENIAN_MAP);
}

// ── Detection helpers ──

const JP_REGEX = /[\u3040-\u309F\u30A0-\u30FF]/;  // Hiragana or Katakana
const KR_REGEX = /[\uAC00-\uD7A3]/;                 // Hangul syllable blocks
const ZH_REGEX = /[\u4E00-\u9FFF\u3400-\u4DBF\uF900-\uFAFF]/; // CJK Unified
const CY_REGEX = /[\u0400-\u04FF]/;                 // Cyrillic
const GR_REGEX = /[\u0370-\u03FF\u1F00-\u1FFF]/;   // Greek + Extended Greek
const TH_REGEX = /[\u0E00-\u0E7F]/;                 // Thai
const AR_REGEX = /[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/; // Arabic + extensions
const DV_REGEX = /[\u0900-\u097F]/;                 // Devanagari
const KA_REGEX = /[\u10A0-\u10FF]/;                 // Georgian
const HY_REGEX = /[\u0530-\u058F]/;                 // Armenian

type ScriptId = 'jp' | 'kr' | 'zh' | 'cy' | 'gr' | 'th' | 'ar' | 'dv' | 'ka' | 'hy';

const SCRIPT_TESTS: [RegExp, ScriptId][] = [
  [JP_REGEX, 'jp'], [KR_REGEX, 'kr'], [ZH_REGEX, 'zh'],
  [CY_REGEX, 'cy'], [GR_REGEX, 'gr'], [TH_REGEX, 'th'],
  [AR_REGEX, 'ar'], [DV_REGEX, 'dv'], [KA_REGEX, 'ka'], [HY_REGEX, 'hy'],
];

function detectChar(ch: string): ScriptId | null {
  for (const [re, id] of SCRIPT_TESTS) {
    if (re.test(ch)) return id;
  }
  return null;
}

/** Detect if text contains Japanese kana. */
export function hasJapanese(text: string): boolean { return JP_REGEX.test(text); }
/** Detect if text contains Korean Hangul. */
export function hasKorean(text: string): boolean { return KR_REGEX.test(text); }
/** Detect if text contains Chinese Hanzi. */
export function hasChinese(text: string): boolean { return ZH_REGEX.test(text); }

// Fast pre-check: if all chars are below U+0370 (Basic Latin + Latin Extended + IPA + Spacing Modifiers),
// no romanizable script is present — skip all 10 regex tests.
const LATIN_UPPER = 0x0370;

/** Detect if text contains any non-Latin script we can romanize. */
export function needsRomanization(text: string): boolean {
  // Fast path: scan for any char above the Latin range
  let hasHigh = false;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) >= LATIN_UPPER) { hasHigh = true; break; }
  }
  if (!hasHigh) return false;

  for (const [re] of SCRIPT_TESTS) {
    if (re.test(text)) return true;
  }
  return false;
}

/**
 * Romanize a text string. Auto-detects all supported scripts.
 * Returns the original text if no romanizable characters are found.
 * For mixed text, only the non-Latin portions are romanized.
 */
export function romanize(text: string): string {
  if (!needsRomanization(text)) return text;

  // Pure Chinese (no kana, no hangul) — use pinyin for the whole string
  // (pinyin-pro handles contextual disambiguation better on full sentences)
  if (ZH_REGEX.test(text) && !JP_REGEX.test(text) && !KR_REGEX.test(text)) {
    // Check if text also has other scripts mixed in
    const hasOther = CY_REGEX.test(text) || GR_REGEX.test(text) || TH_REGEX.test(text) ||
      AR_REGEX.test(text) || DV_REGEX.test(text) || KA_REGEX.test(text) || HY_REGEX.test(text);
    if (!hasOther) return romanizeChinese(text);
  }

  let result = '';
  let buffer = '';
  let bufferLang: ScriptId | null = null;

  for (const ch of text) {
    const lang = detectChar(ch);

    if (lang && lang === bufferLang) {
      buffer += ch;
    } else {
      if (buffer) {
        result += flushBuffer(buffer, bufferLang);
      }
      buffer = ch;
      bufferLang = lang;
    }
  }

  if (buffer) {
    result += flushBuffer(buffer, bufferLang);
  }

  return result;
}

function flushBuffer(buffer: string, lang: ScriptId | null): string {
  switch (lang) {
    case 'jp': return romanizeJapanese(buffer);
    case 'kr': return romanizeKorean(buffer);
    case 'zh': return romanizeChinese(buffer);
    case 'cy': return romanizeCyrillic(buffer);
    case 'gr': return romanizeGreek(buffer);
    case 'th': return romanizeThai(buffer);
    case 'ar': return romanizeArabic(buffer);
    case 'dv': return romanizeDevanagari(buffer);
    case 'ka': return romanizeGeorgian(buffer);
    case 'hy': return romanizeArmenian(buffer);
    default:   return buffer;
  }
}

/**
 * Romanize an array of lyric lines (returns a new array with romanized text).
 * Only processes lines that contain non-Latin characters from supported scripts.
 */
export function romanizeLyrics(lines: { time: number; text: string }[]): { time: number; text: string; original?: string }[] {
  return lines.map(line => {
    if (!line.text || !needsRomanization(line.text)) return line;
    return { ...line, original: line.text, text: romanize(line.text) };
  });
}

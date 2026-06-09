/**
 * Shared regex constants for cleaning track titles and artist names.
 * Used across multiple sources (YouTube, Desktop SMTC, Provider).
 */

// Artist name handling
export const RE_ARTIST_SPLIT = /[,&]/;

// Artist/track suffixes to strip
export const RE_TOPIC_SUFFIX = /\s*-\s*Topic\s*$/i;
export const RE_VIDEO_SUFFIX = /\s*[([]*(?:official\s+(?:music\s+)?video|official\s+audio|official\s+lyric\s+video|music\s+video|lyric\s+video|official\s+visualizer|visualizer|official|audio|lyrics|with\s+lyrics|mv|m\/v|4k|hd|hq)[)\]]*\s*$/i;
export const RE_UNRELEASED = /\s*[[(]\s*unreleased\s*\*?\s*[\])]\s*/gi;

// Version/remix suffixes
export const RE_VERSION_SUFFIX = /\s*[-–]\s*(Long Version|Extended Version|Extended|Radio Edit|Radio|Remastered|Deluxe|Deluxe Edition|Bonus Track|Acoustic|Live|Demo|Instrumental|Clean|Explicit|Edit|Mix|Remix|Version|Slowed|Sped Up|Reverb|Nightcore|Daycore|Bass Boosted|8D Audio|Lo-?fi)\s*$/i;
export const RE_BRACKET_TAG = /\s*[(\[](slowed|sped up|reverb|slowed \+ reverb|nightcore|daycore|bass boosted|8d(?: audio)?|lo-?fi|remix|acoustic|live|official audio|official video|official music video|music video|lyric video|official lyric video|official visualizer|visualizer|lyrics|with lyrics|audio|mv|m\/v|4k|hd|hq|clean|explicit|prod\.?\s+[^)\]]*|ft\.?\s+[^)\]]*)[)\]]/gi;
export const RE_FEAT = /\s*\(?\s*feat\.?\s.*$/i;

// SoundCloud / web noise patterns
export const RE_SC_TAGS = /\s*[\[({]\s*(?:free\s*(?:dl|download)?|exclusive|premiere|leak(?:ed)?|unreleas(?:ed)?|snippet|preview|repost|type\s+beat|instrumental|bonus|deluxe|slowed\s*\+?\s*reverb|sped\s+up|chopped\s+(?:and|&|n)\s+screwed|bass\s+boosted|8d\s*audio|lo-?fi|remix|bootleg|flip|edit|cover|reprod|remake)\s*[\])}]/gi;
export const RE_HASHTAGS = /#\w+/g;
export const RE_EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}]/gu;
export const RE_TYPE_BEAT = /\s*(?:type\s+beat|type\s+instrumental).*$/i;
export const RE_PROD_TAG = /\s*[\[(]?(?:prod\.?|produced\s+by)\s+[^\])]*[\])]?/gi;

// ── Shared title parsing functions ──

const BROWSER_SEPARATORS = [' - ', ' – ', ' — ', ' | '];
const SC_SEPARATORS = [' - ', ' – ', ' — ', ' // ', ' | '];
const RE_SC_PROD = /\s*[\[(](?:prod\.?|produced\s+by)\s*.+[\])]\s*$/i;

/**
 * Parse browser-style titles (YouTube, etc.) where format is "Artist - Track".
 * Returns [track, artist].
 */
export function parseBrowserTitle(title: string, fallbackArtist: string): [track: string, artist: string] {
  for (const sep of BROWSER_SEPARATORS) {
    const idx = title.indexOf(sep);
    if (idx > 0) {
      const left = title.slice(0, idx).trim();
      const right = title.slice(idx + sep.length).trim();
      if (left && right) {
        return [right, left];
      }
    }
  }
  return [title, fallbackArtist.replace(RE_TOPIC_SUFFIX, '').trim()];
}

/**
 * Parse SoundCloud-style titles with additional separator variants.
 * Strips producer tags before parsing.
 * Returns [track, artist].
 */
export function parseSoundCloudTitle(title: string, fallbackArtist: string): [track: string, artist: string] {
  let cleaned = title.replace(RE_SC_PROD, '').trim();

  for (const sep of SC_SEPARATORS) {
    const idx = cleaned.indexOf(sep);
    if (idx > 0) {
      const left = cleaned.slice(0, idx).trim();
      const right = cleaned.slice(idx + sep.length).trim();
      if (left && right) {
        return [right, left];
      }
    }
  }
  return [cleaned || title, fallbackArtist.replace(RE_TOPIC_SUFFIX, '').trim()];
}

/**
 * Clean media titles by removing video suffixes and unreleased tags.
 * Handles repeated suffix removal (up to 3 iterations).
 */
export function cleanMediaTitle(title: string): string {
  let cleaned = title.replace(/\s*\/\/\s*/g, ' - ').trim();
  cleaned = cleaned.replace(RE_UNRELEASED, ' ').trim();
  for (let i = 0; i < 3; i++) {
    const result = cleaned.replace(RE_VIDEO_SUFFIX, '').replace(/[\s\-–—|]+$/, '');
    if (result === cleaned) break;
    cleaned = result;
  }
  return cleaned || title;
}

/**
 * Clean SoundCloud titles by removing producer tags and normalizing spaces.
 */
export function cleanSoundCloudTitle(title: string): string {
  let cleaned = title.replace(RE_SC_PROD, '').trim();
  cleaned = cleaned.replace(/\s{2,}/g, ' ').trim();
  return cleaned || title;
}

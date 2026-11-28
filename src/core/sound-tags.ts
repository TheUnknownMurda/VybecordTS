/**
 * The sound tags in YouTube captions, which are not words anyone says.
 *
 * YouTube's speech recognition writes "[Music]", "[Applause]" or "[Laughter]"
 * for everything that is not speech, in the caption's own language
 * ("[Musique]", "[Música]", "[Musik]", "[音楽]"), and people writing captions
 * by hand do the same ("[MUSIC PLAYING]", "[Chorus]") and wrap sung lines in
 * notes ("♪ We're no strangers ♪"). Only a cue that was nothing but a tag used
 * to be dropped, so a tag sharing a cue with words reached the card: the real
 * log has "[music] with 18 firearms, all of which" on a YouTube video.
 *
 * Any bracketed run with a letter in it goes, rather than a list of known
 * tags: the list would have to follow every language YouTube recognises,
 * and a caption has no other use for square brackets. The letter is what
 * keeps "[ __ ]", YouTube's own mark for a word it bleeped, which says
 * something was said there.
 */

const RE_NOTES = /[♩♪♫♬🎵🎶]/gu;
const RE_TAG = /\[[^[\]]*\p{L}[^[\]]*\]/gu;
/** What a tag made only of notes ("[♪♪♪]") leaves once the notes are gone. */
const RE_EMPTY_BRACKETS = /\[\s*\]/g;

/** A caption line without its sound tags and notes; '' when that was all it held. */
export function stripSoundTags(text: string): string {
  return text
    .replace(RE_NOTES, ' ')
    .replace(RE_TAG, ' ')
    .replace(RE_EMPTY_BRACKETS, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

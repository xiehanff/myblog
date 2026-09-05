const EN_SENTENCE_END = /[.!?…]["'’”）)\]}]*$/u
const CN_SENTENCE_END = /[。！？!?…]["'’”）)\]}》】]*$/u
const NEW_SPEAKER = /^\s*[-–—]\s*/u
const SPEAKER_SEPARATOR = /\s+[-–—]\s*/u
const LATIN_TEXT = /\p{Script=Latin}/u

const MAX_GROUP_LINES = 5
const MAX_GROUP_ENGLISH_CHARS = 320

function hasEnglishSentenceEnd(text = '') {
  return EN_SENTENCE_END.test(text.trim())
}

function hasChineseSentenceEnd(text = '') {
  return CN_SENTENCE_END.test(text.trim())
}

function cleanEnglish(text = '') {
  return text.replace(/\s+/g, ' ').trim()
}

function cleanChinese(text = '') {
  return text.replace(/\s+/g, ' ').trim()
}

function chineseTerminalFromEnglish(english = '') {
  const text = english.trim()
  if (/\?$/.test(text)) return '？'
  if (/!$/.test(text)) return '！'
  if (/\.$/.test(text)) return '。'
  return ''
}

function joinChinese(parts, english) {
  const fragments = parts.map(cleanChinese).filter(Boolean)
  let result = ''

  for (const fragment of fragments) {
    if (!result) {
      result = fragment
      continue
    }

    const previousEndsWithPunctuation = /[，。！？!?…：；;,.]["'’”）)\]}》】]*$/u.test(result)
    const fragmentStartsWithPunctuation = /^[，。！？!?…：；;,.]/u.test(fragment)
    const fragmentStartsWithSpeaker = NEW_SPEAKER.test(fragment)

    if (previousEndsWithPunctuation || fragmentStartsWithPunctuation || fragmentStartsWithSpeaker) {
      result += ` ${fragment}`
    } else {
      result += `，${fragment}`
    }
  }

  if (result && !hasChineseSentenceEnd(result)) {
    result += chineseTerminalFromEnglish(english)
  }

  return result
}

function shouldBreakBefore(group, next) {
  if (!group.length) return false

  const last = group[group.length - 1]
  if (!last.en || !next.en) return true
  if (NEW_SPEAKER.test(next.en)) return true
  if (group.length >= MAX_GROUP_LINES) return true

  const englishLength = group.reduce((sum, item) => sum + cleanEnglish(item.en).length, 0)
  return englishLength + cleanEnglish(next.en).length > MAX_GROUP_ENGLISH_CHARS
}

function buildGroup(group) {
  const english = group.map(item => cleanEnglish(item.en)).filter(Boolean).join(' ')
  const chinese = joinChinese(group.map(item => item.cn), english)

  return {
    en: english,
    cn: chinese,
    sourceCount: group.length,
  }
}

function isContextualDialogue(item) {
  return Boolean(item.en && LATIN_TEXT.test(item.en))
}

function splitSpeakerText(text = '') {
  const cleaned = text.trim()
  if (!NEW_SPEAKER.test(cleaned)) return [cleaned]

  return cleaned
    .replace(NEW_SPEAKER, '')
    .split(SPEAKER_SEPARATOR)
    .map(part => part.trim())
    .filter(Boolean)
}

function splitSpeakerCaption(item) {
  const englishParts = splitSpeakerText(item.en)
  if (englishParts.length <= 1) return [item]

  const chineseParts = splitSpeakerText(item.cn)
  if (chineseParts.length !== englishParts.length) return [item]

  return englishParts.map((en, index) => ({
    en,
    cn: chineseParts[index] || '',
  }))
}

/**
 * ASS subtitles are timed for screen readability, not sentence alignment.
 * A Chinese translator may move a clause to the previous/next subtitle frame
 * to keep natural Chinese word order. Treating every timed frame as an
 * independent translation therefore creates false EN/CN mismatches.
 *
 * This groups adjacent frames into complete contextual utterances so the
 * English meaning and Chinese translation correspond at the sentence level.
 */
export function contextualizeDialogues(dialogues = []) {
  const result = []
  let group = []

  const flush = () => {
    if (!group.length) return
    result.push(buildGroup(group))
    group = []
  }

  for (const raw of dialogues) {
    const item = {
      en: cleanEnglish(raw?.en || ''),
      cn: cleanChinese(raw?.cn || ''),
    }

    if (!item.en && !item.cn) continue

    // End-credit cards and metadata reuse the subtitle fields but often put
    // Chinese descriptions in `en`. They are not timed English utterances and
    // must remain one row per source record instead of being sentence-grouped.
    if (!isContextualDialogue(item)) {
      flush()
      result.push(buildGroup([item]))
      continue
    }

    // A single timed caption can contain two speakers. Split aligned EN/CN
    // clauses first so the first clause may complete the previous sentence,
    // while the next speaker starts a fresh contextual group.
    const speakerParts = splitSpeakerCaption(item)
    for (let index = 0; index < speakerParts.length; index += 1) {
      const part = speakerParts[index]

      if (index > 0) flush()
      if (shouldBreakBefore(group, part)) flush()
      group.push(part)

      if (hasEnglishSentenceEnd(part.en) || (!part.en && hasChineseSentenceEnd(part.cn))) {
        flush()
      }
    }
  }

  flush()
  return result
}

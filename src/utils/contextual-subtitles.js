const EN_SENTENCE_END = /[.!?…]["'’”）)\]}]*$/u
const CN_SENTENCE_END = /[。！？!?…]["'’”）)\]}》】]*$/u
const NEW_SPEAKER = /^\s*[-–—]\s+/u

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

    if (shouldBreakBefore(group, item)) flush()
    group.push(item)

    if (hasEnglishSentenceEnd(item.en) || (!item.en && hasChineseSentenceEnd(item.cn))) {
      flush()
    }
  }

  flush()
  return result
}

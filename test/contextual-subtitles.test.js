import test from 'node:test'
import assert from 'node:assert/strict'
import { contextualizeDialogues } from '../src/utils/contextual-subtitles.js'

test('joins a dashed continuation to the unfinished previous sentence and splits the next speaker', () => {
  const result = contextualizeDialogues([
    {
      cn: '奥托·海塔尔是一个值得尊敬的人',
      en: 'Otto Hightower is a more honorable man',
    },
    {
      cn: '- 你这辈子也赶不上 - 他没有保护你',
      en: "- than you could ever be. - He doesn't protect you.",
    },
  ])

  assert.equal(result.length, 2)
  assert.equal(
    result[0].en,
    'Otto Hightower is a more honorable man than you could ever be.',
  )
  assert.equal(result[0].sourceCount, 2)
  assert.equal(result[1].en, "He doesn't protect you.")
  assert.equal(result[1].sourceCount, 1)
})

test('lets the second speaker continue into the next timed frame', () => {
  const result = contextualizeDialogues([
    {
      cn: '- 现在让他们回去…… - 比武大会将持续',
      en: '- To turn them back now... - The tourney will take',
    },
    {
      cn: '大半个星期',
      en: 'the better part of a week.',
    },
  ])

  assert.equal(result.length, 2)
  assert.equal(result[0].en, 'To turn them back now...')
  assert.equal(result[1].en, 'The tourney will take the better part of a week.')
  assert.equal(result[1].sourceCount, 2)
})

test('keeps non-dialogue credit rows separate', () => {
  const result = contextualizeDialogues([
    {
      cn: '科利斯·瓦列利安',
      en: '“海蛇”“潮汛之主”',
    },
    {
      cn: '兰娜尔·瓦列利安（AC100- ）',
      en: '科利斯和雷妮丝的女儿',
    },
    {
      cn: '雷妮丝',
      en: '“无冕女王” 韦赛里斯一世的堂姐',
    },
  ])

  assert.equal(result.length, 3)
  assert.deepEqual(result.map(item => item.sourceCount), [1, 1, 1])
  assert.deepEqual(result.map(item => item.cn), [
    '科利斯·瓦列利安',
    '兰娜尔·瓦列利安（AC100- ）',
    '雷妮丝',
  ])
})

test('still merges ordinary timed fragments into a complete sentence', () => {
  const result = contextualizeDialogues([
    {
      cn: '坦格利安王朝的第一个世纪',
      en: 'As the first century of the Targaryen dynasty',
    },
    {
      cn: '已近尾声',
      en: 'came to a close',
    },
    {
      cn: '人瑞王杰赫里斯一世的身体状况每况愈下',
      en: 'the health of the Old King, Jaehaerys, was failing.',
    },
  ])

  assert.equal(result.length, 1)
  assert.equal(result[0].sourceCount, 3)
  assert.equal(
    result[0].en,
    'As the first century of the Targaryen dynasty came to a close the health of the Old King, Jaehaerys, was failing.',
  )
})

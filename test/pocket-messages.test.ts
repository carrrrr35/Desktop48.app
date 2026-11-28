import type { PocketConversation, PocketDirectMessage, PocketMessagePage } from '@preload/ipc-contract'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getConversationMessages, getConversations } from '../src/main/pocket48/pocket-message-api'
import { usePocketMessages } from '../src/renderer/src/composables/use-pocket-messages'

const core = vi.hoisted(() => ({
  getToken: vi.fn(),
  postPocket: vi.fn(),
  isEnvelopeOk: (result: { status: number }) => result.status === 200,
  throwAuthExpired: vi.fn(() => { throw new Error('登录已过期') }),
  TOKEN_INVALID_STATUSES: new Set([401003]),
}))

vi.mock('../src/main/pocket48/pocket-auth-core', () => core)
vi.mock('@renderer/stores/pocket-auth', () => ({ pocketAuthErrorMessage: (error: Error) => error.message }))

const conversation: PocketConversation = {
  id: '100',
  targetUserId: '200',
  name: '示例用户',
  avatar: '/avatar.jpg',
  preview: '你好',
  timestamp: 123456,
  unreadCount: 2,
}
const message: PocketDirectMessage = {
  id: '500',
  senderId: '200',
  senderName: '示例用户',
  senderIsClub: false,
  text: '你好',
  image: '',
  timestamp: 123456,
}

beforeEach(() => {
  vi.clearAllMocks()
  core.getToken.mockReturnValue('test-session')
})
afterEach(() => vi.unstubAllGlobals())

describe('消息页签的只读接口', () => {
  it('按 APK 分页加载会话和聊天记录，映射文本与图片', async () => {
    core.postPocket.mockResolvedValueOnce({ status: 200, content: {
      data: [{
        conversationId: 100,
        user: { userId: 200, nickname: conversation.name, avatar: conversation.avatar },
        newestMessage: '你好',
        newestMessagetime: 123456,
        noreadNum: 2,
      }],
      lastTime: 250,
    } })
    core.postPocket.mockResolvedValueOnce({ status: 200, content: {
      data: [
        { messageId: 500, userId: 200, user: { userId: 200, nickName: message.senderName }, timestamp: 123456, messageType: 'TEXT', content: { text: '你好' } },
        { messageId: '501', userId: '200', timestamp: 123400, messageType: 'IMAGE', content: { image: '/test.jpg' } },
      ],
      lastTime: 200,
    } })
    await expect(getConversations()).resolves.toEqual({ items: [conversation], lastTime: 250 })
    await expect(getConversationMessages('200', 250)).resolves.toEqual({
      items: [message, { id: '501', senderId: '200', senderName: '', senderIsClub: false, text: '', image: '/test.jpg', timestamp: 123400 }],
      lastTime: 200,
    })
    expect(core.postPocket.mock.calls.map(args => args.slice(0, 3))).toEqual([
      ['https://pocketapi.48.cn/message/api/v1/user/message/list', { lastTime: 0, limit: 20 }, 'test-session'],
      ['https://pocketapi.48.cn/message/api/v1/user/message/info', { targetUserId: 200, lastTime: 250, limit: 10 }, 'test-session'],
    ])
  })

  it('读取未加引号的 Android long 原值，保留相邻会话和消息的不同 ID', async () => {
    const list = '{"status":200,"content":{"data":[{"conversationId":9007199254740992,"user":{"userId":9007199254740993}},{"conversationId":9007199254740993,"club":{"clubId":9007199254740995}}],"lastTime":123}}'
    const history = '{"status":200,"content":{"data":[{"messageId":9007199254740992,"club":{"clubId":9007199254740995}},{"messageId":9007199254740993,"userId":9007199254740993}],"lastTime":0}}'
    for (const body of [list, history])
      core.postPocket.mockImplementationOnce((_url, _params, _token, _headers, reviver) => JSON.parse(body, reviver))

    const sessions = await getConversations()
    expect(sessions.lastTime).toBe(123)
    expect(sessions.items.map(row => [row.id, row.targetUserId])).toEqual([
      ['9007199254740992', '9007199254740993'],
      ['9007199254740993', ''],
    ])
    const result = await getConversationMessages(sessions.items[0].targetUserId)
    expect(core.postPocket.mock.calls[1][1].targetUserId).toBe('9007199254740993')
    expect(result.items.map(row => [row.id, row.senderId])).toEqual([
      ['9007199254740992', '9007199254740995'],
      ['9007199254740993', '9007199254740993'],
    ])
  })

  it('把语音 JSON 转为会话提示和可播放的聊天附件', async () => {
    const url = 'https://mp4-new1.48.cn/2026/1125/voice.aac'
    const audio = { url, duration: 58, size: 190302 }
    const wrapped = JSON.stringify({ ...audio, url: `[${url}](${url})` })
    const other = JSON.stringify({ ...audio, url: url.replace('.aac', '.jpg') })
    core.postPocket.mockResolvedValueOnce({ status: 200, content: { data: [
      { conversationId: 100, newestMessage: wrapped },
      { conversationId: 101, newestMessage: other },
    ], lastTime: 0 } })
    core.postPocket.mockResolvedValueOnce({ status: 200, content: { data: [
      { content: { text: wrapped } },
      { messageType: 'AUDIO', content: { text: JSON.stringify(audio) } },
      { messageType: 'AUDIO', content: { url: '/2026/1125/voice.aac', duration: '58' } },
      { messageType: 'AUDIO', content: { url: 'javascript:alert(1)' } },
      { messageType: 'FLIPCARD_ANSWER', content: { answerType: 2, text: wrapped } },
      { messageType: 'TEXT', content: { text: other } },
    ], lastTime: 0 } })

    const sessions = await getConversations()
    expect(sessions.items.map(row => row.preview)).toEqual(['[语音消息]', other])
    const result = await getConversationMessages('200')
    const attachment = { url, duration: 58 }
    expect(result.items.map(row => [row.text, row.audio])).toEqual([
      ['', attachment],
      ['', attachment],
      ['', { ...attachment, url: 'https://mp4.48.cn/2026/1125/voice.aac' }],
      ['[语音消息不可播放]', undefined],
      ['[翻牌回答·语音]', attachment],
      [other, undefined],
    ])
  })

  it('识别普通视频和视频翻牌，保留普通链接及独立说明', async () => {
    const url = 'https://mp4-new1.48.cn/2026/1125/video.MP4?token=sample'
    const media = JSON.stringify({ url, previewImg: '/2026/1125/cover.jpg' })
    const signed = 'https://mp4-new1.48.cn/playback?id=sample'
    core.postPocket.mockResolvedValueOnce({ status: 200, content: { data: [
      { conversationId: 100, newestMessage: media },
      { conversationId: 101, newestMessage: url },
    ], lastTime: 0 } })
    core.postPocket.mockResolvedValueOnce({ status: 200, content: { data: [
      { messageType: 'TEXT', content: { text: media } },
      { messageType: 'VIDEO', content: { text: '视频说明', videoInfo: { playUrl: '/2026/1125/video.mp4' } } },
      { messageType: 'FLIPCARD_ANSWER', content: { answerType: '3', text: JSON.stringify({ url: signed, cover: 'file:///cover.jpg' }) } },
      { messageType: 'TEXT', content: { text: url } },
      { messageType: 'VIDEO', content: { url: 'https://example.com/video.mp4' } },
    ], lastTime: 0 } })

    const sessions = await getConversations()
    expect(sessions.items.map(row => row.preview)).toEqual(['[视频消息]', url])
    const result = await getConversationMessages('200')
    expect(result.items.every(row => !row.audio)).toBe(true)
    expect(result.items.map(row => [row.text, row.video])).toEqual([
      ['', { url, poster: 'https://source.48.cn/2026/1125/cover.jpg' }],
      ['视频说明', { url: 'https://mp4.48.cn/2026/1125/video.mp4' }],
      ['[翻牌回答·视频]', { url: signed }],
      [url, undefined],
      ['[视频消息不可播放]', undefined],
    ])
  })

  it('区分用户与俱乐部发送者，媒体翻牌使用类型提示，文字翻牌保留原文', async () => {
    const user = { userId: 123, nickName: '用户' }
    const club = { clubId: 456, clubName: '俱乐部' }
    const media = { answerType: 2, text: '{"url":"/file","duration":12}' }
    core.postPocket.mockResolvedValueOnce({ status: 200, content: { data: [
      { user, club, userId: 456, messageType: 'FLIPCARD_QUESTION', content: media },
      { club, userId: 123, messageType: 'FLIPCARD_ANSWER', content: media },
      { userId: 123, messageType: 'FLIPCARD_ANSWER', content: { answerType: 1, text: '文字回答' } },
    ], lastTime: 0 } })
    const result = await getConversationMessages('123')
    expect(result.items.map(row => [row.senderId, row.senderName, row.senderIsClub, row.text])).toEqual([
      ['123', '用户', false, '[翻牌提问·媒体]'],
      ['456', '俱乐部', true, '[翻牌回答·媒体]'],
      ['123', '', false, '文字回答'],
    ])
  })

  it('仅保留正整数 long 的原始 ID', async () => {
    const data = ['1.5', '1e400', '9223372036854775808', '9223372036854775807']
      .map(raw => `{"messageId":${raw}}`)
      .join(',')
    core.postPocket.mockImplementationOnce((_url, _params, _token, _headers, reviver) =>
      JSON.parse(`{"status":200,"content":{"data":[${data}],"lastTime":0}}`, reviver))
    const result = await getConversationMessages('200')
    expect(result.items.map(row => row.id)).toEqual(['', '', '', '9223372036854775807'])
  })

  it('未登录不发请求，会话账号变化后丢弃旧的鉴权失败', async () => {
    core.getToken.mockReturnValueOnce('')
    await expect(getConversations()).rejects.toThrow('请先登录')
    expect(core.postPocket).not.toHaveBeenCalled()

    core.getToken.mockReturnValueOnce('old-session')
    core.postPocket.mockResolvedValueOnce({ status: 401003 })
    await expect(getConversationMessages('200')).rejects.toThrow('登录状态已变更')
    expect(core.throwAuthExpired).not.toHaveBeenCalled()
  })

  it('处理空页、异常格式和当前账号过期', async () => {
    core.postPocket.mockResolvedValueOnce({ status: 200, content: { data: null, lastTime: -1 } })
    await expect(getConversations()).resolves.toEqual({ items: [], lastTime: 0 })
    core.postPocket.mockResolvedValueOnce({ status: 200, content: {} })
    await expect(getConversationMessages('200')).rejects.toThrow('数据格式异常')
    core.postPocket.mockResolvedValueOnce({ status: 401003 })
    await expect(getConversationMessages('200')).rejects.toThrow('登录已过期')
  })
})

describe('会话浏览', () => {
  it('没有目标用户的会话不会伪造空历史或发出请求', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('window', { mainAPI: { pocketGetConversationMessages: fetch } })
    const inbox = usePocketMessages()
    inbox.selectConversation({ ...conversation, targetUserId: '' })
    await expect(inbox.history.load()).resolves.toBe(false)
    expect(inbox.history.error.value).toBe('当前无法读取此会话的聊天记录')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('切走后作废旧的分页请求，返回刷新失败时保留会话列表与所选记录', async () => {
    let finish!: (value: PocketMessagePage<PocketConversation>) => void
    const fetch = vi.fn()
      .mockResolvedValueOnce({ items: [conversation], lastTime: 123 })
      .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
      .mockRejectedValueOnce(new Error('网络中断'))
      .mockResolvedValueOnce({ items: [{ ...conversation, preview: '新消息' }], lastTime: 124 })
    vi.stubGlobal('window', { mainAPI: {
      pocketGetConversations: fetch,
      pocketGetConversationMessages: () => Promise.resolve({ items: [message], lastTime: 0 }),
    } })
    const inbox = usePocketMessages()
    await inbox.conversations.load()
    inbox.selectConversation(conversation)
    await inbox.history.load()
    const old = inbox.conversations.loadMore()
    inbox.conversations.cancelPending()
    await inbox.conversations.load()
    finish({ items: [], lastTime: 0 })
    await old
    expect(inbox.conversations.error.value).toBe('网络中断')
    expect(inbox.conversations.items.value).toEqual([conversation])
    expect(inbox.conversations.cursor.value).toBe(123)
    await inbox.conversations.retry()
    expect(fetch.mock.calls).toEqual([[0], [123], [0], [0]])
    expect(inbox.conversations.items.value[0].preview).toBe('新消息')
    expect(inbox.selected.value?.id).toBe(conversation.id)
    expect(inbox.history.items.value).toEqual([message])
  })

  it('重置账号后丢弃两栏已经发出的旧请求', async () => {
    let finishSessions!: (value: PocketMessagePage<PocketConversation>) => void
    let finishHistory!: (value: PocketMessagePage<PocketDirectMessage>) => void
    vi.stubGlobal('window', { mainAPI: {
      pocketGetConversations: () => new Promise<PocketMessagePage<PocketConversation>>((resolve) => { finishSessions = resolve }),
      pocketGetConversationMessages: () => new Promise<PocketMessagePage<PocketDirectMessage>>((resolve) => { finishHistory = resolve }),
    } })
    const inbox = usePocketMessages()
    inbox.selectConversation(conversation)
    const oldSessions = inbox.conversations.load()
    const oldHistory = inbox.history.load()
    inbox.reset()
    finishSessions({ items: [conversation], lastTime: 250 })
    finishHistory({ items: [message], lastTime: 250 })
    await Promise.all([oldSessions, oldHistory])
    expect(inbox.selected.value).toBeNull()
    expect(inbox.conversations.items.value).toEqual([])
    expect(inbox.history.items.value).toEqual([])
  })

  it('历史翻页失败后重试同一游标，去重并停止重复游标', async () => {
    const page = vi.fn()
      .mockResolvedValueOnce({ items: [message], lastTime: 250 })
      .mockRejectedValueOnce(new Error('网络中断'))
      .mockResolvedValueOnce({ items: [message, { ...message, id: '456' }], lastTime: 250 })
    vi.stubGlobal('window', { mainAPI: { pocketGetConversationMessages: page } })
    const inbox = usePocketMessages()
    inbox.selectConversation(conversation)
    await inbox.history.load()
    await inbox.history.loadMore()
    expect(inbox.history.error.value).toBe('网络中断')
    expect(inbox.history.items.value).toEqual([message])
    await inbox.history.retry()
    await inbox.history.loadMore()
    expect(page.mock.calls).toEqual([['200', 0], ['200', 250], ['200', 250]])
    expect(inbox.history.items.value.map(item => item.id)).toEqual(['500', '456'])
    expect(inbox.history.cursor.value).toBe(0)
  })
})

import type { PocketConversation, PocketDirectMessage } from '@preload/ipc-contract'
import { MESSAGE_CONVERSATIONS_URL, MESSAGE_HISTORY_URL } from '@common/pocket-api-urls'
import { toApiId, toMessageId } from '@common/pocket-ids'
import { getToken, isEnvelopeOk, postPocket, throwAuthExpired, TOKEN_INVALID_STATUSES } from './pocket-auth-core'

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function natural(value: unknown): number {
  const number = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value
  return typeof number === 'number' && Number.isSafeInteger(number) && number >= 0 ? number : 0
}

const messageIdFields = new Set(['conversationId', 'messageId', 'userId', 'clubId'])
const MAX_ANDROID_LONG = 9_223_372_036_854_775_807n

/** Android long 可能是未加引号的 JSON 数字；用 V8 提供的原始字面值保留 ID 精度。 */
function reviveMessageId(key: string, value: unknown, context?: { source?: string }): unknown {
  if (typeof value === 'number' && !Number.isSafeInteger(value) && messageIdFields.has(key)) {
    const literal = context?.source
    if (literal && /^[1-9]\d{0,18}$/.test(literal) && BigInt(literal) <= MAX_ANDROID_LONG)
      return literal
    return ''
  }
  return value
}

async function fetchPage(url: string, params: { lastTime: number, limit: number, targetUserId?: number | string }) {
  if (!Number.isSafeInteger(params.lastTime) || params.lastTime < 0)
    throw new Error('消息分页参数无效')
  const token = getToken()
  if (!token)
    throw new Error('请先登录口袋48账号')

  const result = await postPocket(url, params, token, undefined, undefined, reviveMessageId)
  if (getToken() !== token)
    throw new Error('登录状态已变更，请重试')
  if (result.status !== undefined && TOKEN_INVALID_STATUSES.has(result.status))
    throwAuthExpired()
  if (!isEnvelopeOk(result))
    throw new Error(result.message || '获取消息失败')

  const page = result.content
  if (!isRecord(page) || (page.data !== null && !Array.isArray(page.data)))
    throw new TypeError('消息列表数据格式异常')
  return { data: Array.isArray(page.data) ? page.data as unknown[] : [], lastTime: natural(page.lastTime) }
}

export async function getConversations(lastTime = 0) {
  const page = await fetchPage(MESSAGE_CONVERSATIONS_URL, { lastTime, limit: 20 })
  const items: PocketConversation[] = []
  for (const entry of page.data) {
    if (!isRecord(entry))
      continue

    const user = isRecord(entry.user) ? entry.user : {}
    const club = isRecord(entry.club) ? entry.club : {}
    const targetUserId = toMessageId(user.userId)
    const id = toMessageId(entry.conversationId) || targetUserId || toMessageId(club.clubId)
    if (id) {
      items.push({
        id,
        targetUserId,
        name: text(club.clubName) || text(user.nickname) || text(user.nickName) || '未知会话',
        avatar: text(club.clubAvatar) || text(user.avatar),
        preview: text(entry.newestMessage),
        timestamp: natural(entry.newestMessagetime),
        unreadCount: natural(entry.noreadNum),
      })
    }
  }
  return { items, lastTime: page.lastTime }
}

export async function getConversationMessages(targetUserId: string, lastTime = 0) {
  if (typeof targetUserId !== 'string' || !/^[1-9]\d*$/.test(targetUserId))
    throw new Error('会话对象无效')

  const page = await fetchPage(MESSAGE_HISTORY_URL, { targetUserId: toApiId(targetUserId), lastTime, limit: 10 })
  const items: PocketDirectMessage[] = []
  for (const entry of page.data) {
    if (!isRecord(entry))
      continue

    const user = isRecord(entry.user) ? entry.user : null
    const club = !user && isRecord(entry.club) ? entry.club : null
    const content = isRecord(entry.content) ? entry.content : {}
    const image = entry.messageType === 'IMAGE' ? text(content.image) : ''
    let body = text(content.text) || (image ? '' : '[消息内容不可预览]')
    if (natural(content.answerType) > 1) {
      if (entry.messageType === 'FLIPCARD_QUESTION')
        body = '[翻牌提问·媒体]'
      else if (entry.messageType === 'FLIPCARD_ANSWER')
        body = '[翻牌回答·媒体]'
    }
    items.push({
      id: toMessageId(entry.messageId),
      senderId: toMessageId(user ? user.userId : club ? club.clubId : entry.userId),
      senderName: text(user?.nickName) || text(user?.nickname) || text(club?.clubName),
      senderIsClub: !!club,
      text: body,
      image,
      timestamp: natural(entry.timestamp),
    })
  }
  return { items, lastTime: page.lastTime }
}

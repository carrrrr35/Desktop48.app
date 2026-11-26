import type { PocketConversation, PocketMessagePage } from '@preload/ipc-contract'
import { pocketAuthErrorMessage } from '@renderer/stores/pocket-auth'
import { ref, shallowRef } from 'vue'

/** 会话列表和聊天记录分别分页，切换账号或会话时作废旧请求。 */
function useMessagePages<T extends { id: string }>(fetchPage: (lastTime: number) => Promise<PocketMessagePage<T>>) {
  const items = shallowRef<T[]>([])
  const cursor = ref(0)
  const loading = ref(false)
  const error = ref('')
  const seenCursors = new Set<number>()
  let revision = 0
  let requestedCursor = 0

  function cancelPending() {
    revision++
    loading.value = false
  }

  function reset() {
    cancelPending()
    items.value = []
    cursor.value = 0
    error.value = ''
    requestedCursor = 0
    seenCursors.clear()
  }

  async function load(from = 0) {
    if (loading.value)
      return false
    const request = revision
    requestedCursor = from
    loading.value = true
    error.value = ''
    try {
      const page = await fetchPage(from)
      if (request !== revision)
        return false

      if (from === 0)
        seenCursors.clear()
      seenCursors.add(from)
      const next = from ? [...items.value] : []
      const ids = new Set(next.map(item => item.id))
      for (const item of page.items) {
        if (item.id && ids.has(item.id))
          continue
        ids.add(item.id)
        next.push(item)
      }
      items.value = next
      cursor.value = page.items.length && !seenCursors.has(page.lastTime) ? page.lastTime : 0
      return true
    }
    catch (reason) {
      if (request === revision)
        error.value = pocketAuthErrorMessage(reason)
      return false
    }
    finally {
      if (request === revision)
        loading.value = false
    }
  }

  return {
    items,
    cursor,
    loading,
    error,
    load,
    loadMore: () => cursor.value ? load(cursor.value) : Promise.resolve(false),
    retry: () => load(requestedCursor),
    cancelPending,
    reset,
  }
}

export function usePocketMessages() {
  const selected = shallowRef<PocketConversation | null>(null)
  const conversations = useMessagePages(lastTime => window.mainAPI.pocketGetConversations(lastTime))
  const history = useMessagePages((lastTime) => {
    const targetUserId = selected.value?.targetUserId
    if (!targetUserId)
      throw new Error('当前无法读取此会话的聊天记录')
    return window.mainAPI.pocketGetConversationMessages(targetUserId, lastTime)
  })

  function selectConversation(next: PocketConversation | null) {
    history.reset()
    selected.value = next
  }

  function reset() {
    conversations.reset()
    selectConversation(null)
  }

  return { selected, conversations, history, selectConversation, reset }
}

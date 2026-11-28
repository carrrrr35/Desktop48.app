<script setup lang="ts">
import type { PocketConversation, PocketDirectMessage } from '@preload/ipc-contract'
import { ArrowRight, ChatDotRound, Message, Refresh } from '@element-plus/icons-vue'
import RoomVoiceBar from '@renderer/components/rooms/RoomVoiceBar.vue'
import MessageVideo from '@renderer/components/ui/MessageVideo.vue'
import { usePocketMessages } from '@renderer/composables/use-pocket-messages'
import { useSettingsNav } from '@renderer/composables/use-settings-nav'
import { pocketAccountKey, pocketAuthState, refreshPocketAuthState } from '@renderer/stores/pocket-auth'
import { formatRelativeDate } from '@renderer/utils/relative-date'
import Tools from '@renderer/utils/tools'
import dayjs from 'dayjs'
import { computed, nextTick, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from 'vue'

const { selected, conversations, history, selectConversation, reset } = usePocketMessages()
const { openSettings } = useSettingsNav()
const ready = ref(false)
const active = ref(false)
const sidebarList = ref<HTMLDivElement>()
const historyList = ref<HTMLDivElement>()
const { items: sessions, loading: sessionsLoading, error: sessionsError, cursor: sessionsCursor } = conversations
const { loading: historyLoading, error: historyError, cursor: historyCursor } = history

const messages = computed(() => [...history.items.value].reverse().sort((a, b) => a.timestamp - b.timestamp))

function refreshVisibleSessions() {
  if (ready.value && active.value && pocketAuthState.value.loggedIn)
    void conversations.load()
}

onMounted(async () => {
  await refreshPocketAuthState()
  ready.value = true
  refreshVisibleSessions()
})

onActivated(() => {
  active.value = true
  refreshVisibleSessions()
})

onDeactivated(() => {
  active.value = false
  conversations.cancelPending()
})

onBeforeUnmount(reset)

watch(() => pocketAccountKey(pocketAuthState.value), () => {
  reset()
  sidebarList.value?.scrollTo(0, 0)
  historyList.value?.scrollTo(0, 0)
  refreshVisibleSessions()
}, { flush: 'sync' })

watch(sessions, (rows) => {
  const updated = rows.find(row => row.id === selected.value?.id)
  if (updated)
    openConversation(updated)
})

async function loadHistory(load: () => Promise<boolean>, older = false) {
  const conversation = selected.value
  let position: { height: number, top: number } | undefined
  // 回包后、Vue 更新 DOM 前读取位置，保留用户在等待期间滚动到的消息。
  const stop = older && watch(history.items, () => {
    const viewport = historyList.value
    if (viewport)
      position = { height: viewport.scrollHeight, top: viewport.scrollTop }
  }, { flush: 'sync', once: true })
  const applied = await load()
  if (stop)
    stop()
  if (!applied)
    return
  await nextTick()
  if (selected.value?.id !== conversation?.id || selected.value?.targetUserId !== conversation?.targetUserId || !historyList.value)
    return

  const nextHeight = historyList.value.scrollHeight
  historyList.value.scrollTop = position ? position.top + nextHeight - position.height : nextHeight
}

function openConversation(conversation: PocketConversation) {
  if (conversation.id === selected.value?.id && conversation.targetUserId === selected.value.targetUserId) {
    selected.value = conversation
    return
  }
  selectConversation(conversation)
  if (conversation.targetUserId)
    void loadHistory(history.load)
}

function conversationTime(timestamp: number) {
  const time = dayjs(timestamp)
  return time.format(time.isSame(dayjs(), 'day') ? 'HH:mm' : 'MM-DD')
}

function isOutgoing(message: PocketDirectMessage) {
  return !message.senderIsClub && !!message.senderId && message.senderId === pocketAuthState.value.userId
}
</script>

<template>
  <div class="page-root messages-page">
    <div v-if="!ready" class="message-gate" role="status">
      <el-icon class="is-loading" :size="22">
        <Refresh />
      </el-icon>
      <span>正在读取账号…</span>
    </div>
    <div v-else-if="!pocketAuthState.loggedIn" class="message-gate">
      <section class="message-panel message-login" aria-labelledby="message-login-heading">
        <span class="icon-tile login-icon"><el-icon :size="24"><Message /></el-icon></span>
        <h1 id="message-login-heading">
          消息
        </h1>
        <p>登录口袋48账号后即可查看消息</p>
        <el-button type="primary" round @click="openSettings">
          去设置页登录
          <el-icon class="el-icon--right">
            <ArrowRight />
          </el-icon>
        </el-button>
      </section>
    </div>

    <template v-else>
      <aside class="message-panel conversation-sidebar" aria-labelledby="conversation-heading">
        <header class="message-header">
          <span class="icon-tile heading-icon"><el-icon :size="18"><Message /></el-icon></span>
          <h1 id="conversation-heading">
            消息
          </h1>
          <el-button
            circle size="small" :icon="Refresh" :loading="sessionsLoading"
            aria-label="刷新会话列表" title="刷新会话列表" @click="conversations.load()"
          />
        </header>

        <div ref="sidebarList" class="conversation-list detail-scroll" :aria-busy="sessionsLoading">
          <button
            v-for="session in sessions" :key="session.id"
            class="conversation-row" :class="{ 'is-active': session.id === selected?.id }"
            :aria-current="session.id === selected?.id ? 'true' : undefined"
            type="button" @click="openConversation(session)"
          >
            <el-avatar :size="34" :src="Tools.sourceUrl(session.avatar)" aria-hidden="true">
              {{ Array.from(session.name)[0] }}
            </el-avatar>
            <span class="conversation-copy">
              <strong class="ellipsis">{{ session.name }}</strong>
              <span v-if="session.preview" class="conversation-preview ellipsis">{{ session.preview }}</span>
            </span>
            <span class="conversation-meta">
              <time v-if="session.timestamp">{{ conversationTime(session.timestamp) }}</time>
              <span
                v-if="session.unreadCount" class="unread-badge" :aria-label="`${session.unreadCount} 条未读`"
              >{{ session.unreadCount > 99 ? '99+' : session.unreadCount }}</span>
            </span>
          </button>

          <div v-if="sessionsLoading" class="message-state" role="status">
            <el-icon class="is-loading">
              <Refresh />
            </el-icon>
            <span>正在加载会话…</span>
          </div>
          <div v-else-if="sessionsError" class="message-state" role="alert">
            <span>{{ sessionsError }}</span>
            <el-button size="small" @click="conversations.retry()">
              重试
            </el-button>
          </div>
          <div v-else-if="!sessions.length" class="message-state">
            暂无会话
          </div>
          <div v-else-if="sessionsCursor" class="message-state">
            <el-button size="small" round @click="conversations.loadMore()">
              加载更多会话
            </el-button>
          </div>
        </div>
      </aside>

      <main class="message-panel conversation-main" aria-label="聊天记录">
        <template v-if="selected">
          <header class="message-header chat-header">
            <el-avatar :size="34" :src="Tools.sourceUrl(selected.avatar)" aria-hidden="true">
              {{ Array.from(selected.name)[0] }}
            </el-avatar>
            <h2 class="ellipsis">
              {{ selected.name }}
            </h2>
            <el-button
              v-if="selected.targetUserId" circle size="small" :icon="Refresh" :loading="historyLoading"
              aria-label="刷新聊天记录" title="刷新聊天记录" @click="loadHistory(history.load)"
            />
          </header>

          <div ref="historyList" class="chat-history detail-scroll" :aria-busy="historyLoading">
            <div v-if="!selected.targetUserId" class="message-state message-placeholder">
              <span>当前无法读取此会话的聊天记录</span>
            </div>
            <div v-else-if="historyLoading" class="message-state" role="status">
              <el-icon class="is-loading">
                <Refresh />
              </el-icon>
              <span>正在加载消息…</span>
            </div>
            <div v-else-if="historyError" class="message-state" role="alert">
              <span>{{ historyError }}</span>
              <el-button size="small" @click="loadHistory(history.retry, !!messages.length)">
                重试
              </el-button>
            </div>
            <div v-else-if="historyCursor" class="message-state">
              <el-button size="small" round @click="loadHistory(history.loadMore, true)">
                加载更早消息
              </el-button>
            </div>
            <div v-else-if="!messages.length" class="message-state message-placeholder">
              <el-icon :size="28">
                <ChatDotRound />
              </el-icon>
              <span>暂无聊天记录</span>
            </div>

            <ol v-if="messages.length" class="message-list">
              <li
                v-for="(message, index) in messages" :key="message.id || `no-id-${index}`"
                class="chat-message" :class="{ 'is-outgoing': isOutgoing(message) }"
              >
                <span class="chat-meta">
                  <span>{{ isOutgoing(message) ? '我' : message.senderName || selected.name }}</span>
                  <time v-if="message.timestamp">{{ formatRelativeDate(message.timestamp) }}</time>
                </span>
                <div class="chat-bubble">
                  <p v-if="message.text">
                    {{ message.text }}
                  </p>
                  <img v-if="message.image" :src="Tools.sourceUrl(message.image)" alt="聊天图片" referrerpolicy="no-referrer">
                  <RoomVoiceBar v-if="message.audio" :src="message.audio.url" :initial-duration="message.audio.duration" />
                  <MessageVideo v-if="message.video" class="chat-video" :src="message.video.url" :poster="message.video.poster" />
                </div>
              </li>
            </ol>
          </div>
        </template>

        <div v-else class="message-state message-placeholder">
          <el-icon :size="30">
            <ChatDotRound />
          </el-icon>
          <span>{{ sessions.length ? '从左侧选择会话' : '聊天记录' }}</span>
        </div>
      </main>
    </template>
  </div>
</template>

<style scoped lang="scss">
@use '../assets/css/fluid' as *;

.messages-page {
  --tile-color: var(--color-messages);
  --voice-color: var(--color-messages);
  --message-pad: #{fluid(12px, 16px)};

  display: flex;
  box-sizing: border-box;
  gap: fluid(10px, 14px);
  padding: fluid(10px, 14px) 14px var(--dock-reserve);
  overflow: hidden;
}

.message-panel {
  min-height: 0;
  border-radius: var(--radius-card);
  background: var(--glass-fill);
  box-shadow: inset 0 0 0 1px var(--el-border-color-lighter);
  backdrop-filter: var(--glass-blur);
}

.conversation-sidebar,
.conversation-main {
  display: flex;
  min-width: 0;
  flex-direction: column;
  overflow: hidden;
}

.conversation-sidebar {
  flex: none;
  width: clamp(200px, 28vw, 300px);
}

.conversation-main {
  flex: 1;
}

.message-header {
  display: flex;
  flex: none;
  align-items: center;
  gap: fluid(8px, 10px);
  padding: fluid(8px, 10px) var(--message-pad);

  h1,
  h2 {
    flex: 1;
    min-width: 0;
    margin: 0;
    color: var(--el-text-color-primary);
    font-size: 15px;
    font-weight: 600;
  }
}

.chat-header {
  border-bottom: 1px solid var(--el-border-color-lighter);
}

.heading-icon {
  width: 34px;
  height: 34px;
}

.conversation-list,
.chat-history {
  flex: 1;
  min-height: 0;
}

.conversation-list {
  padding: 0 8px 8px;
}

.conversation-row {
  display: flex;
  box-sizing: border-box;
  align-items: center;
  gap: fluid(8px, 10px);
  width: 100%;
  margin: 0;
  padding: fluid(6px, 8px) 8px;
  border: 0;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--el-text-color-primary);
  font: inherit;
  text-align: left;
  cursor: pointer;

  &:hover {
    background: var(--el-fill-color-light);
  }

  &:focus-visible {
    outline: 2px solid var(--color-messages);
    outline-offset: -2px;
  }

  &.is-active {
    background: color-mix(in srgb, var(--color-messages) 14%, transparent);
    strong {
      color: var(--color-messages);
    }
  }
}

.el-avatar {
  flex: none;
  color: var(--color-messages);
  background: color-mix(in srgb, var(--color-messages) 12%, transparent);
  font-weight: 600;
}

.conversation-copy,
.conversation-meta {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.conversation-copy {
  flex: 1;
  min-width: 0;
  strong {
    font-size: 13px;
  }
}

.conversation-meta {
  flex: none;
  align-items: flex-end;
}

.conversation-preview,
time {
  color: var(--el-text-color-secondary);
  font-size: 11px;
}

.chat-history {
  display: flex;
  flex-direction: column;
  padding: fluid(8px, 12px) var(--message-pad);
}

.message-list {
  display: flex;
  flex: none;
  flex-direction: column;
  gap: fluid(12px, 16px);
  margin: 0;
  padding: 4px 0 12px;
  list-style: none;
}

.chat-message {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;

  &.is-outgoing {
    align-items: flex-end;

    .chat-bubble {
      background: color-mix(in srgb, var(--color-messages) 15%, transparent);
    }
  }
}

.chat-meta {
  display: flex;
  gap: 8px;
  align-items: baseline;
  color: var(--el-text-color-secondary);
  font-size: 12px;
}

.chat-bubble {
  max-width: min(82%, 560px);
  overflow: hidden;
  padding: 8px 12px;
  border-radius: var(--radius-md);
  background: var(--el-fill-color-light);
  color: var(--el-text-color-primary);
  font-size: 13px;
  line-height: 1.6;

  p {
    margin: 0;
    overflow-wrap: anywhere;
    white-space: pre-wrap;
  }

  img {
    display: block;
    max-width: min(100%, 260px);
    max-height: 240px;
    border-radius: var(--radius-sm);
    object-fit: contain;
  }

  p + .chat-video {
    margin-top: 6px;
  }
}

.message-state,
.message-gate {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--el-text-color-secondary);
  font-size: 13px;
}

.message-state {
  flex-shrink: 0;
  flex-wrap: wrap;
  padding: fluid(10px, 12px) 8px;
  text-align: center;
  overflow-wrap: anywhere;
}

.message-placeholder,
.message-gate {
  flex: 1;
}
.message-placeholder {
  flex-direction: column;
}

.message-login {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 24px 32px;
  text-align: center;

  h1 {
    margin: 0;
    color: var(--el-text-color-primary);
    font-size: 17px;
  }

  p {
    margin: 0 0 4px;
  }
}

.login-icon {
  width: 42px;
  height: 42px;
}

@media (max-width: 620px) {
  .messages-page {
    padding-inline: 8px;
  }
  .conversation-sidebar {
    width: clamp(138px, 31vw, 190px);
  }
  .conversation-row {
    padding-inline: 4px;
  }
}
</style>

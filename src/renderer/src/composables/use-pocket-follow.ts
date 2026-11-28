import type { MemberFlag } from '@common/member-flags'
import { pocketAccountKey } from '@common/pocket-accounts'
import { useFollowedMembersStore } from '@renderer/stores/member-flags'
import { pocketAuthErrorMessage, pocketAuthState, refreshPocketAuthState } from '@renderer/stores/pocket-auth'
import { computed, ref, watch } from 'vue'

const account = computed(() => pocketAccountKey(pocketAuthState.value))
const ids = ref(new Set<number>())
const syncing = ref(false)
const syncAt = ref<number | null>(null)
const syncError = ref('')
const syncPulled = computed(() => syncAt.value === null ? null : ids.value.size)
const pending = ref(new Set<number>())
let inflight: Promise<boolean> | undefined
let changesDuringRead: Map<number, boolean> | undefined

function sync(): Promise<boolean> {
  if (!pocketAuthState.value.loggedIn)
    return Promise.resolve(false)
  if (inflight)
    return inflight
  const owner = account.value
  const changes = new Map<number, boolean>()
  changesDuringRead = changes
  syncing.value = true
  inflight = window.mainAPI.pocketGetFollowedIds(owner).then((list) => {
    if (changes !== changesDuringRead || owner !== account.value)
      return false
    const next = new Set(list.map(Number).filter(id => Number.isSafeInteger(id) && id > 0))
    for (const [id, followed] of changes) {
      if (followed)
        next.add(id)
      else
        next.delete(id)
    }
    ids.value = next
    syncAt.value = Date.now()
    syncError.value = ''
    return true
  }).catch((error) => {
    if (changes === changesDuringRead)
      syncError.value = pocketAuthErrorMessage(error)
    return false
  }).finally(() => {
    if (changes === changesDuringRead) {
      inflight = undefined
      changesDuringRead = undefined
      syncing.value = false
    }
  })
  return inflight
}

watch(account, () => {
  ids.value = new Set()
  pending.value = new Set()
  syncAt.value = null
  syncError.value = ''
  inflight = undefined
  changesDuringRead = undefined
  syncing.value = false
  if (pocketAuthState.value.loggedIn)
    void sync()
}, { flush: 'sync' })

export async function setPocketFollow(id: number, followed: boolean, owner: string): Promise<boolean> {
  if (account.value !== owner || pending.value.has(id))
    return false
  const writes = pending.value
  writes.add(id)
  try {
    if (followed)
      await window.mainAPI.pocketFollowMember(id, owner)
    else
      await window.mainAPI.pocketUnfollowMember(id, owner)
    if (pending.value !== writes)
      return false
    if (followed)
      ids.value.add(id)
    else
      ids.value.delete(id)
    changesDuringRead?.set(id, followed)
    return true
  }
  finally {
    writes.delete(id)
  }
}

export function usePocketFollowSync() {
  return {
    syncing,
    syncPulled,
    syncError,
    sync,
    ids,
    syncIfStale: (intervalMs: number) => {
      if (!syncAt.value || Date.now() - syncAt.value >= intervalMs)
        void sync()
    },
  }
}

export function followStatus(id?: number | string): string {
  if (!pocketAuthState.value.loggedIn)
    return ''
  if (pending.value.has(Number(id)) || (syncing.value && syncAt.value === null))
    return '同步中'
  return syncAt.value === null || syncError.value ? '重试同步' : ''
}

/** 登录后显示当前账号的名单，游客使用本机收藏。 */
export function useActiveFollows() {
  const local = useFollowedMembersStore()
  const followedMembers = computed<MemberFlag[]>(() => pocketAuthState.value.loggedIn
    ? Array.from(ids.value, userId => ({ userId, realName: '', teamColor: '' }))
    : local.followedMembers.value)

  async function ensureFollowedLoaded() {
    const auth = await refreshPocketAuthState()
    if (!auth.loggedIn)
      await local.ensureFollowedLoaded()
    else if (syncAt.value === null)
      await sync()
  }
  return {
    followedMembers,
    isFollowed: (id?: number | string | null) => pocketAuthState.value.loggedIn ? ids.value.has(Number(id)) : local.isFollowed(id),
    ensureFollowedLoaded,
    refreshFollowedMembers: ensureFollowedLoaded,
  }
}

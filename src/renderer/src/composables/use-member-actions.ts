import type { MemberDetail } from '@renderer/utils/member-merge'
import { pocketAccountKey } from '@common/pocket-accounts'
import { followStatus, setPocketFollow, useActiveFollows, usePocketFollowSync } from '@renderer/composables/use-pocket-follow'
import { useBlockedMembersStore, useFollowedMembersStore } from '@renderer/stores/member-flags'
import { pocketAuthErrorMessage, pocketAuthState } from '@renderer/stores/pocket-auth'
import { trackEvent } from '@renderer/utils/umami'
import { ElMessage } from 'element-plus'

/** 关注 / 屏蔽的入口来源：卡片按钮、详情抽屉 */
export type MemberActionFrom = 'card' | 'detail' | 'room'

/** 详情抽屉所在页面（卡片路径不带） */
export type MemberActionPage = 'members' | 'lives' | 'playbacks'

/** 页面维度仅在有值时上报 */
function pageData(page?: MemberActionPage): { page?: MemberActionPage } {
  return page ? { page } : {}
}

export function useMemberActions() {
  const { isFollowed, ensureFollowedLoaded } = useActiveFollows()
  const { toggleFollow } = useFollowedMembersStore()
  const { isBlocked, toggleBlock, unblockMember } = useBlockedMembersStore()

  async function toggleFollowMember(member: MemberDetail, from: MemberActionFrom = 'card', page?: MemberActionPage) {
    const { userId } = member
    if (typeof userId !== 'number')
      return
    const owner = pocketAccountKey(pocketAuthState.value)
    if (followStatus(userId) === '重试同步') {
      await usePocketFollowSync().sync()
      return
    }
    await ensureFollowedLoaded()
    if (owner !== pocketAccountKey(pocketAuthState.value) || followStatus(userId))
      return
    // 屏蔽优先：已屏蔽时按钮展示为「未关注」（见 MemberCard / MemberDetailCard），
    // 因此这一次点击表达的是「关注 TA」——先解除屏蔽。关注名单与屏蔽正交，原样保留。
    const blocked = isBlocked(userId)
    const followed = isFollowed(userId)
    const willFollow = blocked || !followed
    if (blocked && !await unblockMember(userId))
      return
    // 已经关注时，本次点击只解除屏蔽。
    if (willFollow === followed) {
      // 点击落在「解除屏蔽」上，按屏蔽操作记账，否则这一次交互没有数据
      trackEvent('member:block', { action: 'unblock', from, ...pageData(page) })
      return
    }
    if (owner !== pocketAccountKey(pocketAuthState.value))
      return
    if (pocketAuthState.value.loggedIn) {
      try {
        if (!await setPocketFollow(userId, willFollow, owner))
          return
        ElMessage.success(willFollow ? '已关注' : '已取消关注')
      }
      catch (error) {
        ElMessage.error(pocketAuthErrorMessage(error))
        return
      }
    }
    else {
      await toggleFollow({ ...member, userId })
    }
    // realName 可能为空（官方号等），回落 nickname
    const starName = member.realName || member.nickname || ''
    trackEvent('member:follow', { action: willFollow ? 'follow' : 'unfollow', from, starName, ...pageData(page) })
  }

  async function toggleBlockMember(member: MemberDetail, from: MemberActionFrom = 'card', page?: MemberActionPage) {
    const { userId } = member
    if (typeof userId !== 'number')
      return
    // 屏蔽只动屏蔽名单：关注是账号维度的事实，取关不由屏蔽代劳（见文件头）
    const blocked = isBlocked(userId)
    await toggleBlock({ ...member, userId })
    trackEvent('member:block', { action: blocked ? 'unblock' : 'block', from, ...pageData(page) })
  }

  return { isFollowed, isBlocked, toggleFollowMember, toggleBlockMember }
}

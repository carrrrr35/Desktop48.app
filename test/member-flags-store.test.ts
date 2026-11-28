import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeMember } from './fixtures/member'

const { ElMessageMock } = vi.hoisted(() => {
  // ElMessage 既可调用、又挂着 error/success/warning 静态方法：Object.assign 一次给全，
  // 逐个赋值不成立（vi.fn() 的函数类型上写这些属性属于新增属性）
  const mock = Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), warning: vi.fn() })
  return { ElMessageMock: mock }
})
vi.mock('element-plus', () => ({ ElMessage: ElMessageMock }))
vi.mock('@renderer/utils/debug', () => ({ debugLog: vi.fn() }))

interface FlagEntry {
  userId: number
  realName: string
  teamColor: string
}

interface SetupOptions {
  loggedIn: boolean
  /** 主进程 getMemberFlags 的初始解析结果（本地成员树里查得到的人） */
  flags?: FlagEntry[]
  /** 初始屏蔽名单（kind='blocked'）：验证屏蔽优先与「屏遮不改关注」的起点 */
  blockedFlags?: FlagEntry[]
  /** true = 服务端关注写入抛错（双写失败降级场景） */
  pocketIds?: number[]
  followWriteFails?: boolean
}

async function setup({ loggedIn, flags: initialFlags = [], blockedFlags: initialBlocked = [], pocketIds = [], followWriteFails = false }: SetupOptions) {
  vi.resetModules()
  const calls = {
    addMemberFlag: [] as Array<[string, number]>,
    removeMemberFlag: [] as Array<[string, number]>,
    addMemberFlags: [] as Array<[string, number[]]>,
    pocketFollow: [] as number[],
    pocketUnfollow: [] as number[],
  }
  // 假主进程：addMemberFlag 落库后 getMemberFlags 能读到（真实链路由 Database 保证）；
  // 两类名单各存一份，getMemberFlags 按 kind 分派
  let flags: FlagEntry[] = [...initialFlags]
  let blocked: FlagEntry[] = [...initialBlocked]
  const entryOf = (userId: number) => ({ userId, realName: `用户${userId}`, teamColor: '' })
  vi.stubGlobal('window', {
    mainAPI: {
      getMemberFlags: vi.fn(async (kind: string) => (kind === 'blocked' ? blocked : flags)),
      addMemberFlag: vi.fn(async (kind: string, userId: number) => {
        calls.addMemberFlag.push([kind, userId])
        if (kind === 'blocked')
          blocked = [...blocked, entryOf(userId)]
        else
          flags = [...flags, entryOf(userId)]
      }),
      removeMemberFlag: vi.fn(async (kind: string, userId: number) => {
        calls.removeMemberFlag.push([kind, userId])
        if (kind === 'blocked')
          blocked = blocked.filter(member => member.userId !== userId)
        else
          flags = flags.filter(member => member.userId !== userId)
      }),
      addMemberFlags: vi.fn(async (kind: string, userIds: number[]) => {
        calls.addMemberFlags.push([kind, userIds])
        if (kind === 'followed')
          flags = [...flags, ...userIds.map(entryOf)]
      }),
      pocketGetFollowedIds: vi.fn(async () => pocketIds),
      pocketGetAuthState: vi.fn(async () => ({
        loggedIn,
        userId: 'main',
        nickname: '',
        avatar: '',
        mobileMasked: '',
        plainFallback: false,
        savedAt: 0,
      })),
      pocketFollowMember: vi.fn(async (userId: number) => {
        if (followWriteFails)
          throw new Error('network down')
        calls.pocketFollow.push(userId)
      }),
      pocketUnfollowMember: vi.fn(async (userId: number) => {
        if (followWriteFails)
          throw new Error('network down')
        calls.pocketUnfollow.push(userId)
      }),
    },
  })
  const [{ useBlockedMembersStore, useFollowedMembersStore }, { useMemberActions }] = await Promise.all([
    import('@renderer/stores/member-flags'),
    import('@renderer/composables/use-member-actions'),
  ])
  const { refreshPocketAuthState } = await import('@renderer/stores/pocket-auth')
  await refreshPocketAuthState()
  const { usePocketFollowSync } = await import('@renderer/composables/use-pocket-follow')
  if (loggedIn)
    await usePocketFollowSync().sync()
  return {
    store: useFollowedMembersStore(),
    blockedStore: useBlockedMembersStore(),
    actions: useMemberActions(),
    calls,
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

describe('账号关注同步', () => {
  it('关注写入期间切号，旧请求的结果留在原账号', async () => {
    const { actions } = await setup({ loggedIn: true })
    const { pocketAuthState } = await import('@renderer/stores/pocket-auth')
    const { pocketAccountKey } = await import('@common/pocket-accounts')
    const { setPocketFollow, usePocketFollowSync } = await import('@renderer/composables/use-pocket-follow')
    const owner = pocketAccountKey(pocketAuthState.value)
    let finish!: () => void
    vi.mocked(window.mainAPI.pocketFollowMember).mockImplementationOnce(() => new Promise((resolve) => {
      finish = resolve
    }))
    const saving = setPocketFollow(7, true, owner)
    expect(window.mainAPI.pocketFollowMember).toHaveBeenCalledWith(7, owner)
    pocketAuthState.value = { ...pocketAuthState.value, userId: 'small' }
    await usePocketFollowSync().sync()
    finish()
    expect(await saving).toBe(false)
    expect(actions.isFollowed(7)).toBe(false)
    expect(await setPocketFollow(8, true, owner)).toBe(false)
    expect(window.mainAPI.pocketFollowMember).toHaveBeenCalledTimes(1)
  })

  it('新账号空名单取代旧名单，保留共享本机收藏并丢弃前一个账号的迟到结果', async () => {
    const { store, actions, calls } = await setup({ loggedIn: true, flags: [{ userId: 7, realName: '小王', teamColor: '' }], pocketIds: [1] })
    await store.refreshFollowedMembers()
    const { pocketAuthState } = await import('@renderer/stores/pocket-auth')
    const { usePocketFollowSync } = await import('@renderer/composables/use-pocket-follow')
    const { sync } = usePocketFollowSync()
    expect(actions.isFollowed(1)).toBe(true)
    let finish!: (ids: number[]) => void
    vi.mocked(window.mainAPI.pocketGetFollowedIds).mockImplementationOnce(() => new Promise((resolve) => {
      finish = resolve
    })).mockResolvedValue([])
    const old = sync()
    pocketAuthState.value = { ...pocketAuthState.value, userId: 'small' }
    await sync()
    finish([1, 7])
    expect(await old).toBe(false)
    expect(actions.isFollowed(1)).toBe(false)
    expect(actions.isFollowed(7)).toBe(false)
    expect(store.isFollowed(7)).toBe(true)
    expect(calls.addMemberFlags).toEqual([])
  })
})

describe('显式关注 / 取关（房间页本地关注开关用）', () => {
  it('followMember：落库并就地入册，重复调用不重复入册', async () => {
    const { store, calls } = await setup({ loggedIn: true })

    expect(await store.followMember({ userId: 10001, realName: '甲', teamColor: '' })).toBe(true)
    expect(calls.addMemberFlag).toEqual([['followed', 10001]])
    expect(store.followedMembers.value.map(member => member.userId)).toEqual([10001])

    await store.followMember({ userId: 10001, realName: '甲', teamColor: '' })
    expect(store.followedMembers.value.map(member => member.userId)).toEqual([10001])
  })

  it('unfollowMember：落库移除并返回成功', async () => {
    const { store, calls } = await setup({
      loggedIn: true,
      flags: [{ userId: 10001, realName: '甲', teamColor: '' }],
    })
    await store.refreshFollowedMembers()

    expect(await store.unfollowMember(10001)).toBe(true)
    expect(calls.removeMemberFlag).toEqual([['followed', 10001]])
    expect(store.isFollowed(10001)).toBe(false)
  })

  it('落库失败返回 false 且名单不变：调用方据此不收起房间', async () => {
    const { store } = await setup({
      loggedIn: true,
      flags: [{ userId: 10001, realName: '甲', teamColor: '' }],
    })
    await store.refreshFollowedMembers()
    vi.mocked(window.mainAPI.removeMemberFlag).mockRejectedValueOnce(new Error('disk full'))

    expect(await store.unfollowMember(10001)).toBe(false)
    expect(store.isFollowed(10001)).toBe(true)
  })
})

describe('toggleFollowMember 按当前账号操作', () => {
  it('账号关注成功后仅更新账号名单', async () => {
    const { actions, calls } = await setup({ loggedIn: true })
    await actions.toggleFollowMember(makeMember({ userId: 10001, realName: '甲' }))
    expect(calls.addMemberFlag).toEqual([])
    expect(actions.isFollowed(10001)).toBe(true)
    expect(calls.pocketFollow).toEqual([10001])
    expect(calls.pocketUnfollow).toEqual([])
  })

  it('账号取关保留独立的本机收藏', async () => {
    const { store, actions, calls } = await setup({
      pocketIds: [10001],
      loggedIn: true,
      flags: [{ userId: 10001, realName: '甲', teamColor: '' }],
    })
    await store.refreshFollowedMembers()
    await actions.toggleFollowMember(makeMember({ userId: 10001, realName: '甲' }))
    expect(calls.removeMemberFlag).toEqual([])
    expect(store.isFollowed(10001)).toBe(true)
    expect(actions.isFollowed(10001)).toBe(false)
    expect(calls.pocketUnfollow).toEqual([10001])
    expect(calls.pocketFollow).toEqual([])
  })

  it('未登录：只操作本地，不双写', async () => {
    const { actions, calls } = await setup({ loggedIn: false })
    await actions.toggleFollowMember(makeMember({ userId: 10001, realName: '甲' }))
    expect(calls.addMemberFlag).toEqual([['followed', 10001]])
    expect(calls.pocketFollow).toEqual([])
  })

  it('账号写入失败，保留原状态并提示重试', async () => {
    const { actions, calls } = await setup({ loggedIn: true, followWriteFails: true })
    await expect(actions.toggleFollowMember(makeMember({ userId: 10001, realName: '甲' }))).resolves.toBeUndefined()
    expect(calls.addMemberFlag).toEqual([])
    expect(actions.isFollowed(10001)).toBe(false)
    expect(ElMessageMock.error).toHaveBeenCalled()
  })

  it('点关注顺带解除屏蔽（唯一保留的互斥方向：用户在表达「我要看 TA」）', async () => {
    const { store, actions, calls } = await setup({
      loggedIn: true,
      flags: [{ userId: 10001, realName: '甲', teamColor: '' }],
    })
    // 先造成「已屏蔽」状态，再关注应解除屏蔽
    await actions.toggleBlockMember(makeMember({ userId: 10001, realName: '甲' }))
    expect(calls.addMemberFlag).toContainEqual(['blocked', 10001])
    await actions.toggleFollowMember(makeMember({ userId: 10001, realName: '甲' }))
    expect(calls.removeMemberFlag).toContainEqual(['blocked', 10001])
    expect(calls.pocketFollow).toEqual([10001])
    expect(actions.isFollowed(10001)).toBe(true)
    expect(store.isFollowed(10001)).toBe(false)
  })
})

describe('屏蔽与关注正交（屏蔽不再连带取关）', () => {
  it('屏蔽已关注成员：关注名单原样保留，也不向账号取关', async () => {
    const { store, blockedStore, actions, calls } = await setup({
      loggedIn: true,
      flags: [{ userId: 10001, realName: '甲', teamColor: '' }],
    })
    await store.refreshFollowedMembers()
    await blockedStore.refreshBlockedMembers()

    await actions.toggleBlockMember(makeMember({ userId: 10001, realName: '甲' }))

    expect(calls.addMemberFlag).toEqual([['blocked', 10001]])
    expect(calls.removeMemberFlag).toEqual([])
    expect(calls.pocketUnfollow).toEqual([])
    expect(store.isFollowed(10001)).toBe(true)
    expect(blockedStore.isBlocked(10001)).toBe(true)
  })

  it('已屏蔽且账号侧已关注：点关注只解屏蔽，不重复写名单、不双写', async () => {
    const { store, blockedStore, actions, calls } = await setup({
      pocketIds: [10001],
      loggedIn: true,
      flags: [{ userId: 10001, realName: '甲', teamColor: '' }],
      blockedFlags: [{ userId: 10001, realName: '甲', teamColor: '' }],
    })
    await store.refreshFollowedMembers()
    await blockedStore.refreshBlockedMembers()

    await actions.toggleFollowMember(makeMember({ userId: 10001, realName: '甲' }))

    expect(calls.removeMemberFlag).toEqual([['blocked', 10001]])
    expect(calls.addMemberFlag).toEqual([])
    expect(calls.pocketFollow).toEqual([])
    expect(calls.pocketUnfollow).toEqual([])
    expect(blockedStore.isBlocked(10001)).toBe(false)
    expect(store.isFollowed(10001)).toBe(true)
  })

  it('已屏蔽且未关注：点关注解屏蔽并关注，只写当前口袋账号', async () => {
    const { store, blockedStore, actions, calls } = await setup({
      loggedIn: true,
      blockedFlags: [{ userId: 10001, realName: '甲', teamColor: '' }],
    })
    await store.refreshFollowedMembers()
    await blockedStore.refreshBlockedMembers()

    await actions.toggleFollowMember(makeMember({ userId: 10001, realName: '甲' }))

    expect(calls.removeMemberFlag).toEqual([['blocked', 10001]])
    expect(calls.addMemberFlag).toEqual([])
    expect(calls.pocketFollow).toEqual([10001])
    expect(blockedStore.isBlocked(10001)).toBe(false)
    expect(store.isFollowed(10001)).toBe(false)
  })

  it('解除屏蔽同样不动关注名单（关注始终由账号维度决定）', async () => {
    const { store, blockedStore, actions, calls } = await setup({
      loggedIn: true,
      flags: [{ userId: 10001, realName: '甲', teamColor: '' }],
      blockedFlags: [{ userId: 10001, realName: '甲', teamColor: '' }],
    })
    await store.refreshFollowedMembers()
    await blockedStore.refreshBlockedMembers()

    await actions.toggleBlockMember(makeMember({ userId: 10001, realName: '甲' }))

    expect(calls.removeMemberFlag).toEqual([['blocked', 10001]])
    expect(blockedStore.isBlocked(10001)).toBe(false)
    expect(store.isFollowed(10001)).toBe(true)
  })
})

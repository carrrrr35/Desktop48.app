export interface PocketLinkedAccount {
  userId: string
  nickname: string
  avatar: string
  isPrimary: boolean
}

export interface PocketAccountList {
  activeUserId: string
  accounts: PocketLinkedAccount[]
}

/** 旧凭证可能没有 userId，保留脱敏资料作为兜底。 */
export function pocketAccountKey(state: { loggedIn: boolean, userId: string, mobileMasked: string, nickname: string, savedAt: number }): string {
  const identity = state.userId || `${state.mobileMasked}|${state.nickname}`
  return `${state.loggedIn}|${identity}|${state.savedAt}`
}

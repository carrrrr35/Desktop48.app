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

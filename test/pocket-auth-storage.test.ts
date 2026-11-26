import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { ensureAuthLoaded, getAuthState, logout, saveAuth } from '../src/main/pocket48/pocket-auth-core'

let userData: string

vi.mock('electron', () => ({
  app: { getPath: () => userData },
  net: {},
  safeStorage: { isAsyncEncryptionAvailable: async () => false },
}))

it('口袋48切换账号后退出，重新载入时不会从备份恢复旧凭证', async () => {
  userData = mkdtempSync(join(tmpdir(), 'desktop48-auth-storage-'))
  const file = join(userData, 'pocket48-auth.json')
  try {
    await saveAuth('', 'main-fixture', { userId: '1', nickname: '主号', avatar: '' }, '86')
    await saveAuth('', 'small-fixture', { userId: '2', nickname: '小号', avatar: '' }, '86', 'main-fixture')
    expect(existsSync(`${file}.bak`)).toBe(true)

    logout()
    await ensureAuthLoaded()

    expect(existsSync(file)).toBe(false)
    expect(existsSync(`${file}.bak`)).toBe(false)
    expect(getAuthState().loggedIn).toBe(false)
  }
  finally {
    rmSync(userData, { recursive: true, force: true })
  }
})

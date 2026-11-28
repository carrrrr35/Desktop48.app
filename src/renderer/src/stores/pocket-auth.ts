import type { PocketAuthState, PocketCheckInResult, PocketVerifyResult } from '@preload/ipc-contract'
/**
 * 口袋48登录态的共享实现（模块级单例，与 stores/member-flags.ts 同一模式）。
 *
 * 状态镜像自主进程 pocket48-auth.json：本 store 只负责拉取/登录/退出的接线与提示，
 * 不持有凭证本体——token 只留在主进程，渲染层拿到的永远是脱敏登录态。
 * 登录态一律经 applyAuthState 写入，账号身份变化时顺带作废小房间暗号的解锁态。
 */
import { pocketAccountKey } from '@common/pocket-accounts'
import { clearSmallRoomUnlocks } from '@renderer/utils/small-room-unlock'
import { ElMessage } from 'element-plus'
import { ref } from 'vue'

export { pocketAccountKey }

const LOGGED_OUT: PocketAuthState = {
  loggedIn: false,
  nickname: '',
  avatar: '',
  userId: '',
  mobileMasked: '',
  plainFallback: false,
  savedAt: 0,
}

/** 登录态快照；启动后由调用方（设置页）refresh 一次 */
export const pocketAuthState = ref<PocketAuthState>({ ...LOGGED_OUT })

/** 是否已拉取过一次登录态（避免未初始化时直播页误判未登录） */
let initialized = false
let authRevision = 0

// 切换以及凭证失效时同步所有窗口。
if (typeof window !== 'undefined') {
  window.mainAPI.pocketAuthExpired?.(() => applyAuthState({ ...LOGGED_OUT }))
  window.mainAPI.pocketAuthChanged?.(applyAuthState)
}

/**
 * 登录态唯一写入口。身份一变就作废小房间暗号的解锁态（utils/small-room-unlock.ts）：
 * channelId 跨账号稳定，不清等于把上一个账号解锁过的小房间直接交给新账号——
 * 消息列表接口不带暗号，渲染层这道锁是唯一防线。
 */
function applyAuthState(next: PocketAuthState): void {
  if (pocketAccountKey(next) !== pocketAccountKey(pocketAuthState.value)) {
    authRevision++
    clearSmallRoomUnlocks()
  }
  initialized = true
  pocketAuthState.value = next
}

/** 拉取当前登录态（读主进程本地凭证，无网络请求） */
export async function refreshPocketAuthState(): Promise<PocketAuthState> {
  const revision = authRevision
  try {
    const state = await window.mainAPI.pocketGetAuthState()
    if (revision === authRevision)
      applyAuthState(state)
  }
  catch (error) {
    console.error('[pocket-auth] 读取登录态失败:', error)
  }
  return pocketAuthState.value
}

/** 启动后首个调用方同步初始化；已初始化则直接复用内存镜像（不发 IPC） */
export function ensurePocketAuthState(): PocketAuthState {
  if (!initialized)
    void refreshPocketAuthState()
  return pocketAuthState.value
}

/** 验证码登录；失败抛错由调用方提示 */
export async function loginBySmsCode(
  mobile: string,
  code: string,
  area?: string,
): Promise<PocketAuthState> {
  const state = await window.mainAPI.pocketLoginByCode(mobile, code, area)
  applyAuthState(state)
  return state
}

/** Token 粘贴登录；失败抛错由调用方提示 */
export async function loginByPastedToken(
  token: string,
  mobile = '',
): Promise<PocketAuthState> {
  const state = await window.mainAPI.pocketLoginByToken(token, mobile)
  applyAuthState(state)
  return state
}

/** 退出登录：主进程删除凭证文件，本地状态复位 */
export async function logoutPocket(): Promise<void> {
  await window.mainAPI.pocketLogout()
  applyAuthState({ ...LOGGED_OUT })
}

export async function switchPocketAccount(userId: string): Promise<PocketAuthState> {
  const state = await window.mainAPI.pocketSwitchLinkedAccount(userId)
  applyAuthState(state)
  return state
}

/**
 * 验证登录是否有效：主进程真实请求 token 校验与 IM 凭据两个需登录接口，
 * 返回资料与 IM 链路可用性；valid=false 时 message 里带原因。
 */
export function verifyPocketLogin(): Promise<PocketVerifyResult> {
  return window.mainAPI.pocketVerifyLogin()
}

/** 每日签到；奖励与重复签到提示由服务端返回 */
export function checkInPocket(): Promise<PocketCheckInResult> {
  return window.mainAPI.pocketCheckIn()
}

/**
 * 统一错误提示：剥掉 Electron IPC 的 `Error invoking remote method ...` 包装，
 * 并把服务端可预期的签到状态换成更自然的提示。
 */
export function pocketAuthErrorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  const ipcMatch = /^Error invoking remote method '[^']+': \w*Error: (.*)/s.exec(text)
  const message = (ipcMatch?.[1] ?? text.replace(/^Error:\s*/, '')).trim()
  if (message.includes('今日已领取') || message.includes('今日已签到'))
    return '今日已领取，明天再来'
  return message || '操作失败，请稍后重试'
}

/** 登录成功提示（nickname 可能缺失，兜底手机号/通用文案） */
export function notifyLoginSuccess(state: PocketAuthState): void {
  ElMessage.success(state.nickname ? `欢迎，${state.nickname}` : '口袋48账号登录成功')
}

<script setup lang="ts">
import { onBeforeUnmount, onDeactivated, ref, watch } from 'vue'

const props = defineProps<{ src: string, poster?: string }>()
const video = ref<HTMLVideoElement>()
const failed = ref(false)

function pause() {
  video.value?.pause()
}

watch(() => props.src, () => {
  pause()
  failed.value = false
})
onDeactivated(pause)
onBeforeUnmount(pause)
</script>

<template>
  <div>
    <video
      v-if="!failed" ref="video" :src="src" :poster="poster"
      controls playsinline preload="metadata" aria-label="聊天视频"
      @error="failed = true"
    />
    <span v-else class="video-error">[视频加载失败]</span>
  </div>
</template>

<style scoped>
video {
  display: block;
  width: 280px;
  max-width: 100%;
  aspect-ratio: 16 / 9;
  border-radius: var(--radius-sm);
  background: #000;
  object-fit: contain;
}

.video-error {
  font-size: 12px;
  color: var(--el-text-color-placeholder);
}
</style>

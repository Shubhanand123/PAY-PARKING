import type { Worker, PSM as PageMode } from 'tesseract.js'

type Reader = {
  worker: Worker
  modes: { line: PageMode; block: PageMode }
  currentMode: PageMode
}

let warming: Promise<Reader> | undefined
let idleTimer: ReturnType<typeof setTimeout> | undefined
let queue = Promise.resolve()

function armIdleTimer() {
  clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    const previous = warming
    warming = undefined
    if (previous) void queue.then(() => previous).then(reader => reader.worker.terminate()).catch(() => {})
  }, 120_000)
}

export function warmPlateReader() {
  if (!warming) {
    warming = (async () => {
      const { createWorker, PSM, OEM } = await import('tesseract.js')
      const modelUrl = import.meta.env.VITE_PLATE_OCR_MODEL_PATH || new URL(import.meta.env.BASE_URL + 'ocr/', location.origin).href
      const config = { load_system_dawg: '0', load_freq_dawg: '0', load_number_dawg: '0', load_bigram_dawg: '0' }
      let worker: Worker
      try {
        worker = await createWorker('indplate', OEM.LSTM_ONLY, { langPath: modelUrl }, config)
      } catch {
        worker = await createWorker('eng', OEM.LSTM_ONLY, {}, config)
      }
      try {
        await worker.setParameters({
          tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -',
          tessedit_pageseg_mode: PSM.SINGLE_LINE,
          preserve_interword_spaces: '1',
        })
      } catch (error) {
        await worker.terminate()
        throw error
      }
      return { worker, modes: { line: PSM.SINGLE_LINE, block: PSM.SINGLE_BLOCK }, currentMode: PSM.SINGLE_LINE }
    })().catch(error => {
      warming = undefined
      throw error
    })
  }
  armIdleTimer()
  return warming
}

export function readPlateFrame(canvas: HTMLCanvasElement, layout: 'line' | 'block') {
  const ready = warmPlateReader()
  const result = queue.then(async () => {
    const reader = await ready
    const mode = reader.modes[layout]
    if (reader.currentMode !== mode) {
      await reader.worker.setParameters({ tessedit_pageseg_mode: mode })
      reader.currentMode = mode
    }
    return (await reader.worker.recognize(canvas)).data
  })
  queue = result.then(() => {}, () => {})
  return result
}

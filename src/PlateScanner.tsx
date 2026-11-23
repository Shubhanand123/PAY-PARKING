import { useEffect, useRef, useState } from 'react'
import type { Worker } from 'tesseract.js'
import { prettyPlate } from './engine'
import { plateFromText, rankPlateFrames, type PlateReading } from './plate-reading'
import { Ico } from './ui'

export type ScanResult = PlateReading & { alternatives: string[] }

function crop(video: HTMLVideoElement, canvas: HTMLCanvasElement, enhance: boolean) {
  const w = video.videoWidth, h = video.videoHeight
  const sourceWidth = Math.round(w * .84), sourceHeight = Math.round(h * .42)
  canvas.width = Math.min(840, sourceWidth * 2)
  canvas.height = Math.round(canvas.width * sourceHeight / sourceWidth)
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('Video frames could not be read.')
  context.filter = enhance ? 'grayscale(1) contrast(1.45)' : 'grayscale(1)'
  context.drawImage(video, (w - sourceWidth) / 2, (h - sourceHeight) / 2, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height)
}

export function PlateScanner({ onRead, onClose }: { onRead: (result: ScanResult) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null)
  const dialog = useRef<HTMLDialogElement>(null)
  const callbacks = useRef({ onRead, onClose })
  const [error, setError] = useState('')
  const [status, setStatus] = useState('Starting camera…')
  const [draft, setDraft] = useState<ScanResult>()
  const [cameraRatio, setCameraRatio] = useState(0)

  useEffect(() => { callbacks.current = { onRead, onClose } }, [onRead, onClose])
  useEffect(() => {
    let stopped = false
    let stream: MediaStream | undefined
    let worker: Worker | undefined
    const preview = video.current!
    const panel = dialog.current!
    panel.showModal()

    function stop() {
      stopped = true
      stream?.getTracks().forEach(track => track.stop())
      preview.srcObject = null
      if (worker) void worker.terminate().catch(() => {})
      worker = undefined
    }
    const background = () => {
      if (document.hidden) {
        stop()
        callbacks.current.onClose()
      }
    }
    document.addEventListener('visibilitychange', background)
    async function scan() {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('Live camera access is unavailable in this browser.')
        stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: {
          facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 },
        } })
        if (stopped) { stream.getTracks().forEach(track => track.stop()); return }
        preview.srcObject = stream
        await preview.play()
        if (stopped) return
        setCameraRatio(preview.videoWidth / preview.videoHeight)
        setStatus('Loading plate reader…')
        const { createWorker, PSM, OEM } = await import('tesseract.js')
        if (stopped) return
        const modelUrl = import.meta.env.VITE_PLATE_OCR_MODEL_PATH || new URL(import.meta.env.BASE_URL + 'ocr/', location.origin).href
        const config = { load_system_dawg: '0', load_freq_dawg: '0', load_number_dawg: '0', load_bigram_dawg: '0' }
        let created: Worker
        try {
          created = await createWorker('indplate', OEM.LSTM_ONLY, { langPath: modelUrl }, config)
        } catch {
          if (stopped) return
          created = await createWorker('eng', OEM.LSTM_ONLY, {}, config)
        }
        if (stopped) { await created.terminate(); return }
        worker = created
        await worker.setParameters({ tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -', preserve_interword_spaces: '1' })
        setStatus('Keep the entire plate inside the frame and hold steady.')

        const canvas = document.createElement('canvas')
        const frames: (PlateReading | undefined)[] = []
        let index = 0
        let lastTime = -1
        while (!stopped) {
          await new Promise(resolve => setTimeout(resolve, 180))
          if (stopped || !worker || !preview.videoWidth || preview.currentTime === lastTime) continue
          lastTime = preview.currentTime
          crop(preview, canvas, index % 2 === 1)
          // Alternating segmentation gives both car plates and stacked bike plates a usable pass.
          await worker.setParameters({ tessedit_pageseg_mode: index++ % 3 === 2 ? PSM.SINGLE_LINE : PSM.SINGLE_BLOCK })
          if (stopped || !worker) return
          const { data } = await worker.recognize(canvas)
          if (stopped) return
          frames.push(plateFromText(data.text, data.confidence))
          if (frames.length > 6) frames.shift()
          const ranked = rankPlateFrames(frames)
          const result = ranked.best && { ...ranked.best, alternatives: ranked.alternatives }
          setDraft(result)
          if (result && ranked.stable) {
            stop()
            callbacks.current.onRead(result)
            return
          }
          if (index > 7 && !result) setStatus('Move closer, reduce glare, or enter the number manually.')
        }
      } catch (failure) {
        if (stopped) return
        const denied = failure instanceof DOMException && failure.name === 'NotAllowedError'
        setError(denied ? 'Camera access was denied. Allow it in browser settings or type the plate.' : 'The scanner could not start or lost the camera. Reopen it or type the plate.')
        setCameraRatio(0)
        stop()
      }
    }
    void scan()
    return () => {
      document.removeEventListener('visibilitychange', background)
      stop()
      if (panel.open) panel.close()
    }
  }, [])

  return <dialog ref={dialog} className="plate-camera" aria-labelledby="plate-camera-title"
    onCancel={event => { event.preventDefault(); onClose() }}>
    <div className="stack">
      <h2 id="plate-camera-title"><Ico n="scan" /> Live plate scanner</h2>
      <div className="plate-video" style={cameraRatio ? { width: `min(100%, ${50 * cameraRatio}dvh)` } : undefined}>
        <video ref={video} autoPlay playsInline muted aria-label="Live camera preview" />
        {cameraRatio > 0 && <div className="plate-guide" aria-hidden="true" />}
      </div>
      {error ? <p role="alert" className="msg bad">{error}</p> : <p role="status" className="muted small">{status}</p>}
      {draft && <button className="btn btn-primary" onClick={() => onRead(draft)}>Review {prettyPlate(draft.plate)}</button>}
      <button className="btn btn-ghost" onClick={onClose}>Enter manually</button>
    </div>
  </dialog>
}

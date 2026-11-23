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

export function PlateScanner({ onRead, onClose, onQr }: {
  onRead: (result: ScanResult) => void
  onClose: () => void
  onQr?: (data: string) => boolean
}) {
  const video = useRef<HTMLVideoElement>(null)
  const dialog = useRef<HTMLDialogElement>(null)
  const callbacks = useRef({ onRead, onClose, onQr })
  const [error, setError] = useState('')
  const [status, setStatus] = useState('Starting camera…')
  const [qrNotice, setQrNotice] = useState('')
  const [draft, setDraft] = useState<ScanResult>()
  const [cameraRatio, setCameraRatio] = useState(0)

  useEffect(() => { callbacks.current = { onRead, onClose, onQr } }, [onRead, onClose, onQr])
  useEffect(() => {
    let stopped = false
    let stream: MediaStream | undefined
    let worker: Worker | undefined
    let qrTimer: ReturnType<typeof setInterval> | undefined
    const readsQr = Boolean(callbacks.current.onQr)
    const preview = video.current!
    const panel = dialog.current!
    panel.showModal()

    function stop() {
      stopped = true
      clearInterval(qrTimer)
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
    async function scanQr() {
      try {
        const { default: decode } = await import('jsqr')
        if (stopped) return
        const canvas = document.createElement('canvas')
        const context = canvas.getContext('2d', { willReadFrequently: true })
        if (!context) throw new Error('Could not start QR reader.')
        let lastTime = -1
        let lastRejected = ''
        qrTimer = setInterval(() => {
          const w = preview.videoWidth, h = preview.videoHeight
          if (stopped || !w || !h || preview.currentTime === lastTime) return
          lastTime = preview.currentTime
          const frameWidth = Math.round(w * .84), frameHeight = Math.round(h * .42)
          const width = Math.min(760, frameWidth)
          const height = Math.max(1, Math.round(width * frameHeight / frameWidth))
          if (canvas.width !== width || canvas.height !== height) {
            canvas.width = width
            canvas.height = height
          }
          context.drawImage(preview, (w - frameWidth) / 2, (h - frameHeight) / 2, frameWidth, frameHeight, 0, 0, width, height)
          const pixels = context.getImageData(0, 0, width, height)
          const data = decode(pixels.data, width, height, { inversionAttempts: 'dontInvert' })?.data
          if (!data) return
          if (callbacks.current.onQr?.(data)) { stop(); return }
          if (data === lastRejected) return
          lastRejected = data
          setQrNotice('That QR does not match a parking ticket. Try another ticket or scan the plate.')
        }, 150)
      } catch {
        if (!stopped) setQrNotice('QR scanning is unavailable. Scan the plate or look up the ticket manually.')
      }
    }

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
        if (readsQr) void scanQr()
        setStatus(readsQr ? 'Scan a ticket QR. The plate reader is loading…' : 'Loading plate reader…')
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
        setStatus(readsQr ? 'Centre the ticket QR or the whole plate in the guide.' : 'Keep the entire plate inside the frame and hold steady.')

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
          if (index > 7 && !result) setStatus(readsQr ? 'Hold the ticket QR or the whole plate steady inside the guide.' : 'Move closer, reduce glare, or enter the number manually.')
        }
      } catch (failure) {
        if (stopped) return
        if (readsQr && preview.videoWidth && stream?.active) {
          if (worker) void worker.terminate().catch(() => {})
          worker = undefined
          setStatus('Plate reading is unavailable. You can scan a ticket QR or use manual lookup.')
          return
        }
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
      <h2 id="plate-camera-title"><Ico n="scan" /> {onQr ? 'Scan ticket or plate' : 'Live plate scanner'}</h2>
      <div className="plate-video" style={cameraRatio ? { width: `min(100%, ${50 * cameraRatio}dvh)` } : undefined}>
        <video ref={video} autoPlay playsInline muted aria-label="Live camera preview" />
        {cameraRatio > 0 && <div className="plate-guide" aria-hidden="true" />}
      </div>
      {error ? <p role="alert" className="msg bad">{error}</p> : <p role="status" className="muted small">{status}</p>}
      {qrNotice && <p className="msg info" role="status">{qrNotice}</p>}
      {draft && <button className="btn btn-primary" onClick={() => onRead(draft)}>Review {prettyPlate(draft.plate)}</button>}
      <button className="btn btn-ghost" onClick={onClose}>Enter manually</button>
    </div>
  </dialog>
}

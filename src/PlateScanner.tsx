import { useEffect, useRef, useState } from 'react'
import { readPlateFrame, warmPlateReader } from './plate-worker'
import { prettyPlate } from './engine'
import { plateFromText, rankPlateFrames, type PlateReading } from './plate-reading'
import { cropGray, estimateSkew, findRowSplit, locatePlate, otsu, textBlock, toGray, type Box } from './plate-locate'
import { Ico } from './ui'
import { nativeApp, nativeScan } from './native'

export type ScanResult = PlateReading & { alternatives: string[] }

type Source = { image: CanvasImageSource; width: number; height: number }
type Layout = 'line' | 'block'
type Captured = { result?: ScanResult; error?: string }

// Matches the green guide drawn over the video (.plate-guide: inset 18% 4%).
const guideWidth = .92
const guideHeight = .64

function region(src: Source, heightRatio: number): Box {
  const width = Math.round(src.width * guideWidth)
  const height = Math.round(src.height * heightRatio)
  return { width, height, x: (src.width - width) / 2, y: (src.height - height) / 2 }
}

function context2d(canvas: HTMLCanvasElement) {
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('Video frames could not be read.')
  return context
}

// The old fixed strip: used when no plate box is found, and every few frames as a cross-check.
function drawStrip(src: Source, canvas: HTMLCanvasElement, firstPass: boolean, enhance: boolean) {
  const area = region(src, firstPass ? .38 : guideHeight)
  canvas.width = Math.min(firstPass ? 720 : 880, area.width * 2)
  canvas.height = Math.round(canvas.width * area.height / area.width)
  const context = context2d(canvas)
  context.filter = enhance ? 'grayscale(1) contrast(1.45)' : 'grayscale(1)'
  context.drawImage(src.image, area.x, area.y, area.width, area.height, 0, 0, canvas.width, canvas.height)
}

// Looks for a plate inside the guide on a small copy of the frame. Returns the box in source pixels.
function findPlate(src: Source, work: HTMLCanvasElement): Box | undefined {
  const area = region(src, guideHeight)
  const scale = 256 / area.width
  work.width = 256
  work.height = Math.max(1, Math.round(area.height * scale))
  const context = context2d(work)
  context.filter = 'none'
  context.drawImage(src.image, area.x, area.y, area.width, area.height, 0, 0, work.width, work.height)
  const found = locatePlate(toGray(context.getImageData(0, 0, work.width, work.height).data, work.width, work.height))
  return found && { x: area.x + found.x / scale, y: area.y + found.y / scale, width: found.width / scale, height: found.height / scale }
}

// Tight, level crop of the plate for OCR. Two-line plates are cut in two and laid side by side as one line.
function drawPlate(src: Source, box: Box, canvas: HTMLCanvasElement, work: HTMLCanvasElement, enhance: boolean): Layout {
  const padX = box.width * .12, padY = box.height * .25
  const x = Math.max(0, box.x - padX), y = Math.max(0, box.y - padY)
  const w = Math.min(src.width - x, box.width + padX * 2), h = Math.min(src.height - y, box.height + padY * 2)
  const scale = Math.min(1000 / w, 160 / h, 4)
  work.width = Math.max(1, Math.round(w * scale))
  work.height = Math.max(1, Math.round(h * scale))
  const context = context2d(work)
  const paint = (degrees: number) => {
    context.setTransform(1, 0, 0, 1, 0, 0)
    context.filter = enhance ? 'grayscale(1) contrast(1.45)' : 'grayscale(1)'
    context.fillStyle = '#fff'
    context.fillRect(0, 0, work.width, work.height)
    context.translate(work.width / 2, work.height / 2)
    context.rotate(degrees * Math.PI / 180)
    context.drawImage(src.image, x, y, w, h, -work.width / 2, -work.height / 2, work.width, work.height)
    context.setTransform(1, 0, 0, 1, 0, 0)
    return toGray(context.getImageData(0, 0, work.width, work.height).data, work.width, work.height)
  }
  let gray = paint(0)
  const skew = estimateSkew(gray)
  if (Math.abs(skew) >= 2) gray = paint(skew)
  // Keep only the characters: the plate's frame reads as a stray "1" and drags the confidence down.
  const inner = textBlock(gray)
  const plate = cropGray(gray, inner)
  const split = findRowSplit(plate)
  const rows = split === undefined ? [[0, plate.height]] : [[0, split], [split, plate.height]]
  const margin = Math.round(plate.height * (split === undefined ? .3 : .2))
  const tallest = Math.max(...rows.map(([a, b]) => b - a))
  canvas.width = plate.width * rows.length + margin * (rows.length + 1)
  canvas.height = tallest + margin * 2
  const out = context2d(canvas)
  out.filter = 'none'
  // Pad with the plate's own background so dark-on-light and light-on-dark plates both stay clean.
  const shade = backgroundShade(plate)
  out.fillStyle = `rgb(${shade} ${shade} ${shade})`
  out.fillRect(0, 0, canvas.width, canvas.height)
  rows.forEach(([a, b], i) => out.drawImage(work, inner.x, inner.y + a, plate.width, b - a, margin + i * (plate.width + margin), margin, plate.width, b - a))
  if (!enhance) blackOnWhite(out, canvas.width, canvas.height)
  return 'line'
}

// Black text on white whatever the plate colours: white, yellow (commercial), green (EV), black (rental).
function blackOnWhite(context: CanvasRenderingContext2D, width: number, height: number) {
  const image = context.getImageData(0, 0, width, height)
  const gray = toGray(image.data, width, height)
  const { cut, darkInk } = otsu(gray)
  for (let i = 0, p = 0; i < gray.data.length; i++, p += 4) {
    const ink = darkInk ? gray.data[i] <= cut : gray.data[i] > cut
    image.data[p] = image.data[p + 1] = image.data[p + 2] = ink ? 0 : 255
  }
  context.putImageData(image, 0, 0)
}

function backgroundShade(img: { data: Uint8Array }) {
  const sorted = Uint8Array.from(img.data).sort()
  const light = sorted[Math.floor(sorted.length * .75)], dark = sorted[Math.floor(sorted.length * .25)]
  // The background is the majority tone: light for most plates, dark for black rental plates.
  return sorted[Math.floor(sorted.length / 2)] > (light + dark) / 2 ? light : dark
}

type QrDetector = { detect(source: CanvasImageSource): Promise<{ rawValue: string }[]> }
async function nativeQrDetector(): Promise<QrDetector | undefined> {
  const Detector = (globalThis as unknown as { BarcodeDetector?: { new(options: { formats: string[] }): QrDetector; getSupportedFormats(): Promise<string[]> } }).BarcodeDetector
  try {
    if (Detector && (await Detector.getSupportedFormats()).includes('qr_code')) return new Detector({ formats: ['qr_code'] })
  } catch { /* fall back to jsQR */ }
  return undefined
}

const setTorch = (track: MediaStreamTrack, on: boolean) => track.applyConstraints({ advanced: [{ torch: on } as MediaTrackConstraintSet] })

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function grabStill(track: MediaStreamTrack, preview: HTMLVideoElement): Promise<ImageBitmap> {
  const Capture = (globalThis as unknown as { ImageCapture?: new (track: MediaStreamTrack) => { takePhoto(): Promise<Blob> } }).ImageCapture
  if (Capture) {
    try {
      const photo = await Promise.race([new Capture(track).takePhoto(), sleep(3000).then(() => undefined)])
      if (photo) return await createImageBitmap(photo)
    } catch { /* some cameras refuse takePhoto; use the video frame */ }
  }
  return createImageBitmap(preview)
}

function WebPlateScanner({ onRead, onClose, onQr }: {
  onRead: (result: ScanResult) => void
  onClose: () => void
  onQr?: (data: string) => boolean
}) {
  const video = useRef<HTMLVideoElement>(null)
  const still = useRef<HTMLCanvasElement>(null)
  const dialog = useRef<HTMLDialogElement>(null)
  const callbacks = useRef({ onRead, onClose, onQr })
  const streamRef = useRef<MediaStream>(undefined)
  const frozen = useRef(false)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('Starting camera…')
  const [qrNotice, setQrNotice] = useState('')
  const [draft, setDraft] = useState<ScanResult>()
  const [cameraRatio, setCameraRatio] = useState(0)
  const [plateBox, setPlateBox] = useState<Box>()
  const [torch, setTorchState] = useState<'none' | 'off' | 'on'>('none')
  const [capture, setCapture] = useState<'live' | 'busy' | 'done'>('live')
  const [captured, setCaptured] = useState<Captured>({})
  const [readerReady, setReaderReady] = useState(false)
  const [success, setSuccess] = useState<ScanResult>()

  useEffect(() => { callbacks.current = { onRead, onClose, onQr } }, [onRead, onClose, onQr])
  useEffect(() => {
    let stopped = false
    let stream: MediaStream | undefined
    let qrTimer: ReturnType<typeof setTimeout> | undefined
    let successTimer: ReturnType<typeof setTimeout> | undefined
    const readsQr = Boolean(callbacks.current.onQr)
    const preview = video.current!
    const panel = dialog.current!
    panel.showModal()

    function stop() {
      stopped = true
      clearTimeout(qrTimer)
      stream?.getTracks().forEach(track => track.stop())
      preview.srcObject = null
    }
    const background = () => {
      if (document.hidden) {
        stop()
        callbacks.current.onClose()
      }
    }
    document.addEventListener('visibilitychange', background)

    // Ticket QR: the phone's own detector when it has one (fast on Android Chrome), otherwise jsQR, less often.
    async function scanQr() {
      try {
        const native = await nativeQrDetector()
        const decode = native ? undefined : (await import('jsqr')).default
        if (stopped) return
        const canvas = document.createElement('canvas')
        let lastTime = -1
        let lastRejected = ''
        const readFrame = async () => {
          const w = preview.videoWidth, h = preview.videoHeight
          if (stopped || frozen.current || !w || !h || preview.currentTime === lastTime) return
          lastTime = preview.currentTime
          let data: string | undefined
          if (native) {
            data = (await native.detect(preview))[0]?.rawValue
          } else if (decode) {
            const area = region({ image: preview, width: w, height: h }, guideHeight)
            const width = Math.min(640, area.width)
            const height = Math.max(1, Math.round(width * area.height / area.width))
            if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height }
            const context = context2d(canvas)
            context.drawImage(preview, area.x, area.y, area.width, area.height, 0, 0, width, height)
            data = decode(context.getImageData(0, 0, width, height).data, width, height, { inversionAttempts: 'dontInvert' })?.data
          }
          if (!data || stopped) return
          if (callbacks.current.onQr?.(data)) { try { navigator.vibrate?.(35) } catch { /* not supported */ } stop(); return }
          if (data === lastRejected) return
          lastRejected = data
          setQrNotice('That QR does not match a parking ticket. Try another ticket or scan the plate.')
        }
        const loop = async () => {
          try { await readFrame() } catch { /* a dropped frame is fine */ }
          if (!stopped) qrTimer = setTimeout(loop, native ? 120 : 260)
        }
        void loop()
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
        streamRef.current = stream
        preview.srcObject = stream
        await preview.play()
        if (stopped) return
        setCameraRatio(preview.videoWidth / preview.videoHeight)
        const capabilities = stream.getVideoTracks()[0]?.getCapabilities?.() as { torch?: boolean } | undefined
        if (capabilities?.torch) setTorchState('off')
        if (readsQr) void scanQr()
        setStatus(readsQr ? 'Scan a ticket QR. The plate reader is loading…' : 'Loading plate reader…')
        await warmPlateReader()
        if (stopped) return
        setReaderReady(true)
        setStatus(readsQr ? 'Centre the ticket QR or the whole plate in the guide. Tap the picture for a sharp photo.' : 'Keep the whole plate inside the frame. Tap the picture for a sharp photo.')

        const canvas = document.createElement('canvas')
        const work = document.createElement('canvas')
        const small = document.createElement('canvas')
        const frames: (PlateReading | undefined)[] = []
        let index = 0
        let lastTime = -1
        let previousRead: PlateReading | undefined
        while (!stopped) {
          if (frozen.current || !preview.videoWidth || preview.currentTime === lastTime) {
            await sleep(frozen.current ? 120 : 35)
            continue
          }
          lastTime = preview.currentTime
          const src: Source = { image: preview, width: preview.videoWidth, height: preview.videoHeight }
          const box = findPlate(src, small)
          setPlateBox(box && { x: box.x / src.width, y: box.y / src.height, width: box.width / src.width, height: box.height / src.height })
          // Plate crops alternate clean black-on-white and greyscale with extra contrast: each wins on different plates.
          const enhance = index % 2 === 1
          let layout: Layout
          if (box && index % 4 !== 3) layout = drawPlate(src, box, canvas, work, enhance)
          else {
            const fastPass = index === 0 || Boolean(previousRead && index % 3 !== 2)
            drawStrip(src, canvas, fastPass, enhance)
            layout = fastPass ? 'line' : 'block'
          }
          index++
          const data = await readPlateFrame(canvas, layout)
          if (stopped) return
          if (frozen.current) continue
          previousRead = plateFromText(data.text, data.confidence)
          frames.push(previousRead)
          if (frames.length > 8) frames.shift()
          const ranked = rankPlateFrames(frames)
          const result = ranked.best && { ...ranked.best, alternatives: ranked.alternatives }
          setDraft(result)
          if (result && ranked.stable) {
            // Hold the matching frame on screen with a short "got it" moment, then hand the plate over.
            const frame = still.current
            if (frame) {
              frame.width = preview.videoWidth
              frame.height = preview.videoHeight
              frame.getContext('2d')?.drawImage(preview, 0, 0)
            }
            stop()
            setSuccess(result)
            // a light buzz so the operator feels the read without looking (the Scan tap allows it)
            try { navigator.vibrate?.(35) } catch { /* not supported */ }
            successTimer = setTimeout(() => callbacks.current.onRead(result), matchMedia('(prefers-reduced-motion: reduce)').matches ? 250 : 700)
            return
          }
          if (index > 7 && !result) setStatus(readsQr ? 'Hold the ticket QR or the whole plate steady, or tap the picture for a sharp photo.' : 'Move closer, reduce glare, tap the picture for a sharp photo, or enter the number manually.')
        }
      } catch (failure) {
        if (stopped) return
        if (readsQr && preview.videoWidth && stream?.active) {
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
      clearTimeout(successTimer)
      stop()
      streamRef.current = undefined
      if (panel.open) panel.close()
    }
  }, [])

  async function toggleTorch() {
    const track = streamRef.current?.getVideoTracks()[0]
    if (!track || torch === 'none') return
    const next = torch === 'off'
    try { await setTorch(track, next); setTorchState(next ? 'on' : 'off') }
    catch { setTorchState('none') }
  }

  // Tap to capture: a full-resolution still, frozen on screen, read several ways at once.
  async function takeStill() {
    const track = streamRef.current?.getVideoTracks()[0]
    const preview = video.current, canvas = still.current
    if (!track || !preview?.videoWidth || !canvas || frozen.current || !readerReady) return
    frozen.current = true
    setCapture('busy')
    setCaptured({})
    try {
      const bitmap = await grabStill(track, preview)
      if (torch === 'on') void setTorch(track, true).catch(() => {})
      // Crop the photo to the video's shape so the guide still lines up with what was on screen.
      const aspect = preview.videoWidth / preview.videoHeight
      const sw = Math.min(bitmap.width, bitmap.height * aspect), sh = sw / aspect
      const scale = Math.min(1, 2400 / sw)
      canvas.width = Math.round(sw * scale)
      canvas.height = Math.round(sh * scale)
      context2d(canvas).drawImage(bitmap, (bitmap.width - sw) / 2, (bitmap.height - sh) / 2, sw, sh, 0, 0, canvas.width, canvas.height)
      bitmap.close()
      setCapture('done')
      const src: Source = { image: canvas, width: canvas.width, height: canvas.height }
      const ocr = document.createElement('canvas'), work = document.createElement('canvas'), small = document.createElement('canvas')
      const box = findPlate(src, small)
      setPlateBox(box && { x: box.x / src.width, y: box.y / src.height, width: box.width / src.width, height: box.height / src.height })
      const passes: (() => Layout)[] = [
        ...(box ? [() => drawPlate(src, box, ocr, work, false), () => drawPlate(src, box, ocr, work, true)] : []),
        () => { drawStrip(src, ocr, true, false); return 'line' },
        () => { drawStrip(src, ocr, false, true); return 'block' },
      ]
      const readings: (PlateReading | undefined)[] = []
      for (const pass of passes) {
        const layout = pass()
        const data = await readPlateFrame(ocr, layout)
        if (!frozen.current) return
        readings.push(plateFromText(data.text, data.confidence))
      }
      const ranked = rankPlateFrames(readings)
      setCaptured(ranked.best
        ? { result: { ...ranked.best, alternatives: ranked.alternatives } }
        : { error: 'No plate number could be read from this photo. Retake it closer, or type the number.' })
    } catch {
      setCaptured({ error: 'The photo could not be taken. Retake it or type the number.' })
      setCapture('done')
    }
  }

  function retake() {
    frozen.current = false
    setCapture('live')
    setCaptured({})
    setPlateBox(undefined)
  }

  const result = captured.result
  return <dialog ref={dialog} className="plate-camera" aria-labelledby="plate-camera-title"
    onCancel={event => { event.preventDefault(); onClose() }}>
    <div className="stack">
      <h2 id="plate-camera-title"><Ico n="scan" /> {onQr ? 'Scan ticket or plate' : 'Live plate scanner'}</h2>
      <div className="plate-video" style={cameraRatio ? { width: `min(100%, ${64 * cameraRatio}dvh)` } : undefined}>
        <video ref={video} autoPlay playsInline muted aria-label="Live camera preview" />
        <canvas ref={still} className="plate-still" hidden={capture === 'live' && !success} aria-label="Captured photo" />
        {cameraRatio > 0 && <button type="button" className="plate-tap" onClick={() => void takeStill()} disabled={capture !== 'live' || !readerReady}
          aria-label="Take a sharp photo of the plate" />}
        {cameraRatio > 0 && <div className={'plate-guide' + (success ? ' done' : plateBox ? ' found' : '')} aria-hidden="true">
          {capture === 'live' && !success && readerReady && <span className="plate-scanline" />}
        </div>}
        {plateBox && !success && <div className="plate-box" aria-hidden="true" style={{
          left: `${plateBox.x * 100}%`, top: `${plateBox.y * 100}%`, width: `${plateBox.width * 100}%`, height: `${plateBox.height * 100}%`,
        }} />}
        {success && <div className={'plate-success' + (onQr ? ' exit' : '')} role="status">
          <span className="plate-success-tick"><Ico n="check" size={26} /></span>
          {onQr
            ? <span className="plate-success-hsrp"><span className="ind">IND</span><b>{prettyPlate(success.plate)}</b></span>
            : <b>{prettyPlate(success.plate)}</b>}
        </div>}
        {torch !== 'none' && capture === 'live' && !success && <button type="button" className={'plate-torch' + (torch === 'on' ? ' on' : '')} onClick={() => void toggleTorch()}
          aria-pressed={torch === 'on'}>{torch === 'on' ? 'Light on' : 'Light off'}</button>}
      </div>
      {success && <p className="plate-read">Got it: <b>{prettyPlate(success.plate)}</b></p>}
      {capture === 'live' && !success && (error ? <p role="alert" className="msg bad">{error}</p> : <p role="status" className="muted small">{status}</p>)}
      {capture === 'busy' && <p role="status" className="muted small">Taking photo…</p>}
      {capture === 'done' && !result && !captured.error && <p role="status" className="muted small">Reading the photo…</p>}
      {capture === 'done' && captured.error && <p role="alert" className="msg bad">{captured.error}</p>}
      {capture === 'done' && result && <>
        <p role="status" className="plate-read">Read <b>{prettyPlate(result.plate)}</b>{result.confidence < .8 && <span className="muted small"> · check it</span>}</p>
        <button className="btn btn-primary" onClick={() => onRead(result)}><Ico n="check" /> Use {prettyPlate(result.plate)}</button>
        {result.alternatives.map(plate => <button key={plate} className="btn btn-ghost" onClick={() => onRead({ plate, confidence: result.confidence * .8, alternatives: [result.plate] })}>Use {prettyPlate(plate)}</button>)}
      </>}
      {capture === 'done' && <button className="btn btn-ghost" onClick={retake}><Ico n="scan" /> Retake</button>}
      {qrNotice && capture === 'live' && !success && <p className="msg info" role="status">{qrNotice}</p>}
      {draft && capture === 'live' && !success && <button className="btn btn-primary" onClick={() => onRead(draft)}>Review {prettyPlate(draft.plate)}</button>}
      <button className="btn btn-ghost" onClick={onClose}>Enter manually</button>
    </div>
  </dialog>
}

type ScannerProps = { onRead: (result: ScanResult) => void; onClose: () => void; onQr?: (data: string) => boolean }

// Android app: hand over to the native ML Kit scanner screen and pass its answer back to the form.
function NativePlateScanner({ onRead, onClose, onQr }: ScannerProps) {
  const callbacks = useRef({ onRead, onClose, onQr })
  useEffect(() => { callbacks.current = { onRead, onClose, onQr } }, [onRead, onClose, onQr])
  useEffect(() => {
    let alive = true
    const { onQr: readsQr } = callbacks.current
    nativeScan(Boolean(readsQr), readsQr ? 'Scan ticket or plate' : 'Scan plate').then(result => {
      if (!alive) return
      const { onRead, onClose, onQr } = callbacks.current
      if (result.qr !== undefined) { if (!onQr?.(result.qr)) onClose(); return }
      if (result.plate) onRead({ plate: result.plate, confidence: .9, alternatives: result.alternatives ?? [] })
      else onClose()
    }).catch(() => { if (alive) callbacks.current.onClose() })
    return () => { alive = false }
  }, [])
  return null
}

export function PlateScanner(props: ScannerProps) {
  return nativeApp ? <NativePlateScanner {...props} /> : <WebPlateScanner {...props} />
}

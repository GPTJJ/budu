const ROUTINE_DECODE_ERRORS = new Set(['NotFoundException', 'ChecksumException', 'FormatException'])

export function normalizeAuthCode(value) {
  const code = String(value ?? '').trim()
  if (code.length < 6 || code.length > 512 || /[\u0000-\u001f\u007f]/.test(code)) return ''
  return code
}

export function cameraErrorMessage(error) {
  const name = String(error?.name || '')
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
    return '相机权限被拒绝。请在 Safari 网站设置中允许使用相机，然后点击“重新扫码”。'
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return '没有找到可用摄像头，请检查设备后重新扫码。'
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return '摄像头正被其他应用占用。请关闭占用相机的应用后重新扫码。'
  }
  if (name === 'OverconstrainedError' || name === 'ConstraintNotSatisfiedError') {
    return '当前摄像头不支持所需模式，请重新扫码或检查设备设置。'
  }
  if (name === 'SecurityError') return '当前页面不能使用摄像头，请确认通过 HTTPS 打开 BUDU。'
  return '摄像头启动失败，请检查权限和设备后重新扫码。'
}

export async function createBarcodeDecoder() {
  const { BrowserMultiFormatReader } = await import('@zxing/browser')
  const reader = new BrowserMultiFormatReader(undefined, {
    delayBetweenScanAttempts: 100,
    delayBetweenScanSuccess: 500,
  })
  let controls = null

  return {
    async start({ stream, video, onResult, onError }) {
      controls = await reader.decodeFromStream(stream, video, (result, error) => {
        if (result) {
          onResult(result.getText())
          return
        }
        if (error && !ROUTINE_DECODE_ERRORS.has(error.name)) onError(error)
      })
      return controls
    },
    stop() {
      controls?.stop?.()
      controls = null
    },
  }
}

import { useEffect, useRef, useState } from 'react'
import { io } from 'socket.io-client'
import './App.css'

const PALETTE = [
  '#101418',
  '#ffffff',
  '#f97316',
  '#facc15',
  '#22c55e',
  '#0f766e',
  '#06b6d4',
  '#2563eb',
  '#7c3aed',
  '#be123c',
  '#ec4899',
  '#7c2d12',
]
const BRUSHES = [4, 8, 12, 18]
const DEFAULT_ROUNDS = 6
const ROUND_OPTIONS = [2, 3, 4, 5, 6, 8, 10]
const MOBILE_MEDIA_QUERY = '(max-width: 720px)'

const TOOLBAR_SECTION_OPTIONS = [
  { key: 'tools', label: '도구' },
  { key: 'colors', label: '색상' },
  { key: 'sizes', label: '굵기' },
]
const LEAVE_GUARD_MESSAGE = '지금 나가면 현재 방에서 연결이 끊깁니다. 정말 나가시겠습니까?'
const LEAVE_GUARD_HASH = '#catchbutter-leave-guard'

function createRoomCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase()
}

function syncViewportMetrics() {
  const viewport = window.visualViewport
  const viewportHeight = Math.round(viewport?.height || window.innerHeight)
  const viewportTop = Math.max(0, Math.round(viewport?.offsetTop || 0))

  document.documentElement.style.setProperty('--app-visible-height', `${viewportHeight}px`)
  document.documentElement.style.setProperty('--app-viewport-top', `${viewportTop}px`)
}

const initialRoomCode = (() => {
  const roomFromQuery = new URLSearchParams(window.location.search).get('room')
  return roomFromQuery?.toUpperCase().slice(0, 6) || createRoomCode()
})()

const emptyGame = {
  meId: '',
  roomCode: '',
  phase: 'lobby',
  round: 0,
  maxRounds: DEFAULT_ROUNDS,
  timeLeft: 0,
  answer: '게임 대기 중',
  wordChoices: [],
  resultText: '방에 입장해 게임을 시작하세요.',
  drawerId: null,
  drawerName: '대기 중',
  isHost: false,
  canStart: false,
  hasGuessedCorrectly: false,
  guessedCount: 0,
  canVoteSkip: false,
  canFinishRound: false,
  hasSkipVoted: false,
  skipVotesCount: 0,
  skipVotesNeeded: 0,
  players: [],
  messages: [],
}

function getServerUrl() {
  const configuredUrl = import.meta.env.VITE_SERVER_URL?.trim()

  if (configuredUrl) {
    return configuredUrl
  }

  if (import.meta.env.DEV) {
    return `${window.location.protocol}//${window.location.hostname}:3001`
  }

  return undefined
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function buildRoomLocation(roomCode, withGuardHash = false) {
  const search = roomCode ? `?room=${roomCode}` : ''
  const hash = withGuardHash ? LEAVE_GUARD_HASH : ''
  return `${window.location.pathname}${search}${hash}`
}

async function copyText(value) {
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value)
    return true
  }

  const input = document.createElement('textarea')
  input.value = value
  input.setAttribute('readonly', '')
  input.style.position = 'fixed'
  input.style.opacity = '0'
  input.style.pointerEvents = 'none'
  document.body.append(input)

  try {
    input.focus()
    input.select()
    input.setSelectionRange(0, input.value.length)
    return document.execCommand('copy')
  } finally {
    input.remove()
  }
}

function getPhaseLabel(phase) {
  if (phase === 'choosing') {
    return '단어 선택'
  }

  if (phase === 'drawing') {
    return '진행 중'
  }

  if (phase === 'round-end') {
    return '정답 공개'
  }

  return '로비'
}

function getResultTone(game) {
  if (isCorrectRoundEnd(game)) {
    return 'correct'
  }

  if (game.phase === 'round-end') {
    return 'round-end'
  }

  return 'default'
}

function isCorrectRoundEnd(game) {
  return game.phase === 'round-end' && game.resultText.includes('정답!')
}

function hexToRgba(hexColor) {
  const value = String(hexColor || '').replace('#', '').trim()

  if (value.length !== 6) {
    return null
  }

  return {
    r: Number.parseInt(value.slice(0, 2), 16),
    g: Number.parseInt(value.slice(2, 4), 16),
    b: Number.parseInt(value.slice(4, 6), 16),
    a: 255,
  }
}

function rgbaMatches(data, index, rgba, tolerance = 8) {
  return (
    Math.abs(data[index] - rgba.r) <= tolerance &&
    Math.abs(data[index + 1] - rgba.g) <= tolerance &&
    Math.abs(data[index + 2] - rgba.b) <= tolerance &&
    Math.abs(data[index + 3] - rgba.a) <= tolerance
  )
}

function clearCanvasElement(canvas) {
  if (!canvas) {
    return
  }

  const context = canvas.getContext('2d')
  context.save()
  context.setTransform(1, 0, 0, 1, 0, 0)
  context.clearRect(0, 0, canvas.width, canvas.height)
  context.restore()
}

function floodFillCanvas(canvas, action) {
  if (!canvas || !action?.point) {
    return
  }

  const context = canvas.getContext('2d', { willReadFrequently: true })
  const fillColor = hexToRgba(action.color)

  if (!fillColor) {
    return
  }

  const startX = Math.min(canvas.width - 1, Math.max(0, Math.floor(action.point.x * canvas.width)))
  const startY = Math.min(canvas.height - 1, Math.max(0, Math.floor(action.point.y * canvas.height)))
  const imageData = context.getImageData(0, 0, canvas.width, canvas.height)
  const { data, width, height } = imageData
  const startIndex = (startY * width + startX) * 4
  const targetColor = {
    r: data[startIndex],
    g: data[startIndex + 1],
    b: data[startIndex + 2],
    a: data[startIndex + 3],
  }

  if (rgbaMatches(data, startIndex, fillColor, 0)) {
    return
  }

  const stack = [[startX, startY]]

  while (stack.length) {
    const nextPoint = stack.pop()

    if (!nextPoint) {
      continue
    }

    const [x, y] = nextPoint

    if (x < 0 || x >= width || y < 0 || y >= height) {
      continue
    }

    const pixelIndex = (y * width + x) * 4

    if (!rgbaMatches(data, pixelIndex, targetColor)) {
      continue
    }

    data[pixelIndex] = fillColor.r
    data[pixelIndex + 1] = fillColor.g
    data[pixelIndex + 2] = fillColor.b
    data[pixelIndex + 3] = fillColor.a

    stack.push([x + 1, y])
    stack.push([x - 1, y])
    stack.push([x, y + 1])
    stack.push([x, y - 1])
  }

  context.putImageData(imageData, 0, 0)
}

function drawStrokeOnCanvas(canvas, segment) {
  if (!canvas) {
    return
  }

  const context = canvas.getContext('2d')
  const width = canvas.clientWidth
  const height = canvas.clientHeight

  context.save()
  context.lineCap = 'round'
  context.lineJoin = 'round'
  context.lineWidth = segment.size
  context.globalCompositeOperation = segment.mode === 'erase' ? 'destination-out' : 'source-over'
  context.strokeStyle = segment.mode === 'erase' ? 'rgba(0,0,0,1)' : segment.color
  context.beginPath()
  context.moveTo(segment.from.x * width, segment.from.y * height)
  context.lineTo(segment.to.x * width, segment.to.y * height)
  context.stroke()
  context.restore()
}

function applyCanvasActionToCanvas(canvas, segment) {
  if (segment?.kind === 'fill') {
    floodFillCanvas(canvas, segment)
    return
  }

  drawStrokeOnCanvas(canvas, segment)
}

function repaintCanvasElement(canvas, segments) {
  clearCanvasElement(canvas)
  segments.forEach((segment) => applyCanvasActionToCanvas(canvas, segment))
}

function App() {
  const [nickname, setNickname] = useState('')
  const [roomCode, setRoomCode] = useState(initialRoomCode)
  const [draftMessage, setDraftMessage] = useState('')
  const [game, setGame] = useState(emptyGame)
  const [joinError, setJoinError] = useState('')
  const [connectionLabel, setConnectionLabel] = useState('오프라인')
  const [brushColor, setBrushColor] = useState(PALETTE[0])
  const [brushSize, setBrushSize] = useState(BRUSHES[1])
  const [toolMode, setToolMode] = useState('draw')
  const [copied, setCopied] = useState(false)
  const [shareFeedback, setShareFeedback] = useState('')
  const [roundUpdatePending, setRoundUpdatePending] = useState(null)
  const [roundUpdateMessage, setRoundUpdateMessage] = useState('')
  const [activeToolbarSection, setActiveToolbarSection] = useState('tools')
  const [isCompactLayout, setIsCompactLayout] = useState(() => window.matchMedia(MOBILE_MEDIA_QUERY).matches)

  const socketRef = useRef(null)
  const boardCardRef = useRef(null)
  const stageRef = useRef(null)
  const canvasRef = useRef(null)
  const chatCardRef = useRef(null)
  const chatInputRef = useRef(null)
  const messagesRef = useRef(null)
  const drawingRef = useRef(false)
  const previousPointRef = useRef(null)
  const segmentsRef = useRef([])
  const pendingRoundRef = useRef(null)
  const shareResetTimeoutRef = useRef(null)
  const leavingRoomRef = useRef(false)

  const joined = Boolean(game.roomCode)
  const canDraw = joined && game.phase === 'drawing' && game.drawerId === game.meId
  const canChooseWord = joined && game.phase === 'choosing' && game.drawerId === game.meId
  const resultTone = getResultTone(game)
  const timerLabel = game.phase === 'drawing' ? '무제한' : `${game.timeLeft}s`
  const shareUrl = game.roomCode
    ? `${window.location.origin}${window.location.pathname}?room=${game.roomCode}`
    : `${window.location.origin}${window.location.pathname}`

  useEffect(() => {
    syncViewportMetrics()

    const mediaQuery = window.matchMedia(MOBILE_MEDIA_QUERY)
    const handleMediaChange = (event) => {
      setIsCompactLayout(event.matches)
    }
    const handleViewportChange = () => {
      syncViewportMetrics()
    }

    setIsCompactLayout(mediaQuery.matches)
    if (mediaQuery.addEventListener) {
      mediaQuery.addEventListener('change', handleMediaChange)
    } else {
      mediaQuery.addListener(handleMediaChange)
    }
    window.addEventListener('resize', handleViewportChange)
    window.visualViewport?.addEventListener('resize', handleViewportChange)
    window.visualViewport?.addEventListener('scroll', handleViewportChange)

    return () => {
      if (mediaQuery.removeEventListener) {
        mediaQuery.removeEventListener('change', handleMediaChange)
      } else {
        mediaQuery.removeListener(handleMediaChange)
      }
      window.removeEventListener('resize', handleViewportChange)
      window.visualViewport?.removeEventListener('resize', handleViewportChange)
      window.visualViewport?.removeEventListener('scroll', handleViewportChange)

      if (shareResetTimeoutRef.current) {
        window.clearTimeout(shareResetTimeoutRef.current)
      }

      socketRef.current?.disconnect()
    }
  }, [])

  useEffect(() => {
    if (!joined) {
      leavingRoomRef.current = false
      setActiveToolbarSection('tools')
    }
  }, [joined])

  function leaveCurrentRoom() {
    socketRef.current?.disconnect()
    socketRef.current = null
    segmentsRef.current = []
    drawingRef.current = false
    previousPointRef.current = null
    setDraftMessage('')
    setJoinError('')
    setConnectionLabel('오프라인')
    setCopied(false)
    setShareFeedback('')
    setRoundUpdatePending(null)
    setRoundUpdateMessage('')
    pendingRoundRef.current = null
    setGame(emptyGame)
    window.history.replaceState({}, '', buildRoomLocation(''))
  }

  useEffect(() => {
    if (!joined) {
      return undefined
    }

    leavingRoomRef.current = false

    const pushGuardState = () => {
      window.history.pushState(
        {
          ...(window.history.state || {}),
          catchButterGuard: true,
        },
        '',
        buildRoomLocation(game.roomCode, true),
      )
    }

    if (window.location.hash !== LEAVE_GUARD_HASH) {
      pushGuardState()
    }

    const handleBeforeUnload = (event) => {
      event.preventDefault()
      event.returnValue = ''
    }

    const handleHashChange = () => {
      if (leavingRoomRef.current || window.location.hash === LEAVE_GUARD_HASH) {
        return
      }

      const shouldLeave = window.confirm(LEAVE_GUARD_MESSAGE)

      if (!shouldLeave) {
        pushGuardState()
        return
      }

      leavingRoomRef.current = true
      leaveCurrentRoom()
    }

    window.addEventListener('beforeunload', handleBeforeUnload)
    window.addEventListener('hashchange', handleHashChange)

    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload)
      window.removeEventListener('hashchange', handleHashChange)
    }
  }, [joined, game.roomCode])

  useEffect(() => {
    if (!game.messages.length || !messagesRef.current) {
      return
    }

    messagesRef.current.scrollTop = messagesRef.current.scrollHeight
  }, [game.messages])

  useEffect(() => {
    if (!joined) {
      return undefined
    }

    const syncCanvas = () => {
      const canvas = canvasRef.current
      const stage = stageRef.current

      if (!canvas || !stage) {
        return
      }

      const ratio = window.devicePixelRatio || 1
      const width = stage.clientWidth
      const height = stage.clientHeight
      const context = canvas.getContext('2d')

      canvas.width = Math.floor(width * ratio)
      canvas.height = Math.floor(height * ratio)
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
      context.setTransform(ratio, 0, 0, ratio, 0, 0)
      context.save()
      context.setTransform(1, 0, 0, 1, 0, 0)
      context.clearRect(0, 0, canvas.width, canvas.height)
      context.restore()
      repaintCanvasElement(canvas, segmentsRef.current)
    }

    const observer = new ResizeObserver(() => {
      syncCanvas()
    })

    if (stageRef.current) {
      observer.observe(stageRef.current)
    }

    syncCanvas()

    return () => observer.disconnect()
  }, [joined])

  function attachSocket(socket) {
    socket.on('connect', () => {
      setConnectionLabel('연결됨')
      setJoinError('')
    })

    socket.on('disconnect', () => {
      setConnectionLabel('연결 끊김')
    })

    socket.on('connect_error', () => {
      setConnectionLabel('연결 실패')
      setJoinError('서버에 연결할 수 없습니다. 로컬 서버를 먼저 실행해 주세요.')
    })

    socket.on('joinError', (message) => {
      setJoinError(message)
    })

    socket.on('roomState', (nextState) => {
      setGame(nextState)
      setJoinError('')

      if (pendingRoundRef.current !== null && nextState.maxRounds === pendingRoundRef.current) {
        setRoundUpdatePending(null)
        setRoundUpdateMessage(`총 ${nextState.maxRounds}라운드로 적용됐습니다.`)
        pendingRoundRef.current = null
      }

      window.history.replaceState(
        { ...(window.history.state || {}) },
        '',
        buildRoomLocation(nextState.roomCode, window.location.hash === LEAVE_GUARD_HASH),
      )
    })

    socket.on('canvasState', (segments) => {
      segmentsRef.current = Array.isArray(segments) ? segments : []
      repaintCanvasElement(canvasRef.current, segmentsRef.current)
    })

    socket.on('canvasAction', (segment) => {
      segmentsRef.current.push(segment)
      applyCanvasActionToCanvas(canvasRef.current, segment)
    })
  }

  function connectAndJoin(event) {
    event.preventDefault()

    const cleanNickname = nickname.trim()
    const cleanRoomCode = roomCode.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6)

    if (!cleanNickname) {
      setJoinError('닉네임을 입력해 주세요.')
      return
    }

    if (!cleanRoomCode) {
      setJoinError('방 코드를 확인해 주세요.')
      return
    }

    socketRef.current?.disconnect()
    segmentsRef.current = []
    setCopied(false)
    setShareFeedback('')
    setRoundUpdatePending(null)
    setRoundUpdateMessage('')
    pendingRoundRef.current = null
    setGame(emptyGame)

    const socket = io(getServerUrl(), {
      transports: ['websocket', 'polling'],
    })

    socketRef.current = socket
    attachSocket(socket)
    socket.emit('joinRoom', {
      nickname: cleanNickname,
      roomCode: cleanRoomCode,
    })
  }

  async function handleShare() {
    setShareFeedback('')

    try {
      const copiedToClipboard = await copyText(shareUrl)

      if (!copiedToClipboard) {
        throw new Error('copy-failed')
      }

      setCopied(true)
      if (shareResetTimeoutRef.current) {
        window.clearTimeout(shareResetTimeoutRef.current)
      }

      shareResetTimeoutRef.current = window.setTimeout(() => {
        setCopied(false)
        shareResetTimeoutRef.current = null
      }, 1600)
      return
    } catch {
      setCopied(false)
      setShareFeedback('자동 복사가 막혀서 수동 복사 창을 열었습니다.')
      window.prompt('초대 링크를 복사해 주세요.', shareUrl)
    }
  }

  function handleMessageSubmit(event) {
    event.preventDefault()

    if (!draftMessage.trim()) {
      return
    }

    socketRef.current?.emit('sendMessage', draftMessage)
    setDraftMessage('')
  }

  function appendCanvasAction(segment) {
    segmentsRef.current.push(segment)
    applyCanvasActionToCanvas(canvasRef.current, segment)
    socketRef.current?.emit('canvasAction', segment)
  }

  function handleRoundChange(nextRound) {
    if (!game.isHost || game.phase !== 'lobby') {
      return
    }

    if (roundUpdatePending === nextRound || game.maxRounds === nextRound) {
      return
    }

    setRoundUpdateMessage('')
    setRoundUpdatePending(nextRound)
    pendingRoundRef.current = nextRound

    socketRef.current?.emit('setMaxRounds', nextRound, (response) => {
      if (response?.ok) {
        return
      }

      setRoundUpdatePending(null)
      pendingRoundRef.current = null
      setRoundUpdateMessage(response?.message || '라운드 수를 변경하지 못했습니다.')
    })
  }

  function buildPoint(event) {
    const canvas = canvasRef.current
    const rect = canvas.getBoundingClientRect()

    return {
      x: clamp((event.clientX - rect.left) / rect.width, 0, 1),
      y: clamp((event.clientY - rect.top) / rect.height, 0, 1),
    }
  }

  function handlePointerDown(event) {
    if (!canDraw) {
      return
    }

    event.preventDefault()

    if (toolMode === 'fill') {
      const segment = {
        kind: 'fill',
        point: buildPoint(event),
        color: brushColor,
      }

      appendCanvasAction(segment)
      return
    }

    drawingRef.current = true
    previousPointRef.current = buildPoint(event)
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function handlePointerMove(event) {
    if (!drawingRef.current || !canDraw) {
      return
    }

    event.preventDefault()

    const nextPoint = buildPoint(event)
    const previousPoint = previousPointRef.current

    if (!previousPoint || (previousPoint.x === nextPoint.x && previousPoint.y === nextPoint.y)) {
      return
    }

    const segment = {
      kind: 'stroke',
      from: previousPoint,
      to: nextPoint,
      color: brushColor,
      size: brushSize,
      mode: toolMode,
    }

    appendCanvasAction(segment)
    previousPointRef.current = nextPoint
  }

  function handlePointerUp(event) {
    if (drawingRef.current) {
      drawingRef.current = false
      previousPointRef.current = null

      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
    }
  }

  function scrollToSection(target) {
    if (!isCompactLayout) {
      return
    }

    const targetRef = target === 'chat' ? chatCardRef.current : boardCardRef.current
    targetRef?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  function focusChatInput() {
    window.setTimeout(() => {
      chatInputRef.current?.focus()
    }, 180)
  }

  function handleChatJump() {
    scrollToSection('chat')
    focusChatInput()
  }

  function handleBoardJump() {
    scrollToSection('board')
  }

  function handleSkipVoteToggle() {
    if (!game.canVoteSkip) {
      return
    }

    socketRef.current?.emit('setSkipVote', !game.hasSkipVoted)
  }

  function handleDrawerFinishRound() {
    if (!game.canFinishRound) {
      return
    }

    socketRef.current?.emit('finishRound')
  }

  return (
    <main className="app-shell">
      <section className="hero-panel">
        <div>
          <p className="eyebrow">Guild Drawing Party</p>
          <h1>CatchButter</h1>
          <p className="hero-copy">
            오늘 2시간 정도 가볍게 놀기 좋은, 모바일 우선 실시간 그림 맞히기 프로토타입입니다.
          </p>
        </div>

        {!joined ? (
          <form className="join-panel" onSubmit={connectAndJoin}>
            <label>
              닉네임
              <input
                value={nickname}
                onChange={(event) => setNickname(event.target.value)}
                placeholder="길드 닉네임"
                maxLength={14}
              />
            </label>
            <label>
              방 코드
              <div className="room-code-row">
                <input
                  value={roomCode}
                  onChange={(event) => setRoomCode(event.target.value.toUpperCase())}
                  placeholder="ABC123"
                  maxLength={6}
                />
                <button
                  type="button"
                  className="ghost-button"
                  onClick={() => setRoomCode(createRoomCode())}
                >
                  새 코드
                </button>
              </div>
            </label>

            <button type="submit" className="primary-button">
              방 입장
            </button>
            <p className="muted-line">상태: {connectionLabel}</p>
            {joinError ? <p className="error-line">{joinError}</p> : null}
          </form>
        ) : (
          <div className="room-summary">
            <div>
              <span className="summary-label">Room</span>
              <strong>{game.roomCode}</strong>
            </div>
            <div>
              <span className="summary-label">Status</span>
              <strong>{getPhaseLabel(game.phase)}</strong>
            </div>
            <div>
              <span className="summary-label">Timer</span>
              <strong>{timerLabel}</strong>
            </div>
            <button type="button" className="ghost-button" onClick={handleShare}>
              {copied ? '링크 복사됨' : '초대 링크 복사'}
            </button>
            {shareFeedback ? <p className="muted-line share-feedback-line">{shareFeedback}</p> : null}
          </div>
        )}
      </section>

      {joined ? (
        <section className="game-grid">
          <article className="board-card" ref={boardCardRef}>
            <header className="board-header">
              <div>
                <p className="eyebrow">Round {game.round || 0} / {game.maxRounds}</p>
                <h2>{game.answer || '준비 중'}</h2>
              </div>
              <div className="pill-group">
                <span className="status-pill">{game.drawerName} 차례</span>
              </div>
            </header>

            <div className={`result-banner ${resultTone}`}>
              <strong>{isCorrectRoundEnd(game) ? '정답 맞힘' : '안내'}</strong>
              <span>{game.resultText}</span>
            </div>

            {game.phase === 'drawing' ? (
              <div className="round-action-row">
                <p className="muted-line round-status-line">
                  {game.guessedCount > 0 ? `정답 ${game.guessedCount}명` : '아직 정답자가 없습니다.'}
                  {game.skipVotesNeeded > 0 ? ` · 넘기기 ${game.skipVotesCount}/${game.skipVotesNeeded}` : ''}
                  {game.guessedCount >= game.skipVotesNeeded && game.skipVotesNeeded > 0 ? ' · 모두 맞혀서 자동 진행됩니다.' : ''}
                </p>
                {game.canFinishRound ? (
                  <button
                    type="button"
                    className="primary-button skip-vote-button"
                    onClick={handleDrawerFinishRound}
                  >
                    다음 라운드로 넘기기
                  </button>
                ) : null}
                {game.canVoteSkip ? (
                  <button
                    type="button"
                    className={game.hasSkipVoted ? 'ghost-button skip-vote-button active' : 'ghost-button skip-vote-button'}
                    onClick={handleSkipVoteToggle}
                  >
                    {game.hasSkipVoted ? '넘기기 취소' : '넘기기'}
                  </button>
                ) : null}
              </div>
            ) : null}

            {canChooseWord ? (
              <div className="word-choice-card">
                <div className="tool-row compact">
                  <span className="tool-label">이번 라운드 제시어</span>
                  <span className="tool-hint">15초 안에 하나를 선택하세요</span>
                </div>
                <div className="word-choice-grid">
                  {game.wordChoices.map((wordChoice) => (
                    <button
                      key={wordChoice}
                      type="button"
                      className="word-choice-button"
                      onClick={() => socketRef.current?.emit('chooseWord', wordChoice)}
                    >
                      {wordChoice}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            <div className="canvas-stage" ref={stageRef}>
              <canvas
                ref={canvasRef}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerLeave={handlePointerUp}
                onPointerCancel={handlePointerUp}
              />
            </div>

            {isCompactLayout ? (
              <div className="mobile-board-shortcut">
                <button type="button" className="ghost-button" onClick={handleChatJump}>
                  채팅으로 바로 이동
                </button>
                <p className="muted-line">채팅은 항상 열려 있고, 누르면 입력창까지 바로 내려갑니다.</p>
              </div>
            ) : null}

            <div className={isCompactLayout ? 'toolbar-card compact-toolbar' : 'toolbar-card'}>
              <div className="toolbar-header-strip">
                <div className="tool-row compact">
                  <span className="tool-label">출제 도구</span>
                  <span className="tool-hint">{canDraw ? '하단에서 빠르게 전환' : '출제자 턴에만 활성화'}</span>
                </div>
                <div className="toolbar-toggle-row">
                  {TOOLBAR_SECTION_OPTIONS.map((section) => (
                    <button
                      key={section.key}
                      type="button"
                      className={activeToolbarSection === section.key ? 'size-chip active' : 'size-chip'}
                      onClick={() => setActiveToolbarSection(section.key)}
                    >
                      {section.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className={activeToolbarSection === 'tools' ? 'toolbar-section active' : 'toolbar-section'}>
                <div className="tool-row compact">
                  <span className="tool-label">도구</span>
                  <span className="tool-hint">출제자만 사용 가능</span>
                </div>
                <div className="tool-chip-grid">
                  <button
                    type="button"
                    className={toolMode === 'draw' ? 'tool-button active' : 'tool-button'}
                    onClick={() => setToolMode('draw')}
                    disabled={!canDraw}
                  >
                    펜
                  </button>
                  <button
                    type="button"
                    className={toolMode === 'fill' ? 'tool-button active' : 'tool-button'}
                    onClick={() => setToolMode('fill')}
                    disabled={!canDraw}
                  >
                    채우기
                  </button>
                  <button
                    type="button"
                    className={toolMode === 'erase' ? 'tool-button active' : 'tool-button'}
                    onClick={() => setToolMode('erase')}
                    disabled={!canDraw}
                  >
                    지우개
                  </button>
                  <button
                    type="button"
                    className="tool-button"
                    onClick={() => socketRef.current?.emit('clearCanvas')}
                    disabled={!canDraw}
                  >
                    전체 지우기
                  </button>
                </div>
              </div>

              <div className={activeToolbarSection === 'colors' ? 'toolbar-section active' : 'toolbar-section'}>
                <div className="tool-row compact">
                  <span className="tool-label">색상</span>
                  <span className="tool-hint">{PALETTE.length}가지</span>
                </div>
                <div className="palette-grid">
                  {PALETTE.map((color) => (
                    <button
                      key={color}
                      type="button"
                      className={brushColor === color ? 'color-chip active' : 'color-chip'}
                      style={{ backgroundColor: color }}
                      onClick={() => setBrushColor(color)}
                      disabled={!canDraw}
                      aria-label={`색상 ${color}`}
                    />
                  ))}
                </div>
              </div>

              <div className={activeToolbarSection === 'sizes' ? 'toolbar-section active' : 'toolbar-section'}>
                <div className="tool-row compact">
                  <span className="tool-label">굵기</span>
                  <span className="tool-hint">현재 {brushSize}px</span>
                </div>
                <div className="size-grid">
                  {BRUSHES.map((size) => (
                    <button
                      key={size}
                      type="button"
                      className={brushSize === size ? 'size-chip active' : 'size-chip'}
                      onClick={() => setBrushSize(size)}
                      disabled={!canDraw}
                    >
                      {size}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </article>

          {isCompactLayout && game.phase === 'lobby' ? (
            <article className="panel-card mobile-lobby-card">
              <div className="panel-header">
                <h3>게임 준비</h3>
                <span className="muted-line">{game.players.length}명 참가 중</span>
              </div>

              {game.isHost ? (
                <>
                  <div className="host-controls-card">
                    <div className="tool-row compact">
                      <span className="tool-label">호스트 컨트롤</span>
                      <span className="tool-hint">플레이어 2명 이상부터 시작 가능</span>
                    </div>
                    <button
                      type="button"
                      className="primary-button"
                      onClick={() => socketRef.current?.emit('startGame')}
                      disabled={!game.canStart}
                    >
                      게임 시작
                    </button>
                    <p className="muted-line">
                      {game.canStart
                        ? '준비가 끝났습니다. 누르면 바로 첫 라운드가 시작됩니다.'
                        : '최소 2명이 모이면 게임을 시작할 수 있습니다.'}
                    </p>
                  </div>

                  <div className="round-config-card">
                    <div className="tool-row compact">
                      <span className="tool-label">총 라운드 수</span>
                      <span className="tool-hint">시작 전 호스트만 변경 가능</span>
                    </div>
                    <div className="round-option-grid">
                      {ROUND_OPTIONS.map((roundOption) => (
                        <button
                          key={roundOption}
                          type="button"
                          className={game.maxRounds === roundOption ? 'size-chip active' : 'size-chip'}
                          onClick={() => handleRoundChange(roundOption)}
                          disabled={roundUpdatePending === roundOption}
                        >
                          {roundUpdatePending === roundOption ? '적용 중' : `${roundOption}R`}
                        </button>
                      ))}
                    </div>
                    <p className="muted-line round-feedback-line">
                      {roundUpdateMessage || `현재 ${game.maxRounds}라운드`}
                    </p>
                  </div>
                </>
              ) : (
                <div className="player-status-card">
                  <span className="tool-label">대기 중</span>
                  <p className="muted-line">호스트가 라운드 수를 정하고 게임을 시작하면 바로 입장합니다.</p>
                </div>
              )}
            </article>
          ) : null}

          <article className={isCompactLayout ? 'panel-card chat-card mobile-chat-card' : 'panel-card chat-card'} ref={chatCardRef}>
            <div className="panel-header">
              <div className="chat-header-copy">
                <h3>채팅 / 정답</h3>
                <span className="muted-line">{connectionLabel}</span>
              </div>
              {isCompactLayout ? (
                <button type="button" className="ghost-button chat-nav-button" onClick={handleBoardJump}>
                  그림으로 복귀
                </button>
              ) : null}
            </div>

            <div className="message-list" ref={messagesRef}>
              {game.messages.map((message) => (
                <div key={message.id} className={`message-bubble ${message.type}`}>
                  <strong>{message.sender}</strong>
                  <p>{message.text}</p>
                </div>
              ))}
            </div>

            <form className="chat-form" onSubmit={handleMessageSubmit}>
              <input
                ref={chatInputRef}
                value={draftMessage}
                onChange={(event) => setDraftMessage(event.target.value)}
                placeholder={canDraw ? '채팅으로 힌트를 주지는 마세요' : game.hasGuessedCorrectly ? '정답을 맞혔습니다. 필요하면 넘기기를 눌러 주세요' : '정답 또는 채팅 입력'}
                maxLength={80}
              />
              <button type="submit" className="primary-button">
                전송
              </button>
            </form>
          </article>

          {!isCompactLayout ? (
          <article className="panel-card player-card">
            <div className="panel-header">
              <h3>플레이어</h3>
              <span className="muted-line">{game.players.length}명 참가 중</span>
            </div>

            {game.isHost && game.phase === 'lobby' ? (
              <div className="host-controls-card">
                <div className="tool-row compact">
                  <span className="tool-label">호스트 컨트롤</span>
                  <span className="tool-hint">플레이어 2명 이상부터 시작 가능</span>
                </div>
                <button
                  type="button"
                  className="primary-button"
                  onClick={() => socketRef.current?.emit('startGame')}
                  disabled={!game.canStart}
                >
                  게임 시작
                </button>
                <p className="muted-line">
                  {game.canStart
                    ? '준비가 끝났습니다. 누르면 바로 첫 라운드가 시작됩니다.'
                    : '최소 2명이 모이면 게임을 시작할 수 있습니다.'}
                </p>
              </div>
            ) : null}

            {game.isHost && game.phase === 'lobby' ? (
              <div className="round-config-card">
                <div className="tool-row compact">
                  <span className="tool-label">총 라운드 수</span>
                  <span className="tool-hint">시작 전 호스트만 변경 가능</span>
                </div>
                <div className="round-option-grid">
                  {ROUND_OPTIONS.map((roundOption) => (
                    <button
                      key={roundOption}
                      type="button"
                      className={game.maxRounds === roundOption ? 'size-chip active' : 'size-chip'}
                      onClick={() => handleRoundChange(roundOption)}
                      disabled={roundUpdatePending === roundOption}
                    >
                      {roundUpdatePending === roundOption ? '적용 중' : `${roundOption}R`}
                    </button>
                  ))}
                </div>
                <p className="muted-line round-feedback-line">
                  {roundUpdateMessage || `현재 ${game.maxRounds}라운드`}
                </p>
              </div>
            ) : null}

            {!game.isHost && game.phase === 'lobby' ? (
              <div className="player-status-card">
                <span className="tool-label">대기 중</span>
                <p className="muted-line">호스트가 라운드 수를 정하고 게임을 시작하면 바로 입장합니다.</p>
              </div>
            ) : null}

            <ul className="player-list">
              {game.players.map((player) => (
                <li key={player.id} className={player.isMe ? 'player-row self' : 'player-row'}>
                  <div>
                    <strong>{player.nickname}</strong>
                    <span>
                      {player.isHost ? '호스트' : '플레이어'}
                      {player.id === game.drawerId ? ' · 그리는 중' : ''}
                    </span>
                  </div>
                  <b>{player.score}</b>
                </li>
              ))}
            </ul>
          </article>
          ) : null}
        </section>
      ) : null}
    </main>
  )
}

export default App
